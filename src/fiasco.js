// FIASCO firmware container parser (PROTOCOL.md section 6). Pure, no DOM.
import { ProtocolError, cstr, imageHash } from './protocol.js';

const SUBBLOCK_FILE = 0x2e;
const SUBBLOCK_FILE64 = 0x5c;
const SUBBLOCK_VERSION = 0x31;
const SUBBLOCK_PRODUCT = 0x32;
const SUBBLOCK_LAYOUT = 0x33;
const MAX_BLOB = 1024;

/**
 * Parse a FIASCO file. `input` is an ArrayBuffer or Uint8Array.
 * Returns {name, swVersion, swBlob, images[]}. Image data are views, not copies.
 */
export function parseFiasco(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 9 || u8[0] !== 0xb4) throw new ProtocolError('Invalid FIASCO file header');

  const hdrLen = dv.getUint32(1);
  const hdrEnd = 5 + hdrLen;
  // The original also caps the header at 0x200 bytes (FUN_0040643f).
  if (hdrLen < 4 || hdrEnd > u8.length || hdrEnd > 0x200) throw new ProtocolError('FIASCO image header size mismatch');

  const count = dv.getUint32(5);
  let p = 9;
  let name = '';
  let swVersion = '';
  for (let i = 0; i < count; i++) {
    if (p + 2 > hdrEnd) throw new ProtocolError('Error reading FIASCO header');
    const id = u8[p];
    const len = u8[p + 1];
    if (p + 2 + len > hdrEnd) throw new ProtocolError('FIASCO subblock length mismatch');
    const data = u8.subarray(p + 2, p + 2 + len);
    if (id === 0xe8) name = cstr(data);
    else if (id === SUBBLOCK_VERSION) swVersion = cstr(data);
    p += 2 + len;
  }
  const swBlob = u8.slice(9, hdrEnd);

  const images = [];
  p = hdrEnd;
  while (p < u8.length) {
    if (u8[p] !== 0x54) throw new ProtocolError(`Invalid FIASCO subimage id (${u8[p].toString(16).padStart(2, '0')}) at offset ${p}`);
    const n = u8[p + 1];
    let q = p + 2;
    const subblocks = [];
    for (let i = 0; i < n; i++) {
      if (q + 2 > u8.length) throw new ProtocolError('Error reading subimage header');
      const id = u8[q];
      const len = u8[q + 1];
      if (q + 2 + len > u8.length) throw new ProtocolError('FIASCO subblock length mismatch');
      subblocks.push({ id, data: u8.subarray(q + 2, q + 2 + len) });
      q += 2 + len;
    }
    const checksum = u8[q++];

    let fd = subblocks.find((b) => b.id === SUBBLOCK_FILE);
    let wide = false;
    if (!fd) { fd = subblocks.find((b) => b.id === SUBBLOCK_FILE64); wide = true; }
    if (!fd) throw new ProtocolError('FIASCO file data subblock not found');
    if (fd.data.length !== (wide ? 0x21 : 0x19)) throw new ProtocolError('FIASCO file data subblock length mismatch');
    const f = new DataView(fd.data.buffer, fd.data.byteOffset, fd.data.byteLength);
    const type = cstr(fd.data.subarray(5, 17));
    const size = wide ? Number(f.getBigUint64(17)) : f.getUint32(17);
    if (q + size > u8.length) throw new ProtocolError('FIASCO subimage data length mismatch');

    const blob = serializeSubblocks(subblocks);
    images.push({
      index: images.length,
      type,
      size,
      paddedSize: (size + 127) & ~127,
      hash: f.getUint16(3),
      asic: fd.data[0], devType: fd.data[1], devIdx: fd.data[2],
      checksum,
      version: cstr(subblocks.find((b) => b.id === SUBBLOCK_VERSION)?.data ?? new Uint8Array(0)),
      products: subblocks.filter((b) => b.id === SUBBLOCK_PRODUCT).map((b) => parseProduct(b.data)),
      layout: subblocks.find((b) => b.id === SUBBLOCK_LAYOUT) ? cstr(subblocks.find((b) => b.id === SUBBLOCK_LAYOUT).data) : null,
      emmc: subblocks.some((b) => b.id === SUBBLOCK_LAYOUT),
      subblocks,
      blob,
      offset: q,
      data: u8.subarray(q, q + size),
    });
    p = q + size;
  }
  return { name, swVersion, swBlob, images };
}

function parseProduct(d) {
  if (d.length < 16) throw new ProtocolError('Invalid FIASCO product/HW rev subblock');
  const product = cstr(d.subarray(0, 16));
  const hwrevs = [];
  for (let o = 16; o + 8 <= d.length; o += 8) hwrevs.push(cstr(d.subarray(o, o + 8)));
  return { product, hwrevs };
}

/** {id,len,data}* with no framing, as sent in BEGIN_IMAGE_UPDATE / NOLO SEND_IMAGE. */
export function serializeSubblocks(subblocks) {
  const total = subblocks.reduce((n, b) => n + 2 + b.data.length, 0);
  if (total > MAX_BLOB) throw new ProtocolError('Subblock list exceeds 1024 in size');
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of subblocks) {
    out[o++] = b.id; out[o++] = b.data.length; out.set(b.data, o); o += b.data.length;
  }
  return out;
}

/** Image types that can be supplied as individual files (flasher -a -k -L -n -r --cmt-*). */
export const PLAIN_TYPES = ['ape-algo', 'kernel', 'moslo', 'initfs', 'rootfs', 'cmt-2nd', 'cmt-algo', 'cmt-mcusw'];

/**
 * Wrap a plain image the way the original does: one file-data subblock
 * (asic 1, NAND, idx 0, hash, 12-byte type name, size, load address 0).
 */
