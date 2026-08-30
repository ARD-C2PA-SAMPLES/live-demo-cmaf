// Reads CAWG (Creator Assertions Working Group) assertions straight out of a
// segment.
//
// Why not take them from the plugin: while a stream is validated via VSI/emsg
// the plugin only surfaces the manifest of the *init* segment — but signers
// such as Unified Origin put the CAWG assertions (cawg.metadata, cawg.identity)
// into the C2PA manifest box of every media segment. So the segment bytes are
// parsed here directly:
//   `uuid` box (C2PA manifest store) → JUMBF boxes (ISO 19566-5)
//   → manifest → `c2pa.assertions` → cawg.*
//
// Only structural parsing happens here; signature and hash validation stay with
// the plugin (@qualabs/c2pa-live-dashjs-plugin / @svta/cml-c2pa).

import { decode as decodeCbor } from 'cbor-x/decode';

const TEXT_DECODER = new TextDecoder();

// C2PA manifest store UUID and the JUMBF UUID (ISO 19566-5) — signing tools use either.
const C2PA_BOX_UUIDS = [
  [0xd8, 0xfe, 0xc3, 0xd6, 0x1a, 0x96, 0x4f, 0x32, 0xa0, 0xf6, 0xf3, 0xec, 0xf9, 0x6c, 0x10, 0xea],
  [0xd8, 0xfe, 0xc3, 0xd6, 0x1b, 0x0e, 0x48, 0x3c, 0x92, 0x97, 0x58, 0x28, 0x87, 0x7e, 0xc4, 0x81],
];

const UUID_SIZE = 16;
const ASSERTION_STORE_LABEL = 'c2pa.assertions';
const MAX_JUMBF_DEPTH = 20;

// JUMBF description box (`jumd`): 16-byte UUID + 1 toggle byte + null-terminated label.
const JUMD_TOGGLES_OFFSET = 16;
const JUMD_LABEL_START = 17;
const JUMD_LABEL_FLAGS = 0x03;

const ASSERTION_CONTENT_TYPES = ['cbor', 'json', 'jumc', 'jp2c', 'bidb'];

// ---------------------------------------------------------------------------
// Box readers
// ---------------------------------------------------------------------------

function asBytes(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return null;
}

// ISO BMFF and JUMBF share the 4-byte size + 4-byte type box header,
// so one reader covers both. Returns the boxes of the current level only.
function readBoxes(bytes) {
  const out = [];
  if (bytes.byteLength < 8) return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = view.getUint32(offset);
    const type = TEXT_DECODER.decode(bytes.subarray(offset + 4, offset + 8));
    let header = 8;

    if (size === 1) {
      if (offset + 16 > bytes.length) break;
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = bytes.length - offset; // box extends to the end
    }

    if (size < header || offset + size > bytes.length) break; // truncated or malformed
    out.push({ type, data: bytes.subarray(offset + header, offset + size) });
    offset += size;
  }
  return out;
}

function matchesC2paUuid(bytes) {
  return C2PA_BOX_UUIDS.some((uuid) => uuid.every((b, i) => bytes[i] === b));
}

// Strips the JUMBF UUID box prefix: version+flags (4) + null-terminated purpose
// string + 8-byte auxiliary offset, leaving the plain JUMBF data.
function stripJumbfPrefix(payload) {
  if (payload.length < 4) return null;
  let offset = 4;
  while (offset < payload.length && payload[offset] !== 0) offset++;
  if (offset >= payload.length) return null;
  offset += 1 + 8;
  return offset <= payload.length ? payload.subarray(offset) : null;
}

function readJumbfLabel(jumdData) {
  if (jumdData.length < JUMD_LABEL_START) return null;
  if ((jumdData[JUMD_TOGGLES_OFFSET] & JUMD_LABEL_FLAGS) !== JUMD_LABEL_FLAGS) return null;

  let end = JUMD_LABEL_START;
  while (end < jumdData.length && jumdData[end] !== 0) end++;
  if (end >= jumdData.length) return null;
  return TEXT_DECODER.decode(jumdData.subarray(JUMD_LABEL_START, end));
}

function labelOf(boxes) {
  const jumd = boxes.find((b) => b.type === 'jumd');
  return jumd ? readJumbfLabel(jumd.data) : null;
}

// ---------------------------------------------------------------------------
// Manifest → assertions
// ---------------------------------------------------------------------------

function decodeAssertionData(box) {
  if (box.type === 'cbor') {
    try {
      return decodeCbor(box.data);
    } catch {
      return box.data;
    }
  }
  if (box.type === 'json') {
    try {
      return JSON.parse(TEXT_DECODER.decode(box.data));
    } catch {
      return box.data;
    }
  }
  return box.data;
}

function readAssertionStore(storeBoxes) {
  const assertions = [];
  for (const box of storeBoxes) {
    if (box.type !== 'jumb') continue;
    const inner = readBoxes(box.data);
    const label = labelOf(inner);
    if (!label) continue;
    const contentBox = inner.find((b) => ASSERTION_CONTENT_TYPES.includes(b.type));
    assertions.push({ label, data: contentBox ? decodeAssertionData(contentBox) : null });
  }
  return assertions;
}

// Descends the JUMBF tree (store → manifest → assertion store) and collects one
// entry per manifest that carries an assertion store.
function collectManifests(boxes, manifestLabel, depth, into) {
  if (depth > MAX_JUMBF_DEPTH) return;
  for (const box of boxes) {
    if (box.type !== 'jumb') continue;
    const inner = readBoxes(box.data);
    const label = labelOf(inner);
    if (label === ASSERTION_STORE_LABEL) {
      into.push({ label: manifestLabel, assertions: readAssertionStore(inner) });
    } else {
      collectManifests(inner, label ?? manifestLabel, depth + 1, into);
    }
  }
}

