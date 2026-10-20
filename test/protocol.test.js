import test from 'node:test';
import assert from 'node:assert/strict';
import {
  xloaderMessage, xloaderCrc32, isiBuild, isiParse, parseConfigDescriptor, findPhonetInterface,
  SuClient, NoloClient, ColdFlash, classifyUsbId, parseRdFlags, rdFlagNames, imageHash, SuError, hex,
} from '../src/protocol.js';
import { buildFiasco, parseFiasco, pickImage, mergeFiascos, verifyImageHash } from '../src/fiasco.js';
import { Flasher } from '../src/flasher.js';
import { FakeSuServer, FakeNolo, FakeBootRom, FakeHost } from './fakes.js';

const rnd = (n, seed = 1) => { const a = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; a[i] = x >>> 24; } return a; };

test('X-Loader CRC and message layout', () => {
  assert.equal(xloaderCrc32(new TextEncoder().encode('123456789')), 771566984);
  const ping = xloaderMessage(0x6301);
  assert.equal(hex(ping.subarray(0, 4)), '6e 32 01 63');
  assert.equal(new DataView(ping.buffer).getUint32(12, true), 0x3b499b94);
  const m = xloaderMessage(0x6304, Uint8Array.of(1, 2, 3));
  const dv = new DataView(m.buffer);
  assert.equal(dv.getUint32(4, true), 3);
  assert.equal(dv.getUint32(8, true), xloaderCrc32(Uint8Array.of(1, 2, 3)));
});

test('ISI framing matches the 0xFFFF MKII constants', () => {
  const f = isiBuild({ trid: 7, id: 0x01, payload: Uint8Array.of(1, 2, 3) });
  assert.equal(new DataView(f.buffer).getUint32(0, true), 0x8810001b);
  assert.equal(new DataView(f.buffer).getUint16(4), 3 + 4);
  assert.equal(f[8], 7); assert.equal(f[9], 1);
  const p = isiParse(f);
  assert.deepEqual([...p.payload], [1, 2, 3]);
  assert.throws(() => isiParse(f.subarray(0, 8)));
});

test('image hash is XOR of LE words', () => {
  assert.equal(imageHash(Uint8Array.of(1, 0, 2, 0)), 3);
});

test('NOLO / bootrom / phonet USB ID classification', () => {
  assert.equal(classifyUsbId(0x421, 0x105), 'nolo');
  assert.equal(classifyUsbId(0x451, 0xd00e), 'bootrom');
  assert.equal(classifyUsbId(0x421, 0x106), 'bootrom');
  assert.equal(classifyUsbId(0x421, 0x51a), 'phonet-candidate');
  assert.equal(classifyUsbId(0x1234, 1), null);
});

function phonetConfig() {
  const d = (...b) => Uint8Array.from([b.length + 1, ...b]);
  const parts = [
    Uint8Array.of(9, 2, 0, 0, 2, 1, 0, 0x80, 50),
    d(4, 0, 0, 0, 2, 0xfe, 0, 0),          // comm iface 0, class 2 sub 0xfe
    d(0x24, 0xab, 0x05, 0x15),              // phonet header
    d(0x24, 0x00, 0x10, 0x01),              // CDC header, bcdCDC 1.10
    d(0x24, 0x06, 0x00, 0x01),              // union: master 0 slave 1
    d(4, 1, 0, 0, 0x0a, 0, 0, 0),           // data iface 1 alt 0 (no EPs)
    d(4, 1, 1, 2, 0x0a, 0, 0, 0),           // alt 1, two EPs
    Uint8Array.of(7, 5, 0x82, 2, 0, 2, 0),
    Uint8Array.of(7, 5, 0x03, 2, 0, 2, 0),
    d(4, 2, 0, 1, 0xff, 0, 0, 0),           // raw iface
    Uint8Array.of(7, 5, 0x04, 2, 0, 2, 0),
  ];
  // fix lengths (d() computes len incl. itself already)
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}

test('Phonet interface discovery from a raw config descriptor', () => {
  const ph = findPhonetInterface(parseConfigDescriptor(phonetConfig()));
  assert.ok(ph);
  assert.equal(ph.dataInterface, 1);
  assert.equal(ph.dataAlt, 1);
  assert.equal(ph.inEp, 2);
  assert.equal(ph.outEp, 3);
  assert.deepEqual(ph.rawOutEp, { iface: 2, alt: 0, address: 4 });
});

