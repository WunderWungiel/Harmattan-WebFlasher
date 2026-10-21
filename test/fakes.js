// Fake devices for exercising protocol.js / flasher.js without hardware.
import {
  isiParse, TransportError, NOLO, SU, XLOADER, xloaderCrc32, concat, toBytes, cstr, SYNC_MODE_PIDS,
} from '../src/protocol.js';

const be32 = (n) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const be64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };

/** An SU (softupd) server speaking ISI over a fake bulk pipe. */
export class FakeSuServer {
  constructor({ protocol = 108, appInfo = '1.4.8', product = 'RM-696', hwBuild = '2101', battery = 80, failImage = null, rdMode = '', rejectSet = [] } = {}) {
    this.params = new Map([
      ['/update/protocol_version', String(protocol)],
      ['/update/application_info', appInfo],
      ['/device/product_code', product],
      ['/device/hw_build', hwBuild],
      ['/update/supported_images', 'cert-sw,cmt-2nd,cmt-algo,cmt-mcusw,xloader,secondary,kernel,moslo,rootfs,mmc,tar,config'],
      ['/device/battery_level', String(battery)],
      ['/device/rd_mode', rdMode],
    ]);
    this.rxq = [];
    this.waiters = [];
    this.pipes = new Map();
    this.nextPipe = 100;
    this.log = [];
    this.images = []; // {blob, received[]}
    this.raw = [];
    this.failImage = failImage;
    this.rejectSet = rejectSet; // SET_PARAMETER keys answered with an error
    this.finished = false;
    this.rebooted = null;
    this.blockSize = 4096;
    this.seen = [];
  }

