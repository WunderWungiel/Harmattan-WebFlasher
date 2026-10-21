// High-level operations (the equivalents of flasher's -i, -c, -f, -R, -b, ...).
// UI-free: talks to hardware through a `host` object:
//
//   host.acquire(kinds, {timeoutMs}) -> Promise<Session>
//       kinds: any of 'bootrom' | 'nolo' | 'phonet'
//       Session: {mode, transport, usb: {vid,pid,serial,name}, phonet?: {inEp,outEp,rawOutEp}}
//   host.release() -> Promise<void>      (close current device)
//
// Re-enumeration (boot ROM -> ape-algo, NOLO -> ape-algo, reboot) goes through
// release() + acquire(), so the host decides how to find the next device.
import {
  ColdFlash, NoloClient, SuClient, SuError, ProtocolError, TransportError,
  SYNC_MODE_PIDS, rdFlagNames, parseRdFlags, RD_FLAGS, sleep, noloCanSetRd,
} from './protocol.js';
import { pickImage, readPadded } from './fiasco.js';

/** Sub-images that can be flashed over SU, in the order of the original's table. */
export const SU_FLASH_ORDER = ['cert-sw', 'cmt-2nd', 'cmt-algo', 'cmt-mcusw', 'xloader', 'secondary', 'kernel', 'moslo', 'rootfs', 'mmc', 'tar', 'config'];
/**
 * Order in which they are actually flashed. The original's scheduler starts
 * nothing before cert-sw is done and holds every other image (CMT included)
 * until xloader/secondary are done; we flash one image at a time in that order.
 */
const SU_SEQUENCE = ['cert-sw', 'xloader', 'secondary', ...SU_FLASH_ORDER.filter((t) => !['cert-sw', 'xloader', 'secondary'].includes(t))];
/**
 * --flash-only names (table at 0x6202a0) and the sub-image types each one
 * selects. -M (--flash-only-mmc) is "mmc". initfs is accepted but has
 * nothing to flash over SU.
 */
export const FLASH_ONLY = {
  nolo: ['xloader', 'secondary'], kernel: ['kernel'], moslo: ['moslo'], initfs: ['initfs'],
  rootfs: ['rootfs'], cmt: ['cmt-2nd', 'cmt-algo', 'cmt-mcusw'], mmc: ['mmc'], tar: ['tar'],
};

/**
 * Indexes of the sub-images `--flash-only=names` would flash: those of the
 * listed types, plus cert-sw when any of them is a main image (0x38f, so
 * not for cmt alone). config is never included, as in the original.
 */
export function flashOnlySelection(images, names) {
  const types = new Set(names.flatMap((n) => FLASH_ONLY[n] ?? []));
  const withCert = [...types].some((t) => MAIN_TYPES.has(t));
  return new Set(images.filter((i) => types.has(i.type) || (withCert && i.type === 'cert-sw')).map((i) => i.index));
}

const MAIN_TYPES = new Set(['xloader', 'secondary', 'kernel', 'initfs', 'rootfs', 'moslo', 'mmc', 'tar']);
const SW_REL_TYPES = new Set(['xloader', 'secondary', 'kernel', 'initfs', 'rootfs']);
const MIN_BATTERY = 10;

/** Scheduler group of an image in the original's table: a failure skips the rest of its group. */
const suGroup = (img) => {
  if (img.type === 'cert-sw') return 3;
  if (img.type.startsWith('cmt-')) return 1;
  if (img.type === 'mmc' || img.type === 'tar') return 2;
  if (img.type === 'rootfs') return img.emmc ? 2 : 0; // OneNAND rootfs goes to group 0
  return 0;
};

export class Cancelled extends Error {}

export class Flasher {
  /**
   * log(message, level=0)       level 0 normal, 1+ verbose
   * progress({label, done, total, state, speed})
   */
  constructor(host, { log = () => {}, progress = () => {} } = {}) {
    this.host = host; this.log = log; this.progress = progress;
    this.session = null;
    this.aborted = false;
  }

