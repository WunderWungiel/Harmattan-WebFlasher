// Nokia N9 / N950 flashing protocol (see PROTOCOL.md).
//
// Pure logic: no DOM, no WebUSB. Everything talks to a `transport` object:
//
//   transport.controlOut(request, value, index, data?)   -> Promise<void>
//   transport.controlIn(request, value, index, length)   -> Promise<Uint8Array>
//   transport.bulkOut(endpoint, data)                    -> Promise<void>
//   transport.bulkIn(endpoint, maxLength, timeoutMs)     -> Promise<Uint8Array | null>  (null = timeout)
//
// All control transfers are vendor requests addressed to the device.
// Failures throw TransportError ({code: 'stall' | 'disconnected' | 'io'}).

export class TransportError extends Error {
  constructor(message, code = 'io') {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}

export class ProtocolError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProtocolError';
    Object.assign(this, details);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const enc = new TextEncoder();
const dec = new TextDecoder('latin1');
export const toBytes = (s) => enc.encode(s);
export const cstr = (u8) => {
  const z = u8.indexOf(0);
  return dec.decode(z < 0 ? u8 : u8.subarray(0, z));
};
const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const hex = (u8, sep = ' ') => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join(sep);

// ---------------------------------------------------------------- devices

export const NOKIA = 0x0421;
export const TI = 0x0451;

// PROTOCOL.md section 2.1 (dumped from the original binary).
export const USB_DEVICES = {
  nolo: [{ vid: NOKIA, pid: 0x0105, iface: 2, alt: 1 }],
  bootrom: [
    { vid: TI, pid: 0xd009, iface: 0, alt: 0 },
    { vid: TI, pid: 0xd00e, iface: 0, alt: 0 },
    { vid: NOKIA, pid: 0x0106, iface: 0, alt: 0 },
  ],
};
// Nokia PIDs for which the original sends an ADL reboot first.
export const SYNC_MODE_PIDS = [0x03d2, 0x051a];

export const USB_FILTERS = [
  { vendorId: NOKIA },
  { vendorId: TI, productId: 0xd009 },
  { vendorId: TI, productId: 0xd00e },
];

/** 'nolo' | 'bootrom' | 'phonet-candidate' | null, from IDs only. */
export function classifyUsbId(vid, pid) {
  for (const kind of ['nolo', 'bootrom']) {
    if (USB_DEVICES[kind].some((d) => d.vid === vid && d.pid === pid)) return kind;
  }
  if (vid === NOKIA) return 'phonet-candidate';
  return null;
}

// ------------------------------------------------- USB config descriptors

/**
 * Parse a raw configuration descriptor (as returned by GET_DESCRIPTOR) into
 * a flat list of interface alt settings with their CDC functional
 * descriptors and endpoints.
 */
export function parseConfigDescriptor(bytes) {
  const out = [];
  let cur = null;
  for (let p = 0; p + 2 <= bytes.length;) {
    const len = bytes[p];
    const type = bytes[p + 1];
    if (len < 2 || p + len > bytes.length) break;
    if (type === 4 && len >= 9) {
      cur = {
        number: bytes[p + 2], alt: bytes[p + 3], numEndpoints: bytes[p + 4],
        cls: bytes[p + 5], sub: bytes[p + 6], proto: bytes[p + 7],
        funcs: [], endpoints: [],
      };
      out.push(cur);
    } else if (type === 0x24 && cur && len >= 3) {
      cur.funcs.push({ subtype: bytes[p + 2], data: bytes.slice(p + 3, p + len) });
    } else if (type === 5 && cur && len >= 7) {
      cur.endpoints.push({
        address: bytes[p + 2], attributes: bytes[p + 3],
        maxPacket: bytes[p + 4] | (bytes[p + 5] << 8),
      });
    }
    p += len;
  }
  return out;
}

/**
 * Locate the Phonet ISI interface the way the original flasher does
 * (PROTOCOL.md 2.1). Returns null if the device isn't a Phonet device.
 * {controlInterface, dataInterface, dataAlt, inEp, outEp, rawOutEp}
 */
export function findPhonetInterface(ifaces) {
  for (const c of ifaces) {
    if (c.cls !== 0x02 || c.sub !== 0xfe) continue;
    const fn = (t) => c.funcs.find((f) => f.subtype === t);
    const hdr = fn(0xab);
    if (!hdr || hdr.data.length < 2 || hdr.data[0] !== 0x05 || hdr.data[1] !== 0x15) continue;
    // CDC Header functional descriptor: bcdCDC >= 1.10 (bytes 10 01 on the N9)
    const fh = fn(0x00);
    if (!fh || fh.data.length < 2 || fh.data[0] < 0x10 || fh.data[1] !== 0x01) continue;
    const un = fn(0x06);
    if (!un || un.data.length !== 2) continue;
    const dataNum = un.data[1];
    // alt setting of the data interface that has more than one endpoint
    const alt = ifaces.find((i) => i.number === dataNum && i.endpoints.length > 1);
    if (!alt) continue;
    const inEp = alt.endpoints.find((e) => e.address & 0x80);
    const outEp = alt.endpoints.find((e) => !(e.address & 0x80));
    if (!inEp || !outEp) continue;
    // optional raw data interface: vendor class 0xFF/0/0, bulk OUT
    let rawOutEp = null;
    for (const r of ifaces) {
      if (r.cls === 0xff && r.sub === 0 && r.proto === 0 && (r.endpoints.length === 1 || r.endpoints.length === 2)) {
        const e = r.endpoints.find((x) => (x.attributes & 3) === 2 && !(x.address & 0x80));
        if (e) { rawOutEp = { iface: r.number, alt: r.alt, address: e.address }; break; }
      }
    }
    return {
      controlInterface: c.number,
      dataInterface: dataNum,
      dataAlt: alt.alt,
      inEp: inEp.address & 0x0f,
      outEp: outEp.address & 0x0f,
      rawOutEp,
    };
  }
  return null;
}

// -------------------------------------------------------------- checksums

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** X-Loader CRC32: reflected 0xEDB88320, initial value 0, no final xor. */
export function xloaderCrc32(data, crc = 0) {
  for (let i = 0; i < data.length; i++) crc = ((crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

/** XOR of little-endian 16-bit words, as in 0xFFFF's image hash. */
export function imageHash(data) {
  let h = 0;
  const n = data.length & ~1;
  for (let i = 0; i < n; i += 2) h ^= data[i] | (data[i + 1] << 8);
  return h & 0xffff;
}

// ----------------------------------------------------------- cold flash

export const XLOADER = {
  MAGIC: 0x326e,
  PING: 0x6301,
  SEND_SECONDARY: 0x6302,
  SEND_APE_ALGO: 0x6304,
  HWID: 0x6305,
  OK: 0x6faa,
};
export const OMAP_PERIPHERAL_BOOT = Uint8Array.of(0x02, 0x00, 0x03, 0xf0);
export const OMAP_MEMORY_BOOT = Uint8Array.of(0, 0, 0, 0);

export function xloaderMessage(cmd, payload = null) {
  const m = new Uint8Array(16);
  const v = view(m);
  v.setUint16(0, XLOADER.MAGIC, true);
  v.setUint16(2, cmd, true);
  if (payload && payload.length) {
    v.setUint32(4, payload.length, true);
    v.setUint32(8, xloaderCrc32(payload), true);
  }
  v.setUint32(12, xloaderCrc32(m.subarray(0, 12)), true);
  return m;
}

export function parseAsicId(b) {
  if (b.length < 0x45) throw new ProtocolError(`ASIC ID too short (${b.length} bytes, need 69)`);
  const chipCode = hex(b.subarray(4, 7), '');
  const chip = { '343007': 'OMAP3430', '363007': 'OMAP3630' }[chipCode] ?? `unknown (${chipCode})`;
  const secureMagic = hex(b.subarray(8, 12), '');
  const zero20 = b.subarray(0x26, 0x3a).every((x) => x === 0);
  let secure = 'unknown';
  if (secureMagic === '13020101') secure = 'type 3';
  else if (secureMagic === '13020100') secure = zero20 ? 'unsigned (no root key)' : 'signed';
  return { chip, revision: b[7], secure, rootKeyHash: hex(b.subarray(0x26, 0x3a), ''), raw: b };
}

export class ColdFlash {
  constructor(transport, { log = () => {}, inEp = 1, outEp = 1 } = {}) {
    this.t = transport; this.log = log; this.inEp = inEp; this.outEp = outEp;
  }

  async readAsicId() {
    this.log('Waiting for ASIC id...');
    const b = await this.t.bulkIn(this.inEp, 0x100, 500);
    if (!b) throw new ProtocolError('Timeout waiting for ASIC ID (is the phone in cold-flash mode?)');
    this.log(`Got ${b.length} bytes.`);
    return parseAsicId(b);
  }

  async #readWord(timeout) {
    const b = await this.t.bulkIn(this.inEp, 4, timeout);
    if (!b) return null;
    if (b.length < 4) return null;
    return view(b).getUint32(0, true);
  }

  /** Header, ack, payload (in <=64K pieces), ack. Throws on error words. */
  async sendMessage(cmd, payload = null) {
    await this.t.bulkOut(this.outEp, xloaderMessage(cmd, payload));
    const ack = await this.#readWord(500);
    if (ack === null) throw new ProtocolError('timeout!');
    if (ack !== XLOADER.OK) {
      if ((ack & 0xff) === 0xaa) throw new ProtocolError(`failed with error 0x${(ack & 0xffff).toString(16)}`);
      throw new ProtocolError(`got invalid reply: 0x${ack.toString(16).padStart(4, '0')}`);
    }
    if (!payload || !payload.length) return;
    for (let o = 0; o < payload.length; o += 0x10000) {
      await this.t.bulkOut(this.outEp, payload.subarray(o, Math.min(o + 0x10000, payload.length)));
    }
    const done = await this.#readWord(5000);
    if (done === null) throw new ProtocolError('timeout!');
    if (done !== XLOADER.OK) throw new ProtocolError(`Got reply ${done.toString(16)} after sending data`);
  }

  /** Send the OMAP boot message + 2nd stage ("1st image" in the original). */
  async sendSecondStage(image) {
    this.log(`Sending 2nd image (${image.length} bytes)... `);
    await this.t.bulkOut(this.outEp, OMAP_PERIPHERAL_BOOT);
    await sleep(10);
    const len = new Uint8Array(4);
    view(len).setUint32(0, image.length, true);
    await this.t.bulkOut(this.outEp, len);
    await sleep(10);
    for (let o = 0; o < image.length; o += 0x10000) {
      await this.t.bulkOut(this.outEp, image.subarray(o, Math.min(o + 0x10000, image.length)));
    }
    await sleep(10);
    this.log('done.');
    await sleep(50);
  }

  async ping(tries = 3) {
    for (let i = 0; i < tries; i++) {
      this.log('Sending ping... ');
      try { await this.sendMessage(XLOADER.PING); this.log('pong.'); return; } catch (e) {
        if (e instanceof TransportError) throw e;
        this.log('failed.');
      }
    }
    throw new ProtocolError('No answer to X-Loader ping');
  }

  async hwid() {
    await this.t.bulkOut(this.outEp, xloaderMessage(XLOADER.HWID));
    const b = await this.t.bulkIn(this.inEp, 0x20, 500);
    if (!b || !b.length) throw new ProtocolError('No HWID reply');
    this.log(`Received ${b.length} bytes from 1st`);
    return b;
  }

  /** Full cold-flash sequence used with `flasher -c` (2nd + ape-algo). */
  async run({ second, apeAlgo }) {
    const asic = await this.readAsicId();
    this.log(`ASIC: ${asic.chip} rev ${asic.revision}, ${asic.secure}`);
    await this.sendSecondStage(second);
    await this.ping();
    let last;
    for (let i = 0; i < 3; i++) {
      this.log(`Sending ape-algo (${apeAlgo.length} bytes)... `);
      try { await this.sendMessage(XLOADER.SEND_APE_ALGO, apeAlgo); this.log('done.'); return asic; } catch (e) {
        if (e instanceof TransportError) throw e;
        last = e; this.log(`${e.message}`);
      }
    }
    throw last;
  }

  async leave() {
    this.log('Sending OMAP memory boot message...');
    await this.t.bulkOut(this.outEp, OMAP_MEMORY_BOOT);
    await sleep(250);
  }
}

// ----------------------------------------------------------------- NOLO

export const NOLO = {
  STATUS: 0x01, GET_VERSION: 0x03, IDENTIFY: 0x04, ERROR_LOG: 0x05,
  SET: 0x10, GET: 0x11, STRING: 0x12, SET_STRING: 0x13, GET_STRING: 0x14,
  SEND_IMAGE: 0x42, FLASH_IMAGE: 0x50, SEND_FLASH_FINISH: 0x52, SEND_FLASH_IMAGE: 0x54,
  ASIC_SELECT: 0x60, ASIC_WRITE: 0x61, ASIC_READ: 0x62,
  BOOT: 0x82, REBOOT: 0x83,
  IDX_RD_MODE: 0, IDX_ROOT_DEVICE: 1, IDX_USB_HOST: 2, IDX_ADD_RD_FLAGS: 3, IDX_DEL_RD_FLAGS: 4,
  DATA_EP: 2,
};

export const RD_FLAGS = {
  'master': 0x001, 'no-omap-wd': 0x002, 'no-ext-wd': 0x004, 'no-lifeguard-reset': 0x008,
  'serial-console': 0x010, 'no-usb-timeout': 0x020, 'sti-console': 0x040,
  'no-charging': 0x080, 'force-power-key': 0x100,
};
export const rdFlagNames = (mask) => Object.entries(RD_FLAGS).filter(([, v]) => mask & v).map(([k]) => k);
export function parseRdFlags(list) {
  let m = 0;
  for (const raw of list.split(',')) {
    const n = raw.trim();
    if (!n) continue;
    if (!(n in RD_FLAGS)) throw new ProtocolError(`Invalid flag '${n}'`);
    m |= RD_FLAGS[n];
  }
  return m;
}

export class NoloClient {
  constructor(transport, { log = () => {} } = {}) { this.t = transport; this.log = log; }

  async #in(request, value, index, length) {
    try { return await this.t.controlIn(request, value, index, length); } catch (e) { throw await this.#fail(e, request); }
  }
  async #out(request, value, index, data) {
    try { await this.t.controlOut(request, value, index, data); } catch (e) { throw await this.#fail(e, request); }
  }
  async #fail(e, request) {
    if (!(e instanceof TransportError) || e.code !== 'stall') return e;
    this.log(`Sending request 0x${request.toString(16).padStart(2, '0')} failed!`);
    try {
      const b = await this.t.controlIn(NOLO.ERROR_LOG, 0, 0, 0x800);
      if (b.length) {
        this.log('Bootloader error log follows:');
        for (let p = 0; p < b.length;) {
          const z = b.indexOf(0, p);
          if (z < 0) break;
          if (z > p) this.log('  ' + dec.decode(b.subarray(p, z)));
          p = z + 1;
        }
      }
    } catch { /* ignore */ }
    return e;
  }

  /** Poll status until the bootloader is idle. */
  async waitReady() {
    for (let i = 0; i < 50; i++) {
      const b = await this.#in(NOLO.STATUS, 0, 0, 4);
      if (b.length === 4 && view(b).getUint32(0, true) === 0) return;
      await sleep(20);
    }
    throw new ProtocolError('NOLO did not become ready');
  }

  /** Parse the IDENTIFY records {name[14], u16 len, data[len]}. */
  async identifyRecords() {
    const b = await this.#in(NOLO.IDENTIFY, 0, 0, 512);
    const rec = {};
    for (let p = 0; p + 16 <= b.length;) {
      const len = view(b).getUint16(p + 14, true);
      if (p + 16 + len > b.length || (len & 3) !== 0) {
        this.log(`Invalid device info block length ${len}`);
        break;
      }
      rec[cstr(b.subarray(p, p + 14))] = cstr(b.subarray(p + 16, p + 16 + len));
      p += 16 + len;
    }
    // Fallback in the style of 0xFFFF: look for "name\0" substrings.
    for (const k of ['prod_code', 'hw_rev']) {
      if (rec[k]) continue;
      const needle = toBytes(k + '\0');
      outer: for (let i = 0; i + needle.length < b.length; i++) {
        for (let j = 0; j < needle.length; j++) if (b[i + j] !== needle[j]) continue outer;
        let q = i + needle.length;
        while (q < b.length && b[q] < 32) q++;
        rec[k] = cstr(b.subarray(q));
        break;
      }
    }
    return rec;
  }

  async version() {
    const b = await this.#in(NOLO.GET_VERSION, 0, 0, 4);
    const v = view(b).getUint32(0, true);
    return { text: `${(v >>> 20) & 15}.${(v >>> 16) & 15}.${(v >>> 8) & 255}`, patch: (v >>> 8) & 0xffff, api: v & 255 };
  }

  async getString(key) {
    await this.#out(NOLO.STRING, 0, 0, toBytes(key));
    const b = await this.#in(NOLO.GET_STRING, 0, 0, 0x3ff);
    return cstr(b);
  }
  async setString(key, value) {
    await this.#out(NOLO.STRING, 0, 0, toBytes(key));
    await this.#out(NOLO.SET_STRING, 0, 0, toBytes(value));
  }

  /** `flasher -i` equivalent. */
  async init() {
    this.log('Initializing NOLO...');
    await this.waitReady();
    const rec = await this.identifyRecords();
    if (!rec.prod_code) throw new ProtocolError('Product code not found');
    this.log(`Found device ${rec.prod_code}, hardware revision ${rec.hw_rev ?? '?'}`);
    const info = { product: rec.prod_code, hwRev: rec.hw_rev ?? '', records: rec };
    try {
      const v = await this.version();
      this.log(`NOLO version ${v.text}`);
      if (v.api >= 2) throw new ProtocolError(`Invalid flashing API version (${v.api}). Try with a newer version of flasher program`);
      info.nolo = v;
    } catch (e) {
      if (e instanceof ProtocolError) throw e;
      this.log('Unable to get bootloader version');
    }
    try { info.swRelease = await this.getString('version:sw-release'); } catch { /* optional */ }
    return info;
  }

  async getRdMode() {
    const b = await this.#in(NOLO.GET, 0, NOLO.IDX_RD_MODE, 1);
    return b[0] ? 1 : 0;
  }
  async setRdMode(on) {
    this.log(`${on ? 'Enabling' : 'Disabling'} R&D mode...`);
    await this.#out(NOLO.SET, on ? 1 : 0, NOLO.IDX_RD_MODE);
  }
  async getRdFlags() {
    const b = await this.#in(NOLO.GET, 0, NOLO.IDX_ADD_RD_FLAGS, 2);
    return view(b).getUint16(0, true);
  }
  /** Replace the whole flag set. */
  async setRdFlags(mask) {
    const add = mask & ~RD_FLAGS.master;
    const del = ~add & 0x1fe;
    await this.#out(NOLO.SET, add, NOLO.IDX_ADD_RD_FLAGS);
    await this.#out(NOLO.SET, del, NOLO.IDX_DEL_RD_FLAGS);
  }

  /**
   * Load an image into RAM (or, for rootfs, flash it as it arrives).
   * image = {name, blob, data, size}
   */
  async sendImage(image, onProgress = () => {}) {
    const flash = image.type === 'rootfs';
    this.log(`Sending${flash ? ' and flashing' : ''} ${image.type} image (${image.size >> 10} kB)...`);
    await this.#out(flash ? NOLO.SEND_FLASH_IMAGE : NOLO.SEND_IMAGE, 0, 0, image.blob);
    // Like the original, send the payload rounded up to 128 bytes, 0xFF-filled.
    const total = image.paddedSize ?? image.size;
    const chunk = Math.min(0x20000, total) || 1;
    for (let o = 0; o < total; o += chunk) {
      const piece = new Uint8Array(Math.min(chunk, total - o)).fill(0xff);
      if (o < image.size) piece.set(image.data.subarray(o, Math.min(o + piece.length, image.size)));
      await this.t.bulkOut(NOLO.DATA_EP, piece);
      onProgress(o + piece.length, total);
    }
    if (flash) {
      this.log('Finishing flashing... ');
      await this.#out(NOLO.SEND_FLASH_FINISH, 0, 0);
      this.log('done');
    }
    await sleep(100);
  }

  async boot(cmdline = null) {
    const data = cmdline ? toBytes(cmdline) : undefined;
    this.log(cmdline ? `Booting kernel with cmdline: '${cmdline}'...` : 'Booting kernel with default cmdline...');
    await this.#out(NOLO.BOOT, 0, 0, data);
  }
  async bootFlashMode() {
    this.log('Booting device into flash mode.');
    await this.#out(NOLO.BOOT, 1, 0);
  }
  async reboot() {
    this.log('Rebooting device...');
    await this.#out(NOLO.REBOOT, 0, 0);
  }
}

// ------------------------------------------------------- ISI / SU server

export const ISI = { MEDIA_USB: 0x1b, DEV_PHONE: 0x00, DEV_PC: 0x10, RES_SU: 0x88, RES_ADL: 0x6f };

export const SU = {
  VERIFY_COMMS: 0x00, GET_PARAMETER: 0x01, SET_PARAMETER: 0x02, BEGIN_UPDATE: 0x03,
  BEGIN_IMAGE_UPDATE: 0x04, SETUP_AUX_DATA_PIPE: 0x05, GET_UPDATE_STATUS: 0x06,
  PREPARE_DATA_BLOCK: 0x08, FEED_DATA_BLOCK: 0x09, FINISH_IMAGE_UPDATE: 0x0a,
  WAIT_FOR_BUFFER: 0x0b, DEVICE_STATE_CHANGE: 0x0c, BANDWIDTH_TEST: 0x0d,
  UPDATE_SW_REL: 0x0f, CANCEL_UPDATE: 0x10, READ_CONFIG: 0x11, BEGIN_ERASE: 0x12,
  FINISH_UPDATE: 0x1f,
  RESPONSE: 0x20, COMMON_MESSAGE: 0xf0, FAILURE: 0xff,
};
const SU_NAMES = Object.fromEntries(Object.entries(SU).map(([k, v]) => [v, k]));

export const SU_STATES = { 0: 'pending', 1: 'init', 2: 'erasing', 3: 'writing', 4: 'finishing', 0x10: 'finished' };
const SU_ERRORS = {
  1: 'Unknown error', 2: 'Invalid arguments', 3: 'Invalid state', 4: 'Out of memory',
  5: 'Object exists', 6: 'Operation not supported', 7: 'Object not found',
  8: 'Object too large', 9: 'Unknown request', 10: 'Security failure', 11: 'Battery low',
};
export const PROTOCOL_MIN = 106;
export const PROTOCOL_MAX = 108;
export const HOST_PROTOCOL = 108;

export function isiBuild({ res = ISI.RES_SU, trid, id, payload = new Uint8Array(0) }) {
  const m = new Uint8Array(10 + payload.length);
  m[0] = ISI.MEDIA_USB; m[1] = ISI.DEV_PHONE; m[2] = ISI.DEV_PC; m[3] = res;
  view(m).setUint16(4, payload.length + 4);
  m[6] = 0; m[7] = 0; m[8] = trid & 0xff; m[9] = id;
  m.set(payload, 10);
  return m;
}

export function isiParse(b) {
  if (b.length < 10) throw new ProtocolError(`usb_isi_recv: need at least 10 bytes (got ${b.length})`);
  const len = view(b).getUint16(4);
  if (b.length < len + 6) throw new ProtocolError(`usb_isi_recv: reply size mismatch (hdr ${len + 6}, got ${b.length})`);
  return {
    media: b[0], rdev: b[1], sdev: b[2], res: b[3], robj: b[6], sobj: b[7], trid: b[8], id: b[9],
    payload: b.subarray(10, len + 6),
  };
}

export class SuError extends ProtocolError {}

export class SuClient {
  /**
   * opts: {isiIn, isiOut (endpoint numbers), rawOut (endpoint number or 0), log}
   */
  constructor(transport, { isiIn = 1, isiOut = 1, rawOut = 0, log = () => {}, verbose = false } = {}) {
    this.t = transport; this.isiIn = isiIn; this.isiOut = isiOut; this.rawOut = rawOut;
    this.log = log; this.verbose = verbose;
    this.trid = 0;
    this.version = 0;
    this.info = {};
    this.cancelled = false;
    this.updateActive = false; // between BEGIN_UPDATE and FINISH_UPDATE
  }

  async #write(frame) {
    await this.t.bulkOut(this.isiOut, frame);
    if (frame.length % 512 === 0) await this.t.bulkOut(this.isiOut, new Uint8Array(0));
  }

  /**
   * Send one request and return the reply payload.
   * min/max: accepted payload size, statusIdx: index of the status byte or -1.
   */
  async request(id, payload = new Uint8Array(0), { timeout = 5000, min = 1, max = -1, statusIdx = 0, res = ISI.RES_SU, respId = id | SU.RESPONSE } = {}) {
    const name = SU_NAMES[id] ?? `0x${id.toString(16)}`;
    const trid = this.trid++ & 0xff;
    await this.#write(isiBuild({ res, trid, id, payload }));
    const deadline = Date.now() + timeout;
    let msg;
    for (;;) {
      const left = deadline - Date.now();
      const b = left > 0 ? await this.t.bulkIn(this.isiIn, 0x10200, left) : null;
      if (!b) throw new SuError(`${name}_REQ timed out.`, { timeout: true });
      if (!b.length) continue;
      msg = isiParse(b);
      if (msg.trid !== trid || msg.sdev !== ISI.DEV_PHONE || msg.rdev !== ISI.DEV_PC) {
        if (msg.id === SU.COMMON_MESSAGE) this.log(`Unexpected reply: COMMON_MESSAGE likely from CMT (sub-msg id 0x${(msg.payload[0] ?? 0).toString(16)})`, 1);
        continue;
      }
      break;
    }
    const p = msg.payload;
    if (msg.id !== respId) {
      if (msg.res === ISI.RES_SU && msg.id === SU.FAILURE) throw new SuError('Server in failure mode: internal error or bad HW. Cannot continue');
      throw new SuError(`Unexpected reply: instead of ${name}_RESP got 0x${msg.id.toString(16)} from resource 0x${msg.res.toString(16)}`);
    }
    if (p.length < min) throw new SuError(`Short ${name}_RESP received (${p.length} bytes, want ${min}).`);
    if (max >= 0 && p.length > max) throw new SuError(`Too long ${name}_RESP received (${p.length} bytes, want ${max}).`);
    if (statusIdx >= 0 && p[statusIdx] !== 0) {
      const code = p[statusIdx];
      let detail = '';
      if (statusIdx + 1 < p.length) detail = cstr(p.subarray(statusIdx + 1));
      const err = new SuError(`${name}_REQ terminated with error code ${code}: ${SU_ERRORS[code] ?? 'Undefined error code'}`, { code, detail, batteryLow: code === 11 });
      throw err;
    }
    return p;
  }

  // ---- parameters

  async getParam(key) {
    const p = await this.request(SU.GET_PARAMETER, toBytes(key));
    return dec.decode(p.subarray(1));
  }
  async setParam(key, value) {
    await this.request(SU.SET_PARAMETER, concat(toBytes(key), Uint8Array.of(0), toBytes(value)), { min: 1, max: 1 });
  }

  // ---- session

  async ping(tries = 6) {
    let ms = 250;
    for (let i = 1; i <= tries; i++) {
      this.log(`Ping attempt ${i} (${ms} ms)`);
      try { await this.request(SU.VERIFY_COMMS, new Uint8Array(0), { timeout: ms, min: 0, statusIdx: -1 }); return; } catch (e) {
        if (!e.timeout) throw e;
      }
      ms = Math.min(ms * 2, 5000);
    }
    throw new SuError('No answer to SU ping');
  }

  /** Sync-mode (ADL) reboot, used for 0421:03d2 / 0421:051a. */
  async adlReboot() {
    const t = (id, payload) => this.request(id, payload, { res: ISI.RES_ADL, statusIdx: -1, min: 0 }).catch(() => {});
    await t(0x0d, Uint8Array.of(0xff, 0xfc, 0, 0, 0, 0));
    await t(0x04, Uint8Array.of(0x24, 0x00));
  }

  /** Handshake: ping, protocol versions, product info. */
  async init({ traceLevel = null } = {}) {
    this.log('Initializing softupd protocol...');
    await this.ping();
    const v = parseInt(await this.getParam('/update/protocol_version'), 10);
    if (!Number.isFinite(v)) throw new SuError('Invalid server protocol version string');
    if (v < PROTOCOL_MIN) throw new SuError('Refusing to continue: Image contains a deprecated server.');
    if (v > PROTOCOL_MAX) throw new SuError(`Image contains a server with more recent version of the protocol ${Math.floor(v / 100)}.${v % 100}. You have to update the flasher client`);
    this.version = v;
    await this.setParam('/update/host_protocol_version', String(HOST_PROTOCOL));
    // The original refuses servers older than 1.4.8: they may overwrite the certificates.
    const app = await this.getParam('/update/application_info');
    this.log(`Server application: ${app}`);
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(app);
    const [maj, min, pat] = m ? m.slice(1).map(Number) : [0, 0, 0];
    if (!m || !(maj > 1 || (maj === 1 && (min > 4 || (min === 4 && pat >= 8))))) {
      throw new SuError('Refusing to continue: Image contains a deprecated server. In worst case flashing with deprecated software may overwrite the certificates and render your device unusable.');
    }
    const product = await this.getParam('/device/product_code');
    const hwBuild = await this.getParam('/device/hw_build');
    this.log(`Found product ${product} rev. ${hwBuild}`);
    const supported = (await this.getParam('/update/supported_images')).split(',').filter(Boolean);
    if (traceLevel !== null) {
      try { await this.setParam('/update/trace_level', String(traceLevel)); } catch { this.log('WARNING: failed to set the device trace level'); }
    }
    this.log(`Server implements softupd protocol version ${Math.floor(v / 100)}.${String(v % 100).padStart(2, '0')}`);
    this.info = { product, hwBuild, protocol: v, supported };
    return this.info;
  }

  async batteryLevel() { return parseInt(await this.getParam('/device/battery_level'), 10); }

  async beginUpdate() { await this.request(SU.BEGIN_UPDATE); this.updateActive = true; }
  async finishUpdate() { this.updateActive = false; await this.request(SU.FINISH_UPDATE); }

  async beginImage(blob) {
    const p = await this.request(SU.BEGIN_IMAGE_UPDATE, blob, { min: 9, statusIdx: 8 });
    const v = view(p);
    const pipe = v.getUint32(0);
    const blockSize = v.getUint32(4);
    if (!blockSize) throw new SuError('Invalid pipe block size: 0');
    return { pipe, blockSize };
  }
  async setupAuxPipe(pipe) {
    const a = new Uint8Array(4); view(a).setUint32(0, pipe);
    await this.request(SU.SETUP_AUX_DATA_PIPE, concat(a, toBytes('usb:raw')));
  }
  async getStatus(pipe) {
    const a = new Uint8Array(4); view(a).setUint32(0, pipe);
    const p = await this.request(SU.GET_UPDATE_STATUS, a, { min: 21, statusIdx: 20 });
    const v = view(p);
    const raw = v.getUint32(0);
    return {
      state: raw & 0xffff, stateName: SU_STATES[raw & 0xffff] ?? `unknown_${(raw & 0xffff).toString(16)}`,
      failed: !!(raw & 0x10000),
      done: Number(v.getBigUint64(4)), total: Number(v.getBigUint64(12)),
    };
  }
  /** -> bytes the server can take for `pipe` now (0 = nothing yet). */
  async waitForBuffer(pipe, timeoutMs = 250) {
    const a = new Uint8Array(4); view(a).setUint32(0, timeoutMs);
    const p = await this.request(SU.WAIT_FOR_BUFFER, a, { timeout: timeoutMs + 5000, min: 5, statusIdx: -1 });
    const v = view(p);
    const n = v.getUint32(0);
    if (p.length < n * 8 + 5) throw new SuError(`Short WAIT_FOR_BUFFER_RESP received (${p.length} bytes, want ${n * 8 + 5}).`);
    if (p[n * 8 + 4] !== 0) throw new SuError('SU_WAIT_FOR_BUFFER_REQ terminated with error', { code: p[n * 8 + 4] });
    for (let i = 0; i < n; i++) if (v.getUint32(4 + i * 8) === pipe) return v.getUint32(8 + i * 8);
    if (n === 0) return 0;
    throw new SuError('SU_WAIT_FOR_BUFFER_RESP: Pipe id mismatch');
  }
  async prepareBlock(pipe, length) {
    const a = new Uint8Array(8); const v = view(a); v.setUint32(0, pipe); v.setUint32(4, length);
    await this.request(SU.PREPARE_DATA_BLOCK, a);
  }
  async feed(pipe, data) {
    const a = new Uint8Array(4); view(a).setUint32(0, pipe);
    await this.request(SU.FEED_DATA_BLOCK, concat(a, data), { timeout: 20000 });
  }
  async finishImage(pipe) {
    const a = new Uint8Array(4); view(a).setUint32(0, pipe);
    await this.request(SU.FINISH_IMAGE_UPDATE, a);
  }
  async updateSwRelease(blob) { await this.request(SU.UPDATE_SW_REL, blob); }
  async cancel() { try { await this.request(SU.CANCEL_UPDATE); } catch { /* best effort */ } }
  async readConfig(block) {
    const a = new Uint8Array(4); view(a).setUint32(0, block);
    const p = await this.request(SU.READ_CONFIG, a);
    return p.subarray(1);
  }

  async erase(what, method = 'secure') {
    if (this.version < 105) throw new SuError('WARNING: device sw does not support erase');
    this.log('Erasing, this may take a while.');
    await this.request(SU.BEGIN_ERASE, concat(toBytes(`${what}=${method}`), Uint8Array.of(0)), { timeout: 1800000 });
    this.log('Erase done.');
  }

  /** mode: 'reboot' (default), 'poweroff', or any "<name>" -> "reboot=<name>" */
  async stateChange(mode = 'reboot') {
    const s = mode === 'reboot' || mode === 'poweroff' ? mode : `reboot=${mode}`;
    if (s.length > 15) throw new SuError('Reboot mode string too long');
    const p = new Uint8Array(16); p.set(toBytes(s));
    await this.request(SU.DEVICE_STATE_CHANGE, p);
  }

  // ---- R&D mode

  async getRdMode() { return this.getParam('/device/rd_mode'); }
  /** add/remove: arrays of flag names; removeAll clears everything. */
  async setRdMode({ add = [], remove = [], removeAll = false } = {}) {
    let s = '';
    if (add.length) s += `+{${add.join(',')}}`;
    if (removeAll) s += '-{*}';
    else if (remove.length) s += `-{${remove.join(',')}}`;
    if (!s) return;
    this.log(`>>> ${s}`, 3);
    await this.setParam('/device/rd_mode', s);
  }
}