test('FIASCO round trip, product matching, 128-byte padding', () => {
  const kernel = rnd(1000, 1);
  const file = buildFiasco({
    swVersion: 'RM-696_TEST',
    images: [
      { type: 'kernel', data: kernel, version: '3.2', products: [{ product: 'RM-696', hwrevs: ['2101', '2102'] }] },
      { type: 'kernel', data: rnd(500, 2), version: '3.2', products: [{ product: 'RM-680', hwrevs: ['1000'] }] },
      { type: 'rootfs', data: rnd(2048, 3), layout: 'ubi' },
    ],
  });
  const f = parseFiasco(file);
  assert.equal(f.swVersion, 'RM-696_TEST');
  assert.equal(f.images.length, 3);
  assert.equal(f.images[0].paddedSize, 1024);
  assert.ok(f.images.every(verifyImageHash));
  assert.equal(pickImage(f, 'kernel', 'RM-696', '2102').size, 1000);
  assert.equal(pickImage(f, 'kernel', 'RM-680', '1000').size, 500);
  assert.equal(pickImage(f, 'kernel', 'RM-696', '9999'), null);
  assert.equal(f.images[2].emmc, true);
  assert.equal(f.images[1].blob[0], 0x2e);
  assert.throws(() => parseFiasco(Uint8Array.of(1, 2, 3)));
  const bad = file.slice(); bad[bad.length - 1] ^= 0xff;
  assert.equal(verifyImageHash(parseFiasco(bad).images[2]), false);
  assert.throws(() => mergeFiascos([{ file: 'a', fiasco: f }, { file: 'b', fiasco: f }]), /more than one versioned/);
});

test('R&D flag parsing', () => {
  assert.equal(parseRdFlags('no-omap-wd, serial-console'), 0x12);
  assert.deepEqual(rdFlagNames(0x12), ['no-omap-wd', 'serial-console']);
  assert.throws(() => parseRdFlags('bogus'));
});

test('SuClient init handshake and error mapping', async () => {
  const srv = new FakeSuServer({ protocol: 108 });
  const su = new SuClient(srv.transport());
  const info = await su.init();
  assert.equal(info.product, 'RM-696');
  assert.equal(info.protocol, 108);
  assert.equal(srv.params.get('/update/host_protocol_version'), '108');
  await assert.rejects(su.getParam('/nope'), (e) => e instanceof SuError && /error code 7/.test(e.message));

  const old = new SuClient(new FakeSuServer({ protocol: 100 }).transport());
  await assert.rejects(old.init(), /deprecated/);
  const newer = new SuClient(new FakeSuServer({ protocol: 120 }).transport());
  await assert.rejects(newer.init(), /more recent/);
});

test('SuClient times out and reports it', async () => {
  const su = new SuClient({ bulkOut: async () => {}, bulkIn: async () => null });
  await assert.rejects(su.request(0, new Uint8Array(0), { timeout: 20, min: 0, statusIdx: -1 }), (e) => e.timeout);
});

function sessionFor(srv, { raw = false } = {}) {
  return { mode: 'phonet', transport: srv.transport({ rawEp: raw ? 2 : 0 }), usb: { vid: 0x421, pid: 0x1234 },
    phonet: { inEp: 1, outEp: 1, rawOutEp: raw ? { iface: 2, alt: 0, address: 2 } : null } };
}