  abort() { this.aborted = true; this.host.cancel?.(); }
  #check() { if (this.aborted) throw new Cancelled('Aborted by user'); }

  async connect(kinds = ['nolo', 'bootrom', 'phonet'], opts = {}) {
    if (this.session && kinds.includes(this.session.mode)) return this.session;
    if (this.session) await this.host.release();
    this.session = null;
    this.session = await this.host.acquire(kinds, opts);
    this.log(`Device: ${this.session.usb.name ?? ''} ${hex4(this.session.usb.vid)}:${hex4(this.session.usb.pid)} in ${this.session.mode} mode` +
      (this.session.usb.serial ? ` (SN: ${this.session.usb.serial})` : ''));
    return this.session;
  }

  async disconnect() {
    if (this.session) { await this.host.release(); this.session = null; }
  }

  #nolo() { return new NoloClient(this.session.transport, { log: this.log }); }
  #su() {
    const p = this.session.phonet;
    return new SuClient(this.session.transport, {
      isiIn: p.inEp, isiOut: p.outEp, rawOut: p.rawOutEp ? p.rawOutEp.address & 0x0f : 0, log: this.log,
    });
  }
  #cold() { return new ColdFlash(this.session.transport, { log: this.log }); }

  /** Phonet session with the SU handshake done. Handles sync mode (ADL) + re-enumeration. */
  async #suReady() {
    if (SYNC_MODE_PIDS.includes(this.session.usb.pid)) {
      throw new ProtocolError('The phone is in Sync / PC Suite mode. Use Flash (it reboots the phone into flash mode first) or put the phone into flash mode manually.');
    }
    const su = this.#su();
    try { await su.init(); } catch (e) {
      if (e instanceof SuError && e.timeout) {
        throw new ProtocolError('No softupd server answered. The phone is not running the APE algorithm; flash (or load ape-algo via NOLO) first.');
      }
      throw e;
    }
    return su;
  }

  async #reenumerate(kinds, why) {
    this.log(`Waiting for the device to come back (${why})...`);
    await this.host.release();
    this.session = null;
    this.session = await this.host.acquire(kinds, { timeoutMs: 120000 });
    this.log(`Device: ${hex4(this.session.usb.vid)}:${hex4(this.session.usb.pid)} in ${this.session.mode} mode`);
  }

  /**
   * Put a phone that is in Sync / PC Suite mode into flash mode (NOLO) using
   * the ADL protocol, like the original does before flashing.
   */
  async toFlashMode() {
    const s = this.session ?? await this.connect();
    if (s.mode === 'nolo' || s.mode === 'bootrom') { this.log('Already in flash mode.'); return s; }
    if (!SYNC_MODE_PIDS.includes(s.usb.pid)) {
      throw new ProtocolError('This USB mode has no ADL reboot. Power the phone off and plug it in while holding the flash-mode key.');
    }
    this.log('Sending ADL reboot (the phone will restart into flash mode)...');
    await this.#su().adlReboot();
    await this.#reenumerate(['nolo'], 'ADL reboot');
    return this.session;
  }

  // ------------------------------------------------------------ -i

  /** `flasher -i`: print and return what the current mode can tell us. */
  async identify() {
    const s = this.session ?? await this.connect();
    const info = { mode: s.mode, usb: s.usb };
    if (s.mode === 'bootrom') {
      // The boot ROM sends the ASIC ID once; keep it for a later cold flash.
      const asic = s.asic ?? (s.asic = await this.#cold().readAsicId());
      this.log(`ASIC: ${asic.chip} revision ${asic.revision}, HW variant: ${asic.secure}`);
      this.log(`Root key hash: ${asic.rootKeyHash}`);
      Object.assign(info, { asic, note: 'Cold-flash mode only exposes the ASIC ID. Boot a 2nd-stage image for more.' });
    } else if (s.mode === 'nolo') {
      const nolo = this.#nolo();
      const n = await nolo.init();
      Object.assign(info, { product: n.product, hwRev: n.hwRev, nolo: n.nolo?.text, swRelease: n.swRelease });
      try {
        const word = await nolo.getRdFlags();
        const flags = word & ~RD_FLAGS.master;
        info.rdMode = word & RD_FLAGS.master;
        info.rdFlags = rdFlagNames(flags);
        this.log(`The device is in ${info.rdMode ? 'R&D' : 'production'} mode`);
        this.log(`R&D flags ${info.rdMode ? '' : '(not effective) '}(0x${flags.toString(16).padStart(4, '0')}): ${info.rdFlags.join(',') || '(none)'}`);
      } catch (e) { this.log(`R&D query failed: ${e.message}`, 1); }
    } else if (SYNC_MODE_PIDS.includes(s.usb.pid)) {
      this.log('The phone is in Sync / PC Suite mode: the Phonet interface is claimable, but no flashing server is running.');
      this.log('Flash will reboot it into flash mode (NOLO) via the ADL protocol first. Nothing was changed.');
      Object.assign(info, { note: 'Sync / PC Suite mode (no softupd server). Reboot to flash mode is done by Flash.' });
      if (s.phonet) this.log(`ISI endpoints: IN ${s.phonet.inEp}, OUT ${s.phonet.outEp}, data interface ${s.phonet.dataInterface} alt ${s.phonet.dataAlt}`);
    } else {
      const su = await this.#suReady();
      Object.assign(info, su.info);
      try { info.battery = await su.batteryLevel(); this.log(`Battery level ${info.battery} %`); } catch { /* optional */ }
      try { info.rdMode = await su.getRdMode(); this.log(`R&D mode: ${info.rdMode || '(none)'}`); } catch { /* optional */ }
      this.log(`Supported images: ${su.info.supported.join(' ')}`);
    }
    return info;
  }

  // ------------------------------------------------------------ -f

  /**
   * Make sure the APE algorithm (SU server) is running. From cold-flash mode
   * this sends 2nd + ape-algo; from NOLO it loads ape-algo and boots it.
   */
  async enterSu(fiasco) {
    let s = this.session ?? await this.connect();
    if (s.mode === 'phonet' && SYNC_MODE_PIDS.includes(s.usb.pid)) {
      this.log('Device is in Sync and connect mode, sending ADL reboot (the phone will restart into flash mode).');
      await this.#su().adlReboot();
      await this.#reenumerate(['nolo'], 'ADL reboot');
      s = this.session;
    }
    if (s.mode === 'bootrom') {
      // With several 2nd images the original detects the HW by booting a
      // "1st" image (HWID query) first; that path is not implemented here.
      if (fiasco.images.filter((i) => i.type === '2nd').length > 1) {
        throw new ProtocolError('When cold flashing, please supply 1st image OR specify hardware type (this FIASCO has several 2nd images; HW detection via the 1st image is not supported).');
      }
      const second = pickImage(fiasco, '2nd', null, null);
      const ape = pickImage(fiasco, 'ape-algo', null, null);
      if (!second) throw new ProtocolError('You have to supply the 2nd image');
      if (!ape) throw new ProtocolError('You have to supply the ape-algo image');
      this.log('Cold flashing...');
      await this.#cold().run({
        second: readPadded(second, 0, second.paddedSize),
        apeAlgo: readPadded(ape, 0, ape.paddedSize),
        asic: s.asic,
      });
      await this.#reenumerate(['phonet'], 'cold flash');
    } else if (s.mode === 'nolo') {
      const nolo = this.#nolo();
      const info = await nolo.init();
      const ape = pickImage(fiasco, 'ape-algo', info.product, info.hwRev);
      if (!ape) throw new ProtocolError('APE algorithm has to be provided to flash all the subimages');
      this.#check();
      await nolo.sendImage(ape, (d, t) => this.progress({ label: 'ape-algo (NOLO)', done: d, total: t, state: 'loading' }));
      this.log('Switching protocol: booting the APE algorithm...');
      try { await nolo.boot(' '); } catch (e) { if (!(e instanceof TransportError)) throw e; }
      await this.#reenumerate(['phonet'], 'APE algorithm boot');
    }
    return this.session;
  }

  /**
   * Flash. fiasco = merged FIASCO ({images, swBlob}); selected = Set of image
   * indexes the user ticked. options: {noPreserve, reboot, eraseMmc, eraseUserData, skipBattery}
   */
  async flash(fiasco, selected, options = {}) {
    this.aborted = false;
    const chosen = fiasco.images.filter((i) => selected.has(i.index));
    if (!chosen.length) throw new ProtocolError('Nothing to flash!');
    const pickFrom = (type, product, hw) => pickImage({ images: chosen }, type, product, hw);

    await this.connect();
    const t0 = Date.now();
    await this.enterSu(fiasco);

    this.#check();
    const su = await this.#suReady();
    const { product, hwBuild } = su.info;
    try {
      await this.#flashViaSu(su, fiasco, chosen, pickFrom, product, hwBuild, options);
    } catch (e) {
      this.log(e instanceof Cancelled ? 'Cancelling update...' : `ERROR: ${e.message}`);
      if (e.detail) this.log(`=== Detailed error info=========\n${e.detail}\n================================`);
      throw e;
    }
    this.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (options.reboot !== false) {
      await this.#rebootSu(su);
    }
    this.log('Success');
  }

  async #flashViaSu(su, fiasco, chosen, pickFrom, product, hwBuild, options) {
    this.log(`Image SW version ${fiasco.swVersion || '<none>'}`);
    // Resolve which sub-image goes to which slot.
    const plan = [];
    for (const type of SU_SEQUENCE) {
      if (!chosen.some((i) => i.type === type)) continue;
      // The original drops tar whenever a rootfs is flashed.
      if (type === 'tar' && plan.some((i) => i.type === 'rootfs')) { this.log('Image tar skipped'); continue; }
      const img = pickFrom(type, product, hwBuild);
      if (!img) { this.log(`Image ${type} not present for this HW (${product} rev. ${hwBuild})`); continue; }
      if (su.info.supported.length && !su.info.supported.includes(type)) this.log(`WARNING: server does not list '${type}' as supported`);
      plan.push(img);
    }
    // cert-sw is flashed together with the main images when present in the file.
    if (!plan.some((i) => i.type === 'cert-sw') && plan.some((i) => MAIN_TYPES.has(i.type) || i.type === 'kernel')) {
      const cert = pickImage(fiasco, 'cert-sw', product, hwBuild);
      if (cert) plan.unshift(cert);
    }
    if (!plan.length) throw new ProtocolError('Nothing to flash!');

    if (!options.skipBattery) await this.#batteryGate(su);

    if (options.eraseMmc && options.eraseUserData) {
      this.log('Warning: user data may reside on MMC. In that case the MMC is unnecessarily erased twice.');
    }
    if (options.eraseMmc) await this.#erase(su, 'mmc', options.eraseMmc === true ? 'secure' : options.eraseMmc);
    if (options.eraseUserData) await this.#erase(su, 'userdata', 'secure');

    // Like the original, a failure from here up to the first image returns
    // at once: no error list and no FINISH_UPDATE.
    this.log('Begin update');
    await su.beginUpdate().catch(async (e) => {
      if (e.batteryLow) await this.#batteryLowMessage(su);
      throw e;
    });
    if (su.version >= 100) await su.setParam('/update/cmt/verify', '1');
    // Like the original, a failure here is reported but does not stop the update.
    if (su.version >= 104) {
      try { await su.setParam('/update/mmc/no_preserve', options.noPreserve ? '1' : '0'); } catch (e) {
        if (e.code === 'disconnected') throw e;
        this.log('Unable to set MMC no preserve');
      }
    }

    // Like the original's scheduler: a failed image skips the later images of
    // its group, the other groups carry on, and the update fails at the end.
    // A failed cert-sw stops at once. Nothing else may start before
    // xloader/secondary are done (the original would wait for a failed one
    // forever), so their failure skips everything after them.
    try {
      await this.#flashPlan(su, fiasco, plan);
    } catch (e) {
      // A failure once the images are under way: CANCEL_UPDATE only when the
      // user aborts, then the error list, then FINISH_UPDATE (FUN_00410f38).
      if (e instanceof Cancelled && su.version >= 101) await su.cancel();
      await this.#errorList(su);
      try { await su.finishUpdate(); } catch { /* ignore */ }
      throw e;
    }
    await su.finishUpdate();
  }

  async #flashPlan(su, fiasco, plan) {
    const notFlashed = [];
    const failedGroups = new Set();
    let skipRest = false;
    for (const img of plan) {
      this.#check();
      if (skipRest || failedGroups.has(suGroup(img))) {
        this.log(`Image ${img.type} skipped: an earlier image failed`);
        notFlashed.push(img.type);
        continue;
      }
      if (await this.#flashImage(su, img)) continue;
      if (img.type === 'cert-sw') throw new SuError('Update failed: cert-sw could not be flashed');
      notFlashed.push(img.type);
      failedGroups.add(suGroup(img));
      if (img.type === 'xloader' || img.type === 'secondary') skipRest = true;
    }
    if (notFlashed.length) throw new SuError(`Update failed: ${notFlashed.join(', ')} not flashed`);
    if (plan.some((i) => SW_REL_TYPES.has(i.type)) && fiasco.swBlob?.length) {
      this.log('Updating SW release');
      try { await su.updateSwRelease(fiasco.swBlob); } catch (e) { this.log(`SW release update failed: ${e.message}`); }
    }
  }

  /** `/update/error_list`, fetched after a failure (protocol >= 1.02). */
  async #errorList(su) {
    if (su.version <= 101) return;
    try {
      const list = await su.getParam('/update/error_list');
      if (list) this.log(`Fetching error list:\n========================================\n${list}\n========================================`);
    } catch { /* ignore */ }
  }

  /** What the original prints when BEGIN_UPDATE / BEGIN_ERASE report a low battery. */
  async #batteryLowMessage(su) {
    this.log('BATTERY IS LOW. DEVICE IS NOW CHARGING.');
    try { this.log(`Charging battery, ${await su.batteryLevel()} % battery level (${MIN_BATTERY} % required)`); } catch { /* ignore */ }
    this.log('Please, do not detach the USB cable. Just wait a few minutes and then retry.');
  }

  /** BEGIN_ERASE; on failure the original fetches the error list, or explains a low battery. */
  async #erase(su, what, method) {
    try { await su.erase(what, method); } catch (e) {
      if (e.code === 'disconnected') throw e;
      if (e.batteryLow) await this.#batteryLowMessage(su);
      else await this.#errorList(su);
      throw e;
    }
  }

  async #batteryGate(su) {
    let level;
    try { level = await su.batteryLevel(); } catch { this.log('Unable to get SU_PARAM_BATTERY_LEVEL'); return; }
    if (level <= MIN_BATTERY) {
      throw new ProtocolError(`BATTERY IS LOW (${level} %, ${MIN_BATTERY + 1} % required). Charge the device with the USB cable attached and retry.`);
    }
    this.log(`Battery level ${level} %, continuing.`);
  }

  /**
   * Flash one image. Returns false when the image failed while its data was
   * sent or programmed (the update may go on with other groups); throws when
   * the whole update has to stop, as the original does for BEGIN_IMAGE_UPDATE
   * and FINISH_IMAGE_UPDATE failures.
   */
  async #flashImage(su, img) {
    const label = img.type;
    this.log(`Image ${img.type} (${img.size >> 10} kB)${img.version ? ` version ${img.version}` : ''}`);
    const { pipe, blockSize } = await su.beginImage(img.blob);
    this.log(`Pipe id ${pipe}, block size ${blockSize}`, 2);
    // Like the original: the aux pipe serves eMMC-group images (eMMC rootfs, mmc), never tar.
    // If it can't be set up, the original silently falls back to FEED_DATA_BLOCK.
    let raw = ((img.type === 'rootfs' && img.emmc) || img.type === 'mmc') && su.rawOut > 0;
    if (raw) {
      try { await su.setupAuxPipe(pipe); this.log('Using raw USB data pipe', 1); } catch (e) {
        if (e.code === 'disconnected') throw e;
        this.log(`Raw data pipe unavailable (${e.message}); sending the data in FEED_DATA_BLOCK messages`, 1);
        raw = false;
      }
    }

    const total = img.paddedSize;
    const maxChunk = 0x100000 - (0x100000 % blockSize);
    let sent = 0;
    let lastPoll = 0;
    let lastLog = 0;
    const start = Date.now();
    let st = { stateName: 'init', done: 0, total };
    const poll = async () => {
      st = await su.getStatus(pipe);
      if (st.failed) throw new SuError('Update failed!');
      lastPoll = Date.now();
      const secs = Math.max((Date.now() - start) / 1000, 0.001);
      this.progress({ label, done: sent, total, state: st.stateName, flashed: st.done, flashTotal: st.total, speed: Math.round(sent / 1024 / secs) });
      if (Date.now() - lastLog > 2000) {
        lastLog = Date.now();
        this.log(`[${st.stateName.padEnd(9)} ${String(Math.floor(total ? (sent * 100) / total : 100)).padStart(3)} %] ${label.padEnd(10)} ${sent >> 10} / ${total >> 10} kB  ${Math.round(sent / 1024 / secs)} kB/s`, 0);
      }
    };

    try {
      while (sent < total) {
        this.#check();
        if (Date.now() - lastPoll >= 250) await poll();
        const free = await su.waitForBuffer(pipe, 250);
        if (!free) continue;
        const n = Math.min(free, maxChunk, total - sent);
        await su.prepareBlock(pipe, n);
        const chunk = readPadded(img, sent, n);
        if (raw) {
          for (let o = 0; o < n; o += 0x40000) await su.t.bulkOut(su.rawOut, chunk.subarray(o, Math.min(o + 0x40000, n)));
        } else {
          for (let o = 0; o < n; o += 0x8000) await su.feed(pipe, chunk.subarray(o, Math.min(o + 0x8000, n)));
        }
        sent += n;
        this.progress({ label, done: sent, total, state: st.stateName, flashed: st.done, flashTotal: st.total });
      }

      // wait for the server to finish programming
      for (;;) {
        this.#check();
        await poll();
        if (st.state === 0x10) break;
        await sleep(250);
      }
    } catch (e) {
      if (e instanceof Cancelled || e.code === 'disconnected') throw e;
      this.log(`Image ${img.type} failed: ${e.message}`);
      this.progress({ label, done: sent, total, state: 'failed' });
      return false;
    }
    await su.finishImage(pipe);
    this.progress({ label, done: total, total, state: 'finished' });
    this.log(`[finished  100 %] ${label.padEnd(10)} ${total >> 10} kB`);
    return true;
  }

  async #rebootSu(su) {
    this.log('Rebooting device...');
    try { await su.stateChange('reboot'); } catch (e) { if (!(e instanceof TransportError)) throw e; }
  }

  // ------------------------------------------------- reboot / boot / misc

  /** `flasher -R` */
  async reboot() {
    const s = this.session ?? await this.connect();
    // The original never talks to the boot ROM except to cold flash.
    if (s.mode === 'bootrom') throw new ProtocolError('Reboot is not available in cold-flash mode. Unplug the phone to leave it.');
    if (s.mode === 'nolo') await this.#nolo().reboot();
    else await this.#rebootSu(await this.#suReady());
    this.log('Success');
  }

  /** NOLO only: boot the kernel stored in flash (optionally with a command line). */
  async boot(cmdline = null) {
    const s = this.session ?? await this.connect(['nolo']);
    if (s.mode !== 'nolo') throw new ProtocolError('Switch mode is not implemented (boot needs NOLO mode)');
    await this.#nolo().boot(cmdline);
  }

  /**
   * Where to change R&D settings, like the original: with a FIASCO that
   * carries ape-algo, boot it and use SU; otherwise NOLO can do it itself
   * when its version allows (noloCanSetRd). Returns {nolo} or {su}.
   */
  async #rdTarget(fiasco, what) {
    let s = this.session ?? await this.connect(['nolo', 'phonet', 'bootrom']);
    const hasApe = !!fiasco?.images.some((i) => i.type === 'ape-algo');
    if (s.mode === 'nolo' && !hasApe) {
      const nolo = this.#nolo();
      if (noloCanSetRd((await nolo.init()).nolo)) return { nolo };
    }
    if (s.mode !== 'phonet' && hasApe) s = await this.enterSu(fiasco);
    if (s.mode !== 'phonet') {
      throw new ProtocolError(`Method is not supported in the current mode. Please, provide the APE flashing algorithm to set the R&D ${what} (load a firmware file that contains ape-algo).`);
    }
    return { su: await this.#suReady() };
  }

  async setRdMode(on, fiasco = null) {
    const { nolo, su } = await this.#rdTarget(fiasco, 'mode');
    // Disabling clears every flag, like the original ("-{*}" / delete 0xffff).
    if (nolo) await nolo.setRdFlags(on ? { add: RD_FLAGS.master } : { del: 0xffff });
    else await su.setRdMode(on ? { add: ['master'] } : { removeAll: true });
    this.log(`The device is now in ${on ? 'R&D' : 'production'} mode`);
  }

  /** flagList: "no-lifeguard-reset,serial-console"; mode 'set' (add) | 'clear' (remove) */
  async setRdFlags(flagList, mode = 'set', fiasco = null) {
    // Like the original's --set-rd-flags / --clear-rd-flags: a flag list is
    // required and "master" (the R&D mode itself) is not accepted.
    const mask = parseRdFlags(flagList ?? '');
    if (!mask || mask & RD_FLAGS.master) {
      throw new ProtocolError(`Give one or more R&D flags. Possible R&D flags: ${Object.keys(RD_FLAGS).filter((k) => k !== 'master').join(', ')}`);
    }
    const { nolo, su } = await this.#rdTarget(fiasco, 'flags');
    if (nolo) {
      await nolo.setRdFlags(mode === 'set' ? { add: mask } : { del: mask });
      return;
    }
    const names = rdFlagNames(mask);
    await su.setRdMode(mode === 'set' ? { add: names } : { remove: names });
  }

  async queryRdMode() {
    const info = await this.identify();
    return { rdMode: info.rdMode, rdFlags: info.rdFlags };
  }

  async erase(what /* 'mmc' | 'userdata' */, fiasco = null, method = 'secure') {
    let s = this.session ?? await this.connect();
    if (s.mode !== 'phonet' && fiasco) s = await this.enterSu(fiasco);
    if (s.mode !== 'phonet') throw new ProtocolError('Erase not supported. Use APE flashing algorithm (load a firmware file that contains ape-algo).');
    const su = await this.#suReady();
    await this.#batteryGate(su);
    await this.#erase(su, what, method);
  }
}

const hex4 = (n) => n.toString(16).padStart(4, '0');