  #reply(req, id, payload) {
    const out = new Uint8Array(10 + payload.length);
    out[0] = 0x1b; out[1] = 0x10; out[2] = 0x00; out[3] = req.res;
    new DataView(out.buffer).setUint16(4, payload.length + 4);
    out[8] = req.trid; out[9] = id;
    out.set(payload, 10);
    this.#push(out);
  }
  #push(b) {
    const w = this.waiters.shift();
    if (w) w(b); else this.rxq.push(b);
  }

  handle(frame) {
    const req = isiParse(frame);
    const p = req.payload;
    this.seen.push(req.id);
    const ok = (extra = new Uint8Array(0)) => this.#reply(req, req.id | 0x20, concat(Uint8Array.of(0), extra));
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    switch (req.id) {
      case SU.VERIFY_COMMS: return this.#reply(req, 0x20, p);
      case SU.GET_PARAMETER: {
        const k = cstr(p);
        if (!this.params.has(k)) return this.#reply(req, 0x21, Uint8Array.of(7));
        return ok(toBytes(this.params.get(k)));
      }
      case SU.SET_PARAMETER: {
        const z = p.indexOf(0);
        if (this.rejectSet.includes(cstr(p))) return this.#reply(req, 0x22, Uint8Array.of(6));
        this.params.set(new TextDecoder().decode(p.subarray(0, z)), new TextDecoder().decode(p.subarray(z + 1)));
        return ok();
      }
      case SU.BEGIN_UPDATE: return ok();
      case SU.BEGIN_IMAGE_UPDATE: {
        const pipe = this.nextPipe++;
        const blob = p.slice();
        // find size in the 0x2e/0x5c file-data subblock
        let size = 0; let type = '';
        for (let o = 0; o < blob.length;) {
          const id = blob[o]; const len = blob[o + 1];
          if (id === 0x2e) { type = cstr(blob.subarray(o + 7, o + 19)); size = new DataView(blob.buffer, blob.byteOffset + o + 2 + 17).getUint32(0); }
          o += 2 + len;
        }
        const pipeState = { pipe, type, size, padded: (size + 127) & ~127, got: 0, chunks: [], expect: 0, raw: false };
        this.pipes.set(pipe, pipeState);
        this.images.push(pipeState);
        return this.#reply(req, 0x24, concat(be32(pipe), be32(this.blockSize), Uint8Array.of(0)));
      }
      case SU.SETUP_AUX_DATA_PIPE: {
        const ps = this.pipes.get(dv.getUint32(0));
        ps.raw = cstr(p.subarray(4)) === 'usb:raw' || new TextDecoder().decode(p.subarray(4)) === 'usb:raw';
        return ok();
      }
      case SU.WAIT_FOR_BUFFER: {
        const free = [...this.pipes.values()].filter((x) => x.got < x.padded && !x.expect)
          .map((x) => [x.pipe, Math.min(0x30000, x.padded - x.got)]);
        const out = [be32(free.length), ...free.flatMap(([a, b]) => [be32(a), be32(b)]), Uint8Array.of(0)];
        return this.#reply(req, 0x2b, concat(...out));
      }
      case SU.PREPARE_DATA_BLOCK: {
        const ps = this.pipes.get(dv.getUint32(0));
        ps.expect = dv.getUint32(4);
        return ok();
      }
      case SU.FEED_DATA_BLOCK: {
        const ps = this.pipes.get(dv.getUint32(0));
        ps.chunks.push(p.slice(4)); ps.got += p.length - 4; ps.expect = Math.max(0, ps.expect - (p.length - 4));
        return ok();
      }
      case SU.GET_UPDATE_STATUS: {
        const ps = this.pipes.get(dv.getUint32(0));
        const done = ps.got >= ps.padded && !ps.expect;
        let state = done ? 0x10 : 3;
        if (this.failImage === ps.type) state |= 0x10000;
        return this.#reply(req, 0x26, concat(be32(state), be64(ps.got), be64(ps.padded), Uint8Array.of(0)));
      }
      case SU.FINISH_IMAGE_UPDATE: return ok();
      case SU.UPDATE_SW_REL: this.swRel = p.slice(); return ok();
      case SU.FINISH_UPDATE: this.finished = true; return ok();
      case SU.DEVICE_STATE_CHANGE: this.rebooted = cstr(p); return ok();
      case SU.BEGIN_ERASE: if (this.eraseError) return this.#reply(req, 0x32, Uint8Array.of(this.eraseError));
        this.erased = (this.erased ?? []).concat(cstr(p)); return ok();
      case SU.CANCEL_UPDATE: this.cancelled = true; return ok();
      default: return this.#reply(req, req.id | 0x20, Uint8Array.of(9));
    }
  }

  transport({ rawEp = 0 } = {}) {
    return {
      bulkOut: async (ep, data) => {
        if (ep === rawEp && rawEp) { this.raw.push(data.slice()); const ps = [...this.pipes.values()].find((x) => x.raw && x.expect); if (ps) { ps.got += data.length; ps.expect = Math.max(0, ps.expect - data.length); ps.chunks.push(data.slice()); } return; }
        if (data.length) this.handle(data);
      },
      bulkIn: async (ep, len, timeout) => {
        if (this.rxq.length) return this.rxq.shift();
        return new Promise((res) => {
          const t = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== h); res(null); }, timeout);
          const h = (b) => { clearTimeout(t); res(b); };
          this.waiters.push(h);
        });
      },
      controlIn: async () => { throw new TransportError('no control on phonet', 'stall'); },
      controlOut: async () => { throw new TransportError('no control on phonet', 'stall'); },
    };
  }

  imageBytes(i) {
    const im = this.images[i];
    return concat(...im.chunks).subarray(0, im.padded);
  }
}