test('full SU flash: kernel (feed) + rootfs (raw pipe) + reboot', async () => {
  const kernel = rnd(70000, 5);
  const rootfs = rnd(300000, 6);
  const fiasco = mergeFiascos([{ file: 'x', fiasco: parseFiasco(buildFiasco({
    swVersion: 'RM-696_TEST',
    images: [
      { type: 'kernel', data: kernel, products: [{ product: 'RM-696', hwrevs: ['2101'] }] },
      { type: 'rootfs', data: rootfs, layout: 'x', products: [{ product: 'RM-696', hwrevs: ['2101'] }] },
      { type: 'cert-sw', data: rnd(300, 7) },
    ],
  })) }]);
  const srv = new FakeSuServer();
  const logs = [];
  const host = new FakeHost([sessionFor(srv, { raw: true })]);
  const fl = new Flasher(host, { log: (m) => logs.push(m) });
  await fl.flash(fiasco, new Set(fiasco.images.map((i) => i.index)), {});
  assert.equal(srv.images.length, 3);
  assert.deepEqual(srv.images.map((i) => i.type), ['cert-sw', 'kernel', 'rootfs']);
  const k = srv.imageBytes(1);
  assert.deepEqual(k.subarray(0, kernel.length), kernel);
  assert.ok(k.subarray(kernel.length).every((b) => b === 0));
  assert.equal(srv.images[2].raw, true);
  assert.deepEqual(new Uint8Array(srv.imageBytes(2).subarray(0, rootfs.length)), rootfs);
  assert.ok(srv.finished);
  assert.equal(srv.rebooted, 'reboot');
  assert.ok(srv.swRel && srv.swRel[0] === 0xe8);
  assert.equal(srv.params.get('/update/mmc/no_preserve'), '0');
  assert.equal(srv.params.get('/update/cmt/verify'), '1');
  assert.ok(logs.some((l) => /Success/.test(l)));
});

test('flash aborts on low battery and on server-reported failure', async () => {
  const fi = mergeFiascos([{ file: 'x', fiasco: parseFiasco(buildFiasco({ images: [{ type: 'kernel', data: rnd(4096, 9) }] })) }]);
  const low = new FakeSuServer({ battery: 5 });
  await assert.rejects(new Flasher(new FakeHost([sessionFor(low)])).flash(fi, new Set([0])), /BATTERY IS LOW/);
  assert.equal(low.images.length, 0);

  const bad = new FakeSuServer({ failImage: 'kernel' });
  const fl = new Flasher(new FakeHost([sessionFor(bad)]));
  await assert.rejects(fl.flash(fi, new Set([0])), /Update failed/);
  assert.ok(bad.cancelled);
});

test('NOLO identify and ape-algo boot path ends in SU flash', async () => {
  const nolo = new FakeNolo();
  const srv = new FakeSuServer();
  const fi = mergeFiascos([{ file: 'x', fiasco: parseFiasco(buildFiasco({
    images: [
      { type: 'ape-algo', data: rnd(2000, 11), products: [{ product: 'RM-696', hwrevs: ['2101'] }] },
      { type: 'kernel', data: rnd(5000, 12), products: [{ product: 'RM-696', hwrevs: ['2101'] }] },
    ],
  })) }]);
  const host = new FakeHost([
    { mode: 'nolo', transport: nolo.transport(), usb: { vid: 0x421, pid: 0x105 } },
    sessionFor(srv),
  ]);
  const logs = [];
  const fl = new Flasher(host, { log: (m) => logs.push(m) });
  await fl.flash(fi, new Set([1]), { reboot: false });
  assert.equal(nolo.sent.length, 1);
  assert.equal(nolo.sent[0].req, 0x42);
  assert.deepEqual(nolo.bulk[0].data, fi.images[0].data.subarray(0, 2000));
  assert.equal(nolo.bulk[0].ep, 2);
  assert.deepEqual(nolo.booted, { mode: 0, cmdline: ' ' });
  assert.deepEqual(srv.images.map((i) => i.type), ['kernel']);
  assert.ok(logs.some((l) => /Found device RM-696, hardware revision 2101/.test(l)));
  assert.ok(logs.some((l) => /NOLO version 0\.1\.43/.test(l)));
});

test('NOLO identify (-i) reports product, version, R&D state', async () => {
  const nolo = new FakeNolo();
  nolo.rd.flags = 0x12;
  const fl = new Flasher(new FakeHost([{ mode: 'nolo', transport: nolo.transport(), usb: { vid: 0x421, pid: 0x105 } }]));
  const info = await fl.identify();
  assert.equal(info.product, 'RM-696');
  assert.equal(info.hwRev, '2101');
  assert.deepEqual(info.rdFlags, ['no-omap-wd', 'serial-console']);
  assert.equal(info.swRelease, 'RM-696_TEST');
  await new NoloClient(nolo.transport()).setRdFlags(0x08);
  assert.equal(nolo.rd.flags, 0x08);
});