/**
 * Finds the C2PA manifest box in ISO BMFF bytes and returns a copy of its
 * payload (everything after the 16-byte UUID), or null if the segment carries
 * no C2PA data.
 *
 * Only the box itself is copied — callers can hand in the untouched response
 * buffer of a multi-megabyte segment without duplicating it.
 */
export function extractC2paManifestBox(source) {
  const bytes = asBytes(source);
  if (!bytes) return null;

  for (const box of readBoxes(bytes)) {
    if (box.type !== 'uuid' || box.data.length < UUID_SIZE) continue;
    if (!matchesC2paUuid(box.data)) continue;
    return box.data.slice(UUID_SIZE); // copy: the caller's buffer may be transferred to MSE
  }
  return null;
}

/**
 * Parses the payload returned by {@link extractC2paManifestBox} into the active
 * manifest's label and assertions. Returns null when the payload is not a
 * readable JUMBF manifest store.
 */
export function readManifestBox(payload) {
  const bytes = asBytes(payload);
  if (!bytes) return null;

  const jumbf = stripJumbfPrefix(bytes);
  if (!jumbf) return null;

  const manifests = [];
  collectManifests(readBoxes(jumbf), null, 0, manifests);
  if (manifests.length === 0) return null;

  // The active manifest is the last one in the store.
  return manifests[manifests.length - 1];
}

/**
 * Convenience wrapper: segment bytes → { label, assertions } of the active
 * manifest, or null when the segment carries no readable C2PA manifest box.
 */
export function readManifestFromSegment(source) {
  const box = extractC2paManifestBox(source);
  return box ? readManifestBox(box) : null;
}

// ---------------------------------------------------------------------------
// CAWG helpers
// ---------------------------------------------------------------------------

export function isCawgLabel(label) {
  return typeof label === 'string' && (label === 'cawg' || label.startsWith('cawg.'));
}

/** Keeps only the cawg.* assertions of a manifest (plugin manifests work too). */
export function pickCawgAssertions(assertions) {
  return Array.isArray(assertions) ? assertions.filter((a) => isCawgLabel(a?.label)) : [];
}

/** Identifies a set of CAWG assertions, so unchanged data is not re-rendered. */
export function cawgSignature(assertions) {
  return assertions
    .map((a) => `${a.label}=${stableStringify(a.data)}`)
    .join('|');
}

function stableStringify(value) {
  if (value instanceof Uint8Array) return `bytes:${value.length}:${hexPreview(value, 8)}`;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `bytes:${value.byteLength}`;
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${k}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return String(value);
}

function hexPreview(u8, max) {
  let hex = '';
  for (let i = 0; i < Math.min(u8.length, max); i++) hex += u8[i].toString(16).padStart(2, '0');
  return hex;
}

// Same rule as the manifest tree: assertion values are shown in full, a
// half printed hash being no use to anyone checking one. The cap is only a
// guard against a pathologically large blob; CAWG values are hashes and
// signatures and stay far below it.
const MAX_INLINE_BYTES = 8192;

function bytesLabel(u8) {
  const hex = hexPreview(u8, MAX_INLINE_BYTES);
  const cut = u8.length > MAX_INLINE_BYTES ? '…' : '';
  return `${u8.length} byte${u8.length === 1 ? '' : 's'} · 0x${hex}${cut}`;
}

// Deep enough that a real CAWG assertion is flattened all the way down
// rather than collapsing into "3 keys"; still a guard against runaway
// recursion on malformed data.
const MAX_FLATTEN_DEPTH = 24;

/**
 * Flattens decoded assertion data into `[{ key, value }]` rows for the compact
 * key/value view — `signer_payload.referenced_assertions[0].url` and friends.
 * Byte strings become a length + their full hex instead of an array of numbers.
 */
export function flattenAssertionData(data, prefix = '', depth = 0, into = []) {
  if (data instanceof Uint8Array) {
    into.push({ key: prefix || '(value)', value: bytesLabel(data) });
    return into;
  }
  if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) {
    into.push({ key: prefix || '(value)', value: bytesLabel(asBytes(data)) });
    return into;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) into.push({ key: prefix || '(value)', value: '(empty list)' });
    else if (depth >= MAX_FLATTEN_DEPTH) into.push({ key: prefix, value: `${data.length} items` });
    else data.forEach((item, i) => flattenAssertionData(item, `${prefix}[${i}]`, depth + 1, into));
    return into;
  }
  if (data && typeof data === 'object') {
    const entries = Object.entries(data);
    if (entries.length === 0) into.push({ key: prefix || '(value)', value: '(empty)' });
    else if (depth >= MAX_FLATTEN_DEPTH) into.push({ key: prefix, value: `${entries.length} keys` });
    else {
      for (const [k, v] of entries) {
        flattenAssertionData(v, prefix ? `${prefix}.${k}` : k, depth + 1, into);
      }
    }
    return into;
  }
  into.push({
    key: prefix || '(value)',
    value: data === null || data === undefined ? '–' : String(data),
  });
  return into;
}

const SUMMARY_KEYS = ['dc:title', 'dc:publisher', 'dc:creator', 'dc:rights', 'title', 'name'];

/** One-line summary of a CAWG assertion set, used for the per-segment rows. */
export function cawgSummaryLine(assertions) {
  const metadata = assertions.find((a) => a.label === 'cawg.metadata')?.data;
  if (metadata && typeof metadata === 'object') {
    for (const key of SUMMARY_KEYS) {
      const value = metadata[key];
      if (typeof value === 'string' && value) return `${key}: ${value}`;
    }
  }
  return assertions.map((a) => a.label).join(', ');
}