export function plainImage(type, data, source = '') {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (type === 'rootfs' && ((u8[0] === 0x1f && u8[1] === 0x8b) || new TextDecoder('latin1').decode(u8.subarray(257, 262)) === 'ustar')) {
    throw new ProtocolError('rootfs in this format (tar/gzip) requires a layout file - you need to use fiasco-gen');
  }
  const fd = new Uint8Array(0x19);
  const dv = new DataView(fd.buffer);
  fd.set([1, 1, 0], 0);
  dv.setUint16(3, imageHash(u8));
  fd.set(new TextEncoder().encode(type).subarray(0, 12), 5);
  dv.setUint32(17, u8.length);
  const subblocks = [{ id: SUBBLOCK_FILE, data: fd }];
  return {
    type, size: u8.length, paddedSize: (u8.length + 127) & ~127, hash: imageHash(u8),
    asic: 1, devType: 1, devIdx: 0, checksum: 0, version: '', products: [], layout: null, emmc: false,
    subblocks, blob: serializeSubblocks(subblocks), offset: 0, data: u8, source, plain: true,
  };
}

/**
 * Combine FIASCO files and user-supplied plain images into one image list.
 * Like the original: at most one FIASCO may carry a SW version, and a
 * user-supplied image replaces FIASCO images of the same type.
 * Returns {..., warnings[]}.
 */
export function mergeFiascos(list, extras = []) {
  if (list.filter((x) => x.fiasco.swVersion).length > 1) {
    throw new ProtocolError('Refusing to read more than one versioned FIASCO image');
  }
  const warnings = [];
  const images = [];
  const overridden = new Set(extras.map((e) => e.type));
  for (const { file, fiasco } of list) {
    for (const im of fiasco.images) {
      if (overridden.has(im.type)) { warnings.push(`Warning: ignoring subimage '${im.type}' from file '${file}'`); continue; }
      images.push({ ...im, index: images.length, source: file });
    }
  }
  for (const e of extras) images.push({ ...e, index: images.length });
  const first = list.find((x) => x.fiasco.swVersion)?.fiasco ?? list[0]?.fiasco;
  return {
    name: first?.name ?? '', swVersion: first?.swVersion ?? '', swBlob: first?.swBlob ?? new Uint8Array(0),
    images, warnings,
  };
}

/**
 * Does `img` apply to this device? Same rules as the original: no product
 * subblock = generic; a product entry without HW revisions covers every
 * revision; otherwise the HW revision must be listed (and known).
 */
export const imageMatches = (img, product, hwrev) =>
  !img.products.length ||
  img.products.some((pr) => pr.product === product && (!pr.hwrevs.length || (hwrev != null && pr.hwrevs.includes(String(hwrev)))));

/**
 * Choose the sub-image of `type` for this device: the first one in file
 * order that matches. With no device info (product == null, e.g. cold
 * flash) the first image of that type is taken.
 */
export function pickImage(fiasco, type, product, hwrev) {
  const same = fiasco.images.filter((i) => i.type === type);
  if (product == null) return same[0] ?? null;
  return same.find((i) => imageMatches(i, product, hwrev)) ?? null;
}

/**
 * `n` bytes of the image starting at `offset`, as the original reads them:
 * the payload is rounded up to `paddedSize` and the tail is filled with 0xFF.
 */
export function readPadded(img, offset, n) {
  const out = new Uint8Array(n).fill(0xff);
  if (offset < img.size) out.set(img.data.subarray(offset, Math.min(offset + n, img.size)));
  return out;
}

export function verifyImageHash(img) {
  return imageHash(img.data) === img.hash;
}

/** Human readable "Valid for RM-696: 2101, 2102" lines. */
export function describeProducts(img) {
  return img.products.map((p) => `${p.product}: ${p.hwrevs.join(', ')}`);
}

// --------------------------------------------------------------- builder
// Small writer, used by the tests (and handy for generating fixtures).

export function buildFiasco({ name = 'OSSO UART+USB', swVersion = 'TEST_1.0', images = [] }) {
  const enc = (s) => new TextEncoder().encode(s + '\0');
  const block = (id, data) => Uint8Array.from([id, data.length, ...data]);
  const hdrBlocks = [block(0xe8, enc(name)), block(0x31, enc(swVersion))];
  const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of p) { o.set(x, k); k += x.length; } return o; };
  const hdrBody = cat(Uint8Array.of(0, 0, 0, hdrBlocks.length), ...hdrBlocks);
  const parts = [Uint8Array.of(0xb4), Uint8Array.from(be32(hdrBody.length)), hdrBody];
  for (const im of images) {
    const fd = new Uint8Array(0x19);
    fd.set([1, 1, 0], 0);
    fd[3] = (imageHash(im.data) >> 8) & 0xff; fd[4] = imageHash(im.data) & 0xff;
    fd.set(new TextEncoder().encode(im.type), 5);
    fd.set(be32(im.data.length), 17);
    const subs = [block(0x2e, fd)];
    if (im.version) subs.push(block(0x31, enc(im.version)));
    for (const pr of im.products ?? []) {
      const d = new Uint8Array(16 + pr.hwrevs.length * 8);
      d.set(new TextEncoder().encode(pr.product));
      pr.hwrevs.forEach((h, i) => d.set(new TextEncoder().encode(h), 16 + i * 8));
      subs.push(block(0x32, d));
    }
    if (im.layout) subs.push(block(0x33, enc(im.layout)));
    parts.push(Uint8Array.of(0x54, subs.length), ...subs, Uint8Array.of(0), im.data);
  }
  return cat(...parts);
}
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
