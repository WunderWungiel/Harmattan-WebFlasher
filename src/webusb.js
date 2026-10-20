// WebUSB glue: implements the `transport` and `host` interfaces used by
// protocol.js / flasher.js. Browser only.
import {
  TransportError, USB_FILTERS, USB_DEVICES, classifyUsbId, parseConfigDescriptor,
  findPhonetInterface, sleep,
} from './protocol.js';

const TIMEOUT = Symbol('timeout');

function mapError(e) {
  if (e instanceof TransportError) return e;
  const name = e?.name ?? '';
  const code = name === 'NotFoundError' || /disconnect|no device/i.test(e?.message ?? '') ? 'disconnected' : 'io';
  return new TransportError(e?.message ?? String(e), code);
}

export class WebUsbTransport {
  constructor(device) {
    this.dev = device;
    this.pending = new Map(); // endpoint -> in-flight transferIn (kept across timeouts)
  }

  #setup(request, value, index) {
    return { requestType: 'vendor', recipient: 'device', request, value, index };
  }

  async controlOut(request, value, index, data) {
    let r;
    try {
      r = data && data.length
        ? await this.dev.controlTransferOut(this.#setup(request, value, index), data)
        : await this.dev.controlTransferOut(this.#setup(request, value, index));
    } catch (e) { throw mapError(e); }
    if (r.status === 'stall') throw new TransportError(`control OUT 0x${request.toString(16)} stalled`, 'stall');
    if (r.status !== 'ok') throw new TransportError(`control OUT 0x${request.toString(16)}: ${r.status}`);
  }

  async controlIn(request, value, index, length) {
    let r;
    try { r = await this.dev.controlTransferIn(this.#setup(request, value, index), length); } catch (e) { throw mapError(e); }
    if (r.status === 'stall') throw new TransportError(`control IN 0x${request.toString(16)} stalled`, 'stall');
    if (r.status !== 'ok') throw new TransportError(`control IN 0x${request.toString(16)}: ${r.status}`);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  async bulkOut(endpoint, data) {
    let r;
    try { r = await this.dev.transferOut(endpoint, data); } catch (e) { throw mapError(e); }
    if (r.status === 'stall') {
      try { await this.dev.clearHalt('out', endpoint); } catch { /* ignore */ }
      throw new TransportError(`bulk OUT ep${endpoint} stalled`, 'stall');
    }
    if (r.status !== 'ok' || r.bytesWritten !== data.length) {
      throw new TransportError(`bulk OUT ep${endpoint}: ${r.status} (${r.bytesWritten}/${data.length})`);
    }
  }

  /**
   * WebUSB can't cancel a transfer, so a timed-out read stays in flight and
   * is handed to the next bulkIn() on that endpoint (no data is lost).
   */
  async bulkIn(endpoint, maxLength, timeoutMs) {
    let p = this.pending.get(endpoint);
    if (!p) {
      p = this.dev.transferIn(endpoint, maxLength).finally(() => {
        if (this.pending.get(endpoint) === p) this.pending.delete(endpoint);
      });
      this.pending.set(endpoint, p);
    }
    let timer;
    let r;
    try {
      r = await Promise.race([p, new Promise((res) => { timer = setTimeout(() => res(TIMEOUT), timeoutMs); })]);
    } catch (e) { throw mapError(e); } finally { clearTimeout(timer); }
    if (r === TIMEOUT) return null;
    if (r.status === 'stall') {
      try { await this.dev.clearHalt('in', endpoint); } catch { /* ignore */ }
      throw new TransportError(`bulk IN ep${endpoint} stalled`, 'stall');
    }
    if (r.status !== 'ok') throw new TransportError(`bulk IN ep${endpoint}: ${r.status}`);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }
}

async function readConfigDescriptor(device) {
  const get = (len) => device.controlTransferIn(
    { requestType: 'standard', recipient: 'device', request: 6, value: 0x0200, index: 0 }, len);
  const head = await get(9);
  if (head.status !== 'ok') throw new Error('GET_DESCRIPTOR failed');
  const total = head.data.getUint16(2, true);
  const full = await get(total);
  if (full.status !== 'ok') throw new Error('GET_DESCRIPTOR failed');
  return new Uint8Array(full.data.buffer, full.data.byteOffset, full.data.byteLength);
}

export class WebUsbHost {
  /**
   * onWaiting(bool, hint) is called while we are waiting for a device that
   * has re-enumerated; browsers may need the user to grant access again.
   */
  constructor({ log = () => {}, onWaiting = () => {} } = {}) {
    this.log = log; this.onWaiting = onWaiting;
    this.device = null;
    this.rejected = new WeakSet(); // devices that aren't Phonet
  }

  static get supported() { return typeof navigator !== 'undefined' && !!navigator.usb; }

  /** Must be called from a user gesture. */
  async requestDevice() {
    const d = await navigator.usb.requestDevice({ filters: USB_FILTERS });
    return d;
  }

  async release() {
    const d = this.device;
    this.device = null;
    if (d) { try { await d.close(); } catch { /* already gone */ } }
  }

  /** Interrupt a pending acquire() (Abort button). */
  cancel() { this.cancelled = true; }

  async acquire(kinds, { timeoutMs = 30000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let announced = false;
    this.cancelled = false;
    for (;;) {
      if (this.cancelled) { this.onWaiting(false); throw new Error('Aborted by user'); }
      const devices = await navigator.usb.getDevices();
      for (const d of devices) {
        try {
          const s = await this.#tryOpen(d, kinds);
          if (s) { if (announced) this.onWaiting(false); return s; }
        } catch (e) {
          this.log(`Cannot open ${d.productName ?? 'device'}: ${e.message}`, 1);
        }
      }
      if (Date.now() > deadline) {
        this.onWaiting(false);
        throw new TransportError(`Suitable USB interface (${kinds.join('|')}) not found`, 'disconnected');
      }
      if (!announced) {
        announced = true;
        this.log(`Suitable USB interface (${kinds.join('|')}) not found, waiting...`);
        this.onWaiting(true, kinds);
      }
      await sleep(400);
    }
  }

  async #tryOpen(d, kinds) {
    let kind = classifyUsbId(d.vendorId, d.productId);
    if (!kind) return null;
    if (kind === 'phonet-candidate' && (!kinds.includes('phonet') || this.rejected.has(d))) return null;
    if (kind !== 'phonet-candidate' && !kinds.includes(kind)) return null;

    await d.open();
    try {
      if (!d.configuration) await d.selectConfiguration(1);
      const usb = { vid: d.vendorId, pid: d.productId, serial: d.serialNumber ?? '', name: d.productName ?? '' };
      const transport = new WebUsbTransport(d);

      if (kind === 'nolo' || kind === 'bootrom') {
        const spec = USB_DEVICES[kind].find((x) => x.vid === d.vendorId && x.pid === d.productId);
        await d.claimInterface(spec.iface);
        if (spec.alt > 0) await d.selectAlternateInterface(spec.iface, spec.alt);
        this.device = d;
        return { mode: kind, transport, usb };
      }

      // Phonet: discover from the raw descriptor, the way the original does.
      let ph;
      try { ph = findPhonetInterface(parseConfigDescriptor(await readConfigDescriptor(d))); } catch (e) {
        this.log(`Config descriptor read failed (${e.message}); using interface heuristics`, 1);
        ph = guessPhonet(d);
      }
      if (!ph) {
        this.log(`Device ${d.vendorId.toString(16)}:${d.productId.toString(16)} (${d.productName ?? '?'}) has no Phonet interface; ignoring.`);
        this.rejected.add(d); await d.close(); return null;
      }
      this.log(`Phonet interface: data iface ${ph.dataInterface} alt ${ph.dataAlt}, IN ep${ph.inEp}, OUT ep${ph.outEp}`, 1);
      await d.claimInterface(ph.dataInterface);
      await d.selectAlternateInterface(ph.dataInterface, ph.dataAlt);
      if (ph.rawOutEp) {
        try {
          await d.claimInterface(ph.rawOutEp.iface);
          if (ph.rawOutEp.alt > 0) await d.selectAlternateInterface(ph.rawOutEp.iface, ph.rawOutEp.alt);
          this.log(`Raw data transfer EP found at EP${ph.rawOutEp.address & 0xf}.`);
        } catch (e) { this.log(`Raw data interface unavailable: ${e.message}`, 1); ph.rawOutEp = null; }
      }
      this.device = d;
      return { mode: 'phonet', transport, usb, phonet: ph };
    } catch (e) {
      try { await d.close(); } catch { /* ignore */ }
      throw e;
    }
  }
}

/** Fallback when the raw descriptor can't be read: CDC data interface with >1 endpoint. */
function guessPhonet(d) {
  for (const i of d.configuration.interfaces) {
    for (const a of i.alternates) {
      if (a.interfaceClass === 0x0a && a.endpoints.length > 1) {
        const inEp = a.endpoints.find((e) => e.direction === 'in');
        const outEp = a.endpoints.find((e) => e.direction === 'out');
        if (inEp && outEp) {
          return { controlInterface: -1, dataInterface: i.interfaceNumber, dataAlt: a.alternateSetting, inEp: inEp.endpointNumber, outEp: outEp.endpointNumber, rawOutEp: null };
        }
      }
    }
  }
  return null;
}