/** NOLO bootloader fake (vendor control requests + bulk EP2). */
export class FakeNolo {
  constructor({ product = 'RM-696', hwRev = '2101', version = (0 << 20) | (1 << 16) | (0x2b << 8) | 1 /* 0.1.43 api 1 */ } = {}) {
    this.product = product; this.hwRev = hwRev;
    this.version = version;
    this.strings = new Map([['version:sw-release', 'RM-696_TEST']]);
    this.sent = [];
    this.bulk = [];
    this.booted = null;
    this.rd = { mode: 0, flags: 0 };
    this.statusStalls = 0; // stall this many STATUS requests first
  }
  identifyBlob() {
    const rec = (name, val) => {
      const v = toBytes(val); const len = (v.length + 4) & ~3;
      const r = new Uint8Array(16 + len); r.set(toBytes(name)); new DataView(r.buffer).setUint16(14, len, true); r.set(v, 16); return r;
    };
    return concat(rec('prod_code', this.product), rec('hw_rev', this.hwRev));
  }
  transport() {
    let selected = '';
    return {
      controlIn: async (req, value, index, length) => {
        switch (req) {
          case NOLO.STATUS:
            if (this.statusStalls > 0) { this.statusStalls--; throw new TransportError('stall', 'stall'); }
            return Uint8Array.of(1, 0, 0, 0); // non-zero: the original does not wait for 0
          case NOLO.IDENTIFY: return this.identifyBlob();
          case NOLO.GET_VERSION: return Uint8Array.of(this.version & 255, (this.version >> 8) & 255, (this.version >> 16) & 255, (this.version >>> 24) & 255);
          case NOLO.GET_STRING: return toBytes(this.strings.get(selected) ?? '');
          case NOLO.GET: return index === 0 ? Uint8Array.of(this.rd.mode) : Uint8Array.of(this.rd.flags & 255, this.rd.flags >> 8);
          case NOLO.ERROR_LOG: return new Uint8Array(0);
          default: throw new TransportError('stall', 'stall');
        }
      },
      controlOut: async (req, value, index, data) => {
        if (req === NOLO.STRING) selected = cstr(data);
        else if (req === NOLO.BOOT) this.booted = { mode: value, cmdline: data ? cstr(data) : null };
        else if (req === NOLO.SEND_IMAGE || req === NOLO.SEND_FLASH_IMAGE) this.sent.push({ req, blob: data.slice() });
        else if (req === NOLO.SET && index === 0) this.rd.mode = value;
        else if (req === NOLO.SET && index === 3) this.rd.flags |= value;
        else if (req === NOLO.SET && index === 4) this.rd.flags &= ~value;
      },
      bulkOut: async (ep, data) => { this.bulk.push({ ep, data: data.slice() }); },
      bulkIn: async () => null,
    };
  }
}

/** OMAP boot ROM + X-Loader fake. */
export class FakeBootRom {
  constructor() {
    this.out = [];
    this.inq = [Uint8Array.of(0x05, 1, 5, 1, 0x36, 0x30, 0x07, 0x02, 0x13, 2, 1, 1, ...new Array(0x45 - 12).fill(0))];
    this.state = 'asic';
    this.msgs = [];
    this.pending = null;
  }
  transport() {
    return {
      bulkOut: async (ep, data) => {
        this.out.push(data.slice());
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        if (this.pending) {
          this.pending.left -= data.length;
          if (this.pending.left <= 0) { this.pending = null; this.inq.push(Uint8Array.of(0xaa, 0x6f, 0, 0)); }
          return;
        }
        if (data.length === 16 && dv.getUint16(0, true) === XLOADER.MAGIC) {
          const cmd = dv.getUint16(2, true); const size = dv.getUint32(4, true);
          const crc = dv.getUint32(12, true);
          if (crc !== xloaderCrc32(data.subarray(0, 12))) throw new Error('bad header crc');
          this.msgs.push({ cmd, size });
          this.inq.push(Uint8Array.of(0xaa, 0x6f, 0, 0));
          if (size) this.pending = { left: size };
        }
      },
      bulkIn: async () => this.inq.shift() ?? null,
      controlIn: async () => { throw new TransportError('x', 'stall'); },
      controlOut: async () => { throw new TransportError('x', 'stall'); },
    };
  }
}

/** Host that hands out sessions in a scripted order, like re-enumeration would. */
export class FakeHost {
  constructor(script) { this.script = script; this.acquired = []; this.released = 0; }
  async acquire(kinds) {
    const next = this.script.shift();
    if (!next) throw new TransportError('no more devices', 'disconnected');
    if (!kinds.includes(next.mode)) throw new TransportError(`script gave ${next.mode}, wanted ${kinds}`, 'disconnected');
    this.acquired.push(next.mode);
    return typeof next === 'function' ? next() : next;
  }
  async release() { this.released++; }
}

export { SYNC_MODE_PIDS };