test('cold flash sequence', async () => {
  const rom = new FakeBootRom();
  const logs = [];
  const cf = new ColdFlash(rom.transport(), { log: (m) => logs.push(m) });
  const asic = await cf.run({ second: rnd(5000, 1), apeAlgo: rnd(70000, 2) });
  assert.equal(asic.chip, 'OMAP3630');
  assert.deepEqual([...rom.out[0]], [2, 0, 3, 0xf0]);
  assert.deepEqual(rom.msgs.map((m) => m.cmd.toString(16)), ['6301', '6304']);
  assert.equal(rom.msgs[1].size, 70000);
});

test('reboot over SU sends the 16-byte state-change string', async () => {
  const srv = new FakeSuServer();
  const fl = new Flasher(new FakeHost([sessionFor(srv)]));
  await fl.reboot();
  assert.equal(srv.rebooted, 'reboot');
  assert.ok(srv.seen.includes(0x0c));
});

test('real N9 (0421:051a, PC Suite mode) descriptor yields the Phonet interface', async () => {
  const { readFileSync } = await import('node:fs');
  const cfg = new Uint8Array(readFileSync(new URL('./fixtures/n9-051a-config.bin', import.meta.url)));
  const ph = findPhonetInterface(parseConfigDescriptor(cfg));
  assert.deepEqual({ ...ph }, { controlInterface: 1, dataInterface: 2, dataAlt: 1, inEp: 3, outEp: 2, rawOutEp: null });
});

test('plain images get a single file-data subblock; tar/gzip rootfs is refused', async () => {
  const { plainImage } = await import('../src/fiasco.js');
  const k = plainImage('kernel', rnd(1000, 3), 'zImage');
  assert.equal(k.blob.length, 2 + 0x19);
  assert.equal(k.blob[0], 0x2e);
  assert.equal(k.paddedSize, 1024);
  assert.equal(verifyImageHash(k), true);
  const roundTrip = parseFiasco(buildFiasco({ images: [{ type: 'kernel', data: k.data }] })).images[0];
  assert.deepEqual([...k.blob.subarray(5, 7)], [...roundTrip.blob.subarray(5, 7)]); // same hash bytes
  assert.throws(() => plainImage('rootfs', Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0)), /layout file/);
});

test('merge: one versioned FIASCO only; user images replace same-type FIASCO images', async () => {
  const { plainImage } = await import('../src/fiasco.js');
  const main = parseFiasco(buildFiasco({ swVersion: 'A', images: [{ type: 'kernel', data: rnd(300, 1) }, { type: 'rootfs', data: rnd(300, 2) }] }));
  const mmc = parseFiasco(buildFiasco({ swVersion: '', images: [{ type: 'mmc', data: rnd(300, 3) }] }));
  const other = parseFiasco(buildFiasco({ swVersion: 'B', images: [] }));
  const m = mergeFiascos([{ file: 'main.bin', fiasco: main }, { file: 'mmc.bin', fiasco: mmc }]);
  assert.deepEqual(m.images.map((i) => i.type), ['kernel', 'rootfs', 'mmc']);
  assert.equal(m.swVersion, 'A');
  assert.throws(() => mergeFiascos([{ file: 'a', fiasco: main }, { file: 'b', fiasco: other }]), /more than one versioned/);
  const m2 = mergeFiascos([{ file: 'main.bin', fiasco: main }], [plainImage('kernel', rnd(100, 9), 'my-zImage')]);
  assert.deepEqual(m2.images.map((i) => `${i.type}:${i.source}`), ['rootfs:main.bin', 'kernel:my-zImage']);
  assert.equal(m2.warnings.length, 1);
  assert.deepEqual(m2.images.map((i) => i.index), [0, 1]);
});

test('erase honours the method and runs before BEGIN_UPDATE', async () => {
  const fi = mergeFiascos([{ file: 'x', fiasco: parseFiasco(buildFiasco({ images: [{ type: 'kernel', data: rnd(4096, 9) }] })) }]);
  const srv = new FakeSuServer();
  await new Flasher(new FakeHost([sessionFor(srv)])).flash(fi, new Set([0]), { eraseMmc: 'quick', eraseUserData: true, reboot: false });
  assert.deepEqual(srv.erased, ['mmc=quick', 'userdata=secure']);
  assert.ok(srv.seen.indexOf(0x12) < srv.seen.indexOf(0x03));
});
