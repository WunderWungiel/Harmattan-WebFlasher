// UI glue. All device logic lives in flasher.js / protocol.js.
import { Flasher, SU_FLASH_ORDER, Cancelled } from './flasher.js';
import { parseFiasco, mergeFiascos, describeProducts, verifyImageHash, plainImage, PLAIN_TYPES, pickImage } from './fiasco.js';
import { WebUsbHost } from './webusb.js';
import { RD_FLAGS } from './protocol.js';

const $ = (id) => document.getElementById(id);
const hex4 = (n) => n.toString(16).padStart(4, '0');

// ---------------------------------------------------------------- log

const logEl = $('log');
const logLines = [];
let verbosity = 0;

function log(msg, level = 0) {
  const line = { msg: String(msg), level };
  logLines.push(line);
  if (level <= verbosity) appendLine(line);
}
function appendLine({ msg, level }) {
  const div = document.createElement('div');
  if (level > 0) div.className = 'v';
  else if (/^(ERROR|Failed|Unable)|failed|Update failed/i.test(msg)) div.className = 'e';
  else if (/^Success|^Done|^Erase done/.test(msg)) div.className = 's';
  div.textContent = msg;
  logEl.append(div);
  logEl.scrollTop = logEl.scrollHeight;
}
function rerenderLog() {
  logEl.textContent = '';
  for (const l of logLines) if (l.level <= verbosity) appendLine(l);
}
$('verbosity').addEventListener('change', (e) => { verbosity = +e.target.value; rerenderLog(); });
$('btn-clearlog').onclick = () => { logLines.length = 0; logEl.textContent = ''; };
$('btn-copy').onclick = () => navigator.clipboard?.writeText(logLines.map((l) => l.msg).join('\n'));
$('btn-save').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([logLines.map((l) => l.msg).join('\n') + '\n'], { type: 'text/plain' }));
  a.download = `flasher-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// ----------------------------------------------------------- progress

function progress({ label, done, total, state, flashed, flashTotal, speed }) {
  const pct = total ? Math.min(100, (done * 100) / total) : 0;
  $('bar').style.width = `${pct}%`;
  $('bar').classList.remove('err');
  $('bar').setAttribute('aria-valuenow', Math.round(pct));
  const kb = (n) => `${(n / 1024) | 0} kB`;
  let t = `${label}: ${state ?? ''} ${pct.toFixed(0)} % (${kb(done)} / ${kb(total)})`;
  if (flashTotal) t += `, flashed ${kb(flashed)}`;
  if (speed) t += `, ${speed} kB/s`;
  $('progress-text').textContent = t;
}
function resetProgress(text = 'idle', err = false) {
  $('bar').style.width = '0';
  $('bar').classList.toggle('err', err);
  $('progress-text').textContent = text;
}

// ------------------------------------------------------------- state

if (!WebUsbHost.supported || !isSecureContext) {
  const b = $('unsupported');
  b.hidden = false;
  b.textContent = !isSecureContext
    ? 'WebUSB needs a secure context: open this page via https:// or http://localhost.'
    : 'This browser does not support WebUSB. Use a Chromium-based browser (Chrome, Edge, Chromium).';
}

const host = new WebUsbHost({
  log,
  onWaiting: (on) => { $('waiting').hidden = !on; },
});
const flasher = new Flasher(host, { log, progress });

let fiasco = null; // merged
let files = [];
const extras = new Map(); // type -> plain image supplied by the user
let busy = false;

const deviceButtons = ['btn-identify', 'btn-flashmode', 'btn-disconnect', 'btn-reboot', 'btn-boot', 'btn-rd-query', 'btn-rd-on', 'btn-rd-off', 'btn-rd-set', 'btn-rd-clear', 'btn-erase-mmc', 'btn-erase-user'];

function refresh() {
  const connected = !!flasher.session;
  for (const id of deviceButtons) $(id).disabled = busy || !connected;
  $('btn-boot').disabled = busy || flasher.session?.mode !== 'nolo';
  $('btn-connect').disabled = busy;
  $('btn-wait').disabled = busy || connected;
  $('btn-flashmode').disabled = busy || !connected || flasher.session.mode === 'nolo' || flasher.session.mode === 'bootrom';
  $('btn-flash').disabled = busy || !connected || !selectedIndexes().size;
  $('btn-abort').disabled = !busy;
  $('btn-clear').disabled = !fiasco;
  $('file').disabled = busy;
  for (const i of document.querySelectorAll('#plain-files input[type=file]')) i.disabled = busy;
  renderDevice();
}

function renderDevice() {
  const dl = $('device-info');
  const s = flasher.session;
  dl.hidden = !s;
  if (!s) return;
  const rows = [
    ['Mode', s.mode],
    ['USB ID', `${hex4(s.usb.vid)}:${hex4(s.usb.pid)}`],
    ['Product', s.usb.name || '–'],
    ['Serial', s.usb.serial || '–'],
  ];
  if (s.phonet) rows.push(['ISI endpoints', `IN ${s.phonet.inEp}, OUT ${s.phonet.outEp}` + (s.phonet.rawOutEp ? `, raw OUT ${s.phonet.rawOutEp.address & 0xf}` : '')]);
  if (lastInfo?.product) rows.push(['Device', `${lastInfo.product} rev. ${lastInfo.hwRev ?? lastInfo.hwBuild ?? '?'}`]);
  if (lastInfo?.nolo) rows.push(['NOLO', lastInfo.nolo]);
  if (lastInfo?.swRelease) rows.push(['SW release', lastInfo.swRelease]);
  if (lastInfo?.protocol) rows.push(['softupd', `${Math.floor(lastInfo.protocol / 100)}.${String(lastInfo.protocol % 100).padStart(2, '0')}`]);
  if (lastInfo?.battery != null) rows.push(['Battery', `${lastInfo.battery} %`]);
  if (lastInfo?.asic) rows.push(['ASIC', `${lastInfo.asic.chip} rev ${lastInfo.asic.revision}, ${lastInfo.asic.secure}`]);
  dl.textContent = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
}
let lastInfo = null;

async function run(label, fn, { confirmText } = {}) {
  if (busy) return;
  if (confirmText && !confirm(typeof confirmText === 'function' ? confirmText() : confirmText)) return;
  busy = true;
  refresh();
  resetProgress(label);
  try {
    await fn();
    if (!/^(Flashing|Erasing)/.test(label)) resetProgress('idle');
  } catch (e) {
    if (e instanceof Cancelled) log('Aborted.');
    else log(`ERROR: ${e.message ?? e}`);
    resetProgress(e instanceof Cancelled ? 'aborted' : `failed: ${e.message ?? e}`, true);
    if (e.code === 'disconnected') await dropSession();
  } finally {
    busy = false;
    refresh();
  }
}

async function dropSession() {
  try { await flasher.disconnect(); } catch { /* gone */ }
  flasher.session = null;
  lastInfo = null;
}

// ----------------------------------------------------------- device UI

$('btn-connect').onclick = () => run('Connecting', async () => {
  let dev;
  try { dev = await host.requestDevice(); } catch (e) {
    if (e.name === 'NotFoundError') return; // dialog dismissed
    throw e;
  }
  log(`Selected ${dev.productName || 'USB device'} (${hex4(dev.vendorId)}:${hex4(dev.productId)})`);
  await dropSession();
  await flasher.connect(['nolo', 'bootrom', 'phonet'], { timeoutMs: 5000 });
});

$('btn-grant').onclick = async () => {
  try { const d = await host.requestDevice(); log(`Granted access to ${hex4(d.vendorId)}:${hex4(d.productId)}`); } catch { /* dismissed */ }
};

$('btn-wait').onclick = () => run('Waiting for device', async () => {
  log('Waiting for a device that was already granted access. Plug in the phone in flash mode; if it does not show up, use Connect… once.');
  await flasher.connect(['nolo', 'bootrom', 'phonet'], { timeoutMs: 10 * 60 * 1000 });
});
$('btn-flashmode').onclick = () => run('Rebooting to flash mode', async () => { lastInfo = null; await flasher.toFlashMode(); },
  { confirmText: 'Send the ADL reboot? The phone restarts into flash mode (NOLO).' });

$('btn-identify').onclick = () => run('Identifying', async () => {
  lastInfo = await flasher.identify();
});
$('btn-disconnect').onclick = () => run('Disconnecting', async () => { await dropSession(); log('Disconnected.'); });

navigator.usb?.addEventListener('disconnect', (e) => {
  log(`USB device ${hex4(e.device.vendorId)}:${hex4(e.device.productId)} disconnected`, 1);
  if (!busy && flasher.session && host.device === e.device) { host.device = null; flasher.session = null; lastInfo = null; log('Device disconnected.'); refresh(); }
});
navigator.usb?.addEventListener('connect', (e) => log(`USB device ${hex4(e.device.vendorId)}:${hex4(e.device.productId)} connected`, 1));

// ------------------------------------------------------------ firmware

$('file').addEventListener('change', async (e) => {
  const picked = [...e.target.files];
  e.target.value = '';
  const parsed = [];
  for (const f of picked) {
    try {
      const fi = parseFiasco(new Uint8Array(await f.arrayBuffer()));
      log(`Reading SW image from ${f.name}`);
      log(`  ${fi.name || '(unnamed)'}  SW version ${fi.swVersion || '<none>'}, ${fi.images.length} sub-images`);
      parsed.push({ file: f.name, fiasco: fi });
    } catch (err) {
      log(`ERROR: ${f.name}: ${err.message}`);
    }
  }
  if (!parsed.length) return;
  const before = files;
  files = [...files, ...parsed];
  if (!rebuild()) files = before;
  renderImages();
  refresh();
});
$('btn-clear').onclick = () => { files = []; extras.clear(); fiasco = null; renderPlainFiles(); renderImages(); refresh(); };

/** Merge FIASCO files + individual images; false (and a log line) if the combination is refused. */
function rebuild() {
  if (!files.length && !extras.size) { fiasco = null; return true; }
  try {
    const m = mergeFiascos(files, [...extras.values()]);
    for (const w of m.warnings) log(w);
    fiasco = m;
    return true;
  } catch (err) {
    log(`ERROR: ${err.message}`);
    return false;
  }
}

// ---- Advanced: individual image files (-a -k -L -n -r --cmt-*)

const PLAIN_HELP = {
  'ape-algo': 'APE algorithm (FIASCO or plain)', kernel: 'kernel', moslo: 'moslo', initfs: 'initfs (only loaded in NOLO mode, not flashed over SU)',
  rootfs: 'root filesystem', 'cmt-2nd': 'CMT 2nd', 'cmt-algo': 'CMT algorithm', 'cmt-mcusw': 'CMT MCUSW',
};

function renderPlainFiles() {
  const box = $('plain-files');
  box.textContent = '';
  for (const type of PLAIN_TYPES) {
    const name = document.createElement('span'); name.className = 'name'; name.textContent = type; name.title = PLAIN_HELP[type];
    const sel = document.createElement('span'); sel.className = 'sel';
    const cur = extras.get(type);
    sel.textContent = cur ? `${cur.source} (${fmtSize(cur.size)})` : PLAIN_HELP[type];
    const cell = document.createElement('span');
    const lab = document.createElement('label'); lab.className = 'btn';
    const input = document.createElement('input'); input.type = 'file'; input.disabled = busy;
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (f) await addPlain(type, f);
    });
    const txt = document.createElement('span'); txt.textContent = cur ? 'Replace…' : 'Choose…';
    lab.append(input, txt);
    cell.append(lab);
    if (cur) {
      const rm = document.createElement('button'); rm.textContent = '×'; rm.title = 'remove'; rm.style.marginLeft = '6px';
      rm.onclick = () => { extras.delete(type); rebuild(); renderPlainFiles(); renderImages(); refresh(); };
      cell.append(rm);
    }
    box.append(name, sel, cell);
  }
}

async function addPlain(type, file) {
  const data = new Uint8Array(await file.arrayBuffer());
  try {
    let img;
    if (type === 'ape-algo' && data[0] === 0xb4) {
      const fi = parseFiasco(data);
      const ape = pickImage(fi, 'ape-algo', null, null);
      if (!ape) throw new Error('no ape-algo image in this FIASCO');
      log('Picked ape-algo from a FIASCO file');
      img = { ...ape, source: file.name };
    } else {
      img = plainImage(type, data, file.name);
    }
    log(`Image option ${type} "${file.name}" (${fmtSize(img.size)})`, 1);
    const prev = extras.get(type);
    extras.set(type, img);
    if (!rebuild()) { if (prev) extras.set(type, prev); else extras.delete(type); }
  } catch (err) {
    log(`ERROR: ${file.name}: ${err.message}`);
  }
  renderPlainFiles(); renderImages(); refresh();
}

const LOADER_TYPES = new Set(['2nd', '1st', 'ape-algo', 'initfs', 'initrd']);
const flashable = (img) => SU_FLASH_ORDER.includes(img.type);

function renderImages() {
  const tbl = $('images');
  const body = tbl.tBodies[0];
  body.textContent = '';
  tbl.hidden = !fiasco;
  $('fw-summary').textContent = fiasco ? `${fiasco.images.length} sub-images, SW ${fiasco.swVersion || '?'}` : '';
  if (!fiasco) return;
  for (const img of fiasco.images) {
    const tr = document.createElement('tr');
    if (!flashable(img)) tr.className = 'loader';
    const td = (text, cls) => { const c = document.createElement('td'); c.textContent = text; if (cls) c.className = cls; tr.append(c); return c; };
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.dataset.index = img.index; cb.checked = flashable(img); cb.disabled = !flashable(img);
    cb.addEventListener('change', refresh);
    cb.setAttribute('aria-label', `flash ${img.type}`);
    td('').append(cb);
    td(img.type + (LOADER_TYPES.has(img.type) ? ' (loader)' : ''));
    td(fmtSize(img.size), 'num');
    td(img.version || '–');
    td(describeProducts(img).join('\n') || 'any', '').style.whiteSpace = 'pre-line';
    const h = td('…');
    td(img.source);
    // hash check off the main path
    setTimeout(() => {
      const ok = verifyImageHash(img);
      h.textContent = ok ? 'ok' : 'mismatch';
      h.className = ok ? 'ok' : 'bad';
    }, 0);
    body.append(tr);
  }
}
const fmtSize = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : `${Math.ceil(n / 1024)} kB`);
const selectedIndexes = () => new Set([...document.querySelectorAll('#images input[type=checkbox]:checked')].map((c) => +c.dataset.index));

// ------------------------------------------------------------- actions

const WARRANTY = 'WARNING: This tool is intended for professional use only. Using it may result in permanently damaging your device or losing the warranty.\n\nContinue?';

const eraseOpts = () => ({
  eraseMmc: $('opt-erase-mmc').checked ? $('erase-method').value : false,
  eraseUserData: $('opt-erase-user').checked,
});
const flashWarning = () => WARRANTY.replace(/\n\nContinue\?$/, '') +
  (eraseOpts().eraseMmc ? `\n\nThe eMMC will be erased (${eraseOpts().eraseMmc}) first.` : '') +
  (eraseOpts().eraseUserData ? '\n\nUser data (eMMC and swap) will be erased first and the device lock reset.' : '') +
  ($('opt-nopreserve').checked ? '\n\nThe eMMC will be repartitioned; its contents are not preserved.' : '') + '\n\nContinue?';

$('btn-flash').onclick = () => run('Flashing', async () => {
  await flasher.flash(fiasco, selectedIndexes(), {
    reboot: $('opt-reboot').checked,
    noPreserve: $('opt-nopreserve').checked,
    skipBattery: $('opt-skipbat').checked,
    ...eraseOpts(),
  });
  lastInfo = null;
  flasher.session = null;
  await host.release();
  resetProgress('flashing finished');
}, { confirmText: () => flashWarning() });

$('btn-abort').onclick = () => { flasher.abort(); log('Abort requested, finishing the current step...'); };
$('btn-reboot').onclick = () => run('Rebooting', async () => { await flasher.reboot(); await dropSession(); });
$('btn-boot').onclick = () => run('Booting', async () => {
  const cmdline = prompt('Kernel command line (empty = default):', '') ?? null;
  if (cmdline === null) return;
  await flasher.boot(cmdline || null);
  await dropSession();
});

$('rd-flag-list').textContent = Object.keys(RD_FLAGS).filter((k) => k !== 'master').join(', ');
$('btn-rd-query').onclick = () => run('Querying R&D mode', async () => { lastInfo = await flasher.identify(); });
$('btn-rd-on').onclick = () => run('Enabling R&D mode', () => flasher.setRdMode(true), { confirmText: WARRANTY });
$('btn-rd-off').onclick = () => run('Disabling R&D mode', () => flasher.setRdMode(false));
$('btn-rd-set').onclick = () => run('Setting R&D flags', () => flasher.setRdFlags($('rd-flags').value.trim(), 'set'), { confirmText: WARRANTY });
$('btn-rd-clear').onclick = () => run('Clearing R&D flags', () => flasher.setRdFlags($('rd-flags').value.trim(), 'clear'));
$('btn-erase-mmc').onclick = () => run('Erasing MMC', () => flasher.erase('mmc', fiasco, $('erase-method').value), { confirmText: `This erases the whole eMMC (${$('erase-method').value}). ` + WARRANTY });
$('btn-erase-user').onclick = () => run('Erasing user data', () => flasher.erase('userdata', fiasco), { confirmText: 'This erases all user data and resets the device lock. ' + WARRANTY });

renderPlainFiles();
refresh();
log('N9/N950 web flasher ready. Put the phone into flash mode, then click Connect.');
