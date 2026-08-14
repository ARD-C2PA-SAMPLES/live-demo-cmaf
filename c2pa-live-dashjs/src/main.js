// Note: dashjs 5.x has no working default export in its ESM build,
// hence the named import.
import { MediaPlayer } from 'dashjs';
import { attachC2pa, C2paEvent, ERROR_CODE_MESSAGES } from '@qualabs/c2pa-live-dashjs-plugin';
import { createJsonTree, toPlainJson } from './json-tree.js';
import {
  extractC2paManifestBox,
  readManifestBox,
  pickCawgAssertions,
  flattenAssertionData,
  cawgSignature,
  cawgSummaryLine,
} from './cawg.js';
import {
  STATUS_LABELS,
  STATUS_SEVERITY,
  SEQUENCE_REASONS,
  MEDIA_TYPE_LABELS,
} from './messages.js';
import { runDemo } from './demo.js';

const STORAGE_KEY = 'c2pa-live-dashjs.lastUrl';
const STATUS_WINDOW_MS = 15000; // time window in which issues shape the overall status
const MAX_LOG_ENTRIES = 200;
const MAX_PROBLEM_ENTRIES = 100;
const MAX_STRIP_TICKS = 90;
const MANIFEST_RENDER_MIN_INTERVAL_MS = 2500;
const MAX_CAWG_ENTRIES = 60;
const MAX_CAWG_KEYS = 800; // cap for the de-duplication set of already reported segments

const SEGMENT_KINDS = { InitializationSegment: 'init', MediaSegment: 'media' };
const SEGMENT_FILE_RE = /\.(?:m4s|mp4|cmf[vat]|dash)$/i;

const $ = (id) => document.getElementById(id);

const els = {
  form: $('streamForm'),
  url: $('streamUrl'),
  preset: $('presetSelect'),
  btnLoad: $('btnLoad'),
  btnStop: $('btnStop'),
  video: $('video'),
  videoPlaceholder: $('videoPlaceholder'),
  errorBanner: $('errorBanner'),
  playerState: $('playerState'),
  liveBadge: $('liveBadge'),
  pill: $('statusPill'),
  pillLabel: $('statusPillLabel'),
  pillSub: $('statusPillSub'),
  statMode: $('statMode'),
  statManifestId: $('statManifestId'),
  statKeys: $('statKeys'),
  statSegments: $('statSegments'),
  counters: $('counters'),
  segStrip: $('segStrip'),
  manifestTree: $('manifestTree'),
  manifestEmpty: $('manifestEmpty'),
  manifestMeta: $('manifestMeta'),
  pathBar: $('pathBar'),
  pathText: $('pathText'),
  pathValue: $('pathValue'),
  btnCopyPath: $('btnCopyPath'),
  btnExpandAll: $('btnExpandAll'),
  btnCollapseAll: $('btnCollapseAll'),
  btnCopyJson: $('btnCopyJson'),
  chkLiveUpdate: $('chkLiveUpdate'),
  cawgCount: $('cawgCount'),
  cawgEmpty: $('cawgEmpty'),
  cawgBody: $('cawgBody'),
  cawgSource: $('cawgSource'),
  cawgAssertions: $('cawgAssertions'),
  cawgHistory: $('cawgHistory'),
  cawgHistoryWrap: $('cawgHistoryWrap'),
  cawgHistoryHint: $('cawgHistoryHint'),
  chkCawgPerSegment: $('chkCawgPerSegment'),
  btnCopyCawg: $('btnCopyCawg'),
  problemsList: $('problemsList'),
  problemsEmpty: $('problemsEmpty'),
  problemsCount: $('problemsCount'),
  btnClearProblems: $('btnClearProblems'),
  logList: $('logList'),
  logEmpty: $('logEmpty'),
  chkOnlyProblems: $('chkOnlyProblems'),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let player = null;
let c2pa = null;
let cawgInterceptor = null;

const state = {
  recentStatuses: [], // { ts, status } for overall status aggregation
  counters: Object.fromEntries(Object.keys(STATUS_LABELS).map((s) => [s, 0])),
  totalSegments: 0,
  problemCount: 0,
  mode: null, // 'vsi' | 'manifestbox' | 'none' | null
  sessionKeys: 0,
  manifestId: null,
  lastManifestSig: null,
  lastManifestRender: 0,
  pendingManifest: null, // { manifest, source } – throttled live updates
  noC2paData: false,
  hadInitError: false,
  selectedNode: null,
  cawgLatest: null, // last segment whose manifest carried cawg.* assertions
  cawgCount: 0,
  cawgSeen: new Set(), // "<kind>|<mediaType>|<segmentNumber>" of already reported segments
  cawgSig: null, // signature of the CAWG data currently rendered in the detail block
  cawgFromSegments: false, // true as soon as CAWG data has been read from segment bytes
};

const tree = createJsonTree(els.manifestTree, {
  initialDepth: 2,
  onSelect: (sel) => {
    state.selectedNode = sel;
    els.pathBar.hidden = false;
    els.pathText.textContent = sel.path;
    els.pathValue.textContent = sel.isLeaf ? String(sel.display) : sel.display;
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

function statusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

function errorText(code) {
  return ERROR_CODE_MESSAGES?.[code] ?? code;
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    flashButton(btn, 'Copied ✓');
  } catch {
    flashButton(btn, 'Copy failed');
  }
}

function flashButton(btn, label) {
  if (!btn) return;
  const original = btn.dataset.label ?? btn.textContent;
  btn.dataset.label = original;
  btn.textContent = label;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1200);
}

// ---------------------------------------------------------------------------
// Overall status (pill)
// ---------------------------------------------------------------------------

function pushStatus(status) {
  state.recentStatuses.push({ ts: Date.now(), status });
}

function recomputePill() {
  const cutoff = Date.now() - STATUS_WINDOW_MS;
  state.recentStatuses = state.recentStatuses.filter((e) => e.ts >= cutoff);

  let cls = 'none';
  let label = 'No stream';
  let sub = 'Load a stream URL to start validation';

  const hasData = state.totalSegments > 0 || state.noC2paData || state.hadInitError;
  if (player || hasData) {
    if (state.recentStatuses.length === 0) {
      if (state.hadInitError) {
        cls = 'invalid';
        label = 'Init invalid';
        sub = 'Init segment failed C2PA validation';
      } else if (state.noC2paData) {
        cls = 'none';
        label = 'No C2PA data';
        sub = 'The stream carries no Content Credentials';
      } else {
        cls = 'pending';
        label = 'Waiting for segments…';
        sub = 'Stream is loading, no validation results yet';
      }
    } else {
      let worst = 'valid';
      for (const e of state.recentStatuses) {
        if ((STATUS_SEVERITY[e.status] ?? 0) > (STATUS_SEVERITY[worst] ?? 0)) worst = e.status;
      }
      cls = worst;
      label = statusLabel(worst);
      const problems = state.recentStatuses.filter((e) => e.status !== 'valid').length;
      sub =
        worst === 'valid'
          ? `All ${state.recentStatuses.length} segments in the last ${STATUS_WINDOW_MS / 1000}s are valid`
          : worst === 'unverified'
            ? 'Segments without verifiable C2PA data'
            : `${problems} flagged segment${problems === 1 ? '' : 's'} in the last ${STATUS_WINDOW_MS / 1000}s`;
    }
  }

  els.pill.dataset.status = cls;
  els.pillLabel.textContent = label;
  els.pillSub.textContent = sub;
}

setInterval(recomputePill, 1000);

// ---------------------------------------------------------------------------
// Statistics / counters
// ---------------------------------------------------------------------------

function renderCounters() {
  els.counters.innerHTML = '';
  for (const [status, label] of Object.entries(STATUS_LABELS)) {
    const n = state.counters[status];
    const chip = document.createElement('span');
    chip.className = 'counter-chip';
    chip.dataset.status = status;
    if (n === 0) chip.classList.add('is-zero');
    chip.innerHTML = `<i class="dot"></i>${label} <b>${n}</b>`;
    els.counters.appendChild(chip);
  }
  els.statSegments.textContent = String(state.totalSegments);
}

function updateMeta() {
  const modeText =
    state.mode === 'vsi'
      ? 'VSI (session keys in init segment)'
      : state.mode === 'manifestbox'
        ? 'Manifest Box (manifest per segment)'
        : state.mode === 'none'
          ? 'No C2PA data'
          : '–';
  els.statMode.textContent = modeText;
  els.statKeys.textContent = state.mode === 'vsi' || state.sessionKeys > 0 ? String(state.sessionKeys) : '–';
  els.statManifestId.textContent = state.manifestId ?? '–';
  els.statManifestId.title = state.manifestId ?? '';
}

// ---------------------------------------------------------------------------
// Segment timeline (ticks)
// ---------------------------------------------------------------------------

function addTick(rec) {
  const tick = document.createElement('i');
  tick.className = 'tick';
  tick.dataset.status = rec.status;
  tick.title = `#${rec.segmentNumber} · ${MEDIA_TYPE_LABELS[rec.mediaType] ?? rec.mediaType} · ${statusLabel(rec.status)} · ${fmtTime(rec.timestamp)}`;
  els.segStrip.appendChild(tick);
  while (els.segStrip.children.length > MAX_STRIP_TICKS) {
    els.segStrip.removeChild(els.segStrip.firstChild);
  }
}

// ---------------------------------------------------------------------------
// Manifest display
// ---------------------------------------------------------------------------

// The assertion labels are part of the signature on purpose: signers such as
// Unified Origin reuse label and instanceId of the init manifest for every
// segment but add assertions (cawg.*) to the per-segment manifests. Without the
// labels the tree would keep showing the leaner init manifest forever.
function manifestSignature(manifest) {
  const labels = Array.isArray(manifest?.assertions)
    ? manifest.assertions.map((a) => a.label).join(',')
    : '';
  return `${manifest?.label ?? ''}|${manifest?.instanceId ?? ''}|${labels}`;
}

function renderManifest(manifest, source) {
  tree.render(manifest);
  els.manifestEmpty.hidden = true;
  els.manifestTree.hidden = false;

  const assertions = Array.isArray(manifest?.assertions) ? manifest.assertions.length : 0;
  const issuer = manifest?.signatureInfo?.issuer;
  els.manifestMeta.innerHTML = '';
  const parts = [
    ['Source', source],
    ['Updated', fmtTime(Date.now())],
    ['Assertions', String(assertions)],
  ];
  if (issuer) parts.push(['Issuer', issuer]);
  if (manifest?.claimGenerator) parts.push(['Claim generator', manifest.claimGenerator]);
  for (const [k, v] of parts) {
    const span = document.createElement('span');
    span.className = 'meta-item';
    span.innerHTML = `<b>${k}:</b> `;
    span.appendChild(document.createTextNode(v));
    els.manifestMeta.appendChild(span);
  }
}

function maybeRenderManifest(manifest, source) {
  if (!manifest) return;
  const sig = manifestSignature(manifest);
  const isNew = sig !== state.lastManifestSig;
  if (!isNew) return;
  state.manifestId = manifest.label ?? state.manifestId;

  if (!els.chkLiveUpdate.checked && tree.hasData) {
    state.pendingManifest = { manifest, source };
    return;
  }
  const now = Date.now();
  if (tree.hasData && now - state.lastManifestRender < MANIFEST_RENDER_MIN_INTERVAL_MS) {
    state.pendingManifest = { manifest, source };
    return;
  }
  state.lastManifestSig = sig;
  state.lastManifestRender = now;
  state.pendingManifest = null;
  renderManifest(manifest, source);
  updateMeta();
}

// Catch up on throttled updates
setInterval(() => {
  if (!state.pendingManifest || !els.chkLiveUpdate.checked) return;
  if (Date.now() - state.lastManifestRender < MANIFEST_RENDER_MIN_INTERVAL_MS) return;
  const { manifest, source } = state.pendingManifest;
  state.lastManifestSig = manifestSignature(manifest);
  state.lastManifestRender = Date.now();
  state.pendingManifest = null;
  renderManifest(manifest, source);
  updateMeta();
}, 500);

// ---------------------------------------------------------------------------
// CAWG section
//
// The plugin only reports the manifest of the init segment while a stream is
// validated via VSI/emsg — the CAWG assertions, however, sit in the C2PA
// manifest box of each media segment. They are therefore read from the segment
// bytes via an own dash.js response interceptor (see attachCawgReader) and, as
// a fallback, from any manifest the plugin hands out per segment.
// ---------------------------------------------------------------------------

function segmentNumberFromUrl(url) {
  const filename = url?.split('?')[0].split('/').pop() ?? '';
  const match = filename.match(/-(\d+)\.(?:m4s|mp4|cmf[vat]|dash)$/i);
  return match ? Number(match[1]) : null;
}

// "channel1-video=1200000-1072022426496.m4s" → "channel1-video=1200000"
function qualityFromUrl(url) {
  const filename = url?.split('?')[0].split('/').pop() ?? '';
  return filename.replace(/-\d+\.\w+$/, '').replace(SEGMENT_FILE_RE, '') || null;
}

function cawgSourceLabel(entry) {
  const parts = [entry.kind === 'init' ? 'Init segment' : `Segment #${entry.segmentNumber}`];
  if (entry.mediaType) parts.push(MEDIA_TYPE_LABELS[entry.mediaType] ?? entry.mediaType);
  if (entry.quality) parts.push(entry.quality);
  return parts.join(' · ');
}

// Long paths are shortened from the front, so that the distinguishing part
// ("…referenced_assertions[1].hash") stays visible; the tooltip has the full key.
const MAX_CAWG_KEY_CHARS = 22;

function shortenCawgKey(key) {
  return key.length <= MAX_CAWG_KEY_CHARS
    ? key
    : `…${key.slice(key.length - (MAX_CAWG_KEY_CHARS - 1))}`;
}

function buildCawgAssertion(assertion) {
  const wrap = document.createElement('div');
  wrap.className = 'cawg-assert';

  const label = document.createElement('div');
  label.className = 'cawg-assert-label';
  label.textContent = assertion.label;
  wrap.appendChild(label);

  const dl = document.createElement('dl');
  dl.className = 'cawg-kv';
  for (const { key, value } of flattenAssertionData(assertion.data)) {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = shortenCawgKey(key);
    dt.title = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dd.title = value;
    row.append(dt, dd);
    dl.appendChild(row);
  }
  wrap.appendChild(dl);
  return wrap;
}

function renderCawgDetail(entry) {
  els.cawgSource.textContent = `${cawgSourceLabel(entry)} · ${fmtTime(entry.timestamp)}`;
  els.cawgSource.title = entry.url ?? '';

  // Only rebuild the values when the CAWG data itself changed — for a live
  // stream the same assertions arrive with every segment.
  const sig = cawgSignature(entry.assertions);
  if (sig === state.cawgSig) return;
  state.cawgSig = sig;

  els.cawgAssertions.innerHTML = '';
  for (const assertion of entry.assertions) {
    els.cawgAssertions.appendChild(buildCawgAssertion(assertion));
  }
}

function addCawgHistoryRow(entry) {
  const row = document.createElement('details');
  row.className = 'cawg-row';

  const summary = document.createElement('summary');
  summary.innerHTML = `<span class="cawg-row-seg"></span><span class="cawg-row-type"></span><span class="cawg-row-sum"></span><time>${fmtTime(entry.timestamp)}</time>`;
  summary.querySelector('.cawg-row-seg').textContent =
    entry.kind === 'init' ? 'init' : `#${entry.segmentNumber}`;
  summary.querySelector('.cawg-row-type').textContent = entry.mediaType
    ? (MEDIA_TYPE_LABELS[entry.mediaType] ?? entry.mediaType)
    : '';
  summary.querySelector('.cawg-row-sum').textContent = cawgSummaryLine(entry.assertions);
  row.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'cawg-row-body';
  row.appendChild(body);
  // Values are built on first expand — a live stream produces a row per segment.
  row.addEventListener('toggle', () => {
    if (!row.open || body.hasChildNodes()) return;
    for (const assertion of entry.assertions) body.appendChild(buildCawgAssertion(assertion));
  });

  els.cawgHistory.prepend(row);
  while (els.cawgHistory.children.length > MAX_CAWG_ENTRIES) {
    els.cawgHistory.removeChild(els.cawgHistory.lastChild);
  }
  els.cawgHistoryHint.textContent = `· ${state.cawgCount} segment${state.cawgCount === 1 ? '' : 's'} with CAWG data`;
}

function addCawgEntry(entry) {
  if (!entry.assertions?.length) return false;
  if (!els.chkCawgPerSegment.checked) return false; // per-segment display switched off

  const key = `${entry.kind}|${entry.mediaType ?? ''}|${entry.segmentNumber ?? ''}`;
  if (state.cawgSeen.has(key)) return false; // already reported via the other path
  if (state.cawgSeen.size >= MAX_CAWG_KEYS) state.cawgSeen.clear();
  state.cawgSeen.add(key);

  entry.timestamp = Date.now();
  state.cawgLatest = entry;
  state.cawgCount++;

  els.cawgCount.textContent = String(state.cawgCount);
  els.cawgCount.hidden = false;
  els.cawgEmpty.hidden = true;
  els.cawgBody.hidden = false;

  renderCawgDetail(entry);
  addCawgHistoryRow(entry);
  return true;
}

// Reads the CAWG assertions of a single segment. Runs outside the interceptor
// chain, so a segment is never delayed by the parsing.
function parseCawgBox(box, meta) {
  let manifest = null;
  try {
    manifest = readManifestBox(box);
  } catch (error) {
    console.warn('[cawg] manifest box could not be parsed', error);
    return;
  }
  if (!manifest) return;
  const added = addCawgEntry({
    ...meta,
    manifestLabel: manifest.label,
    assertions: pickCawgAssertions(manifest.assertions),
  });
  // From now on the segment bytes are the single source — the plugin numbers
  // its segments differently in places, which would duplicate entries.
  if (added) state.cawgFromSegments = true;
}

function captureCawgSegment(response) {
  if (!els.chkCawgPerSegment.checked) return;

  const request = response?.request?.customData?.request;
  const data = response?.data;
  if (!request || !(data instanceof ArrayBuffer)) return;

  const kind = SEGMENT_KINDS[request.type ?? ''];
  if (!kind) return;

  // Copy the C2PA box out while the buffer is still intact — dash.js transfers
  // it to MSE once the interceptor chain has resolved. Only the box is copied,
  // not the (up to several MB) segment.
  let box = null;
  try {
    box = extractC2paManifestBox(data);
  } catch (error) {
    console.warn('[cawg] C2PA box could not be read', error);
    return;
  }
  if (!box) return;

  const url = response.request?.url;
  const meta = {
    kind,
    mediaType: request.mediaType ?? null,
    quality: request.representationId ? String(request.representationId) : qualityFromUrl(url),
    segmentNumber: segmentNumberFromUrl(url) ?? (request.index ?? 0) + 1,
    url,
  };
  queueMicrotask(() => parseCawgBox(box, meta));
}

function attachCawgReader(dashPlayer) {
  if (typeof dashPlayer.addResponseInterceptor !== 'function') return;
  cawgInterceptor = async (response) => {
    try {
      captureCawgSegment(response);
    } catch (error) {
      console.warn('[cawg] segment could not be processed', error);
    }
    return response;
  };
  dashPlayer.addResponseInterceptor(cawgInterceptor);
}

function resetCawg() {
  state.cawgLatest = null;
  state.cawgCount = 0;
  state.cawgSeen.clear();
  state.cawgSig = null;
  state.cawgFromSegments = false;
  els.cawgCount.hidden = true;
  els.cawgCount.textContent = '0';
  els.cawgEmpty.hidden = false;
  els.cawgBody.hidden = true;
  els.cawgSource.textContent = '';
  els.cawgAssertions.innerHTML = '';
  els.cawgHistory.innerHTML = '';
  els.cawgHistoryHint.textContent = '';
}

// ---------------------------------------------------------------------------
// Issues list
// ---------------------------------------------------------------------------

function addProblem({ badge, badgeStatus, title, detailLines = [], codes = [] }) {
  state.problemCount++;
  els.problemsEmpty.hidden = true;
  els.problemsCount.textContent = String(state.problemCount);
  els.problemsCount.hidden = false;

  const item = document.createElement('div');
  item.className = 'problem';
  item.dataset.status = badgeStatus;

  const head = document.createElement('div');
  head.className = 'problem-head';
  head.innerHTML = `<span class="badge" data-status="${badgeStatus}">${badge}</span><span class="problem-title"></span><time>${fmtTime(Date.now())}</time>`;
  head.querySelector('.problem-title').textContent = title;
  item.appendChild(head);

  for (const line of detailLines) {
    const p = document.createElement('div');
    p.className = 'problem-line';
    p.textContent = line;
    item.appendChild(p);
  }
  for (const code of codes) {
    const p = document.createElement('div');
    p.className = 'problem-line problem-code';
    p.innerHTML = `<span class="code-msg"></span> <code></code>`;
    p.querySelector('.code-msg').textContent = errorText(code);
    p.querySelector('code').textContent = code;
    item.appendChild(p);
  }

  els.problemsList.prepend(item);
  while (els.problemsList.children.length > MAX_PROBLEM_ENTRIES) {
    els.problemsList.removeChild(els.problemsList.lastChild);
  }
}

// ---------------------------------------------------------------------------
// Segment log
// ---------------------------------------------------------------------------

function addLogEntry(rec) {
  els.logEmpty.hidden = true;
  const isProblem = rec.status !== 'valid';
  const row = document.createElement('div');
  row.className = 'log-row';
  if (isProblem) row.classList.add('is-problem');
  row.dataset.status = rec.status;

  const extras = [];
  if (rec.quality) extras.push(rec.quality);
  if (rec.sequenceReason) extras.push(SEQUENCE_REASONS[rec.sequenceReason] ?? rec.sequenceReason);
  if (rec.errorCodes?.length) extras.push(`${rec.errorCodes.length} error code${rec.errorCodes.length === 1 ? '' : 's'}`);

  row.innerHTML = `<i class="dot"></i><span class="log-seg">#${rec.segmentNumber}</span><span class="log-type">${MEDIA_TYPE_LABELS[rec.mediaType] ?? rec.mediaType}</span><span class="log-status"></span><span class="log-extra"></span><time>${fmtTime(rec.timestamp)}</time>`;
  row.querySelector('.log-status').textContent = statusLabel(rec.status);
  row.querySelector('.log-extra').textContent = extras.join(' · ');
  row.title = rec.hash ? `Hash: ${rec.hash}` : '';

  els.logList.prepend(row);
  while (els.logList.children.length > MAX_LOG_ENTRIES) {
    els.logList.removeChild(els.logList.lastChild);
  }
}

// ---------------------------------------------------------------------------
// C2PA event handlers
// ---------------------------------------------------------------------------

function onInitProcessed(e) {
  if (e.noC2paData) {
    state.noC2paData = true;
    if (!state.mode) state.mode = 'none';
    updateMeta();
    recomputePill();
    return;
  }

  state.noC2paData = false;

  if (e.success) {
    state.sessionKeys = e.sessionKeysCount ?? 0;
    if (e.sessionKeysCount > 0) state.mode = 'vsi';
    if (e.manifestId) state.manifestId = e.manifestId;
    if (e.manifest) maybeRenderManifest(e.manifest, 'Init segment');
  } else {
    state.hadInitError = true;
    addProblem({
      badge: 'Init',
      badgeStatus: 'invalid',
      title: 'Init segment failed C2PA validation',
      detailLines: e.error ? [String(e.error)] : [],
      codes: e.errorCodes ?? [],
    });
    pushStatus('invalid');
  }
  updateMeta();
  recomputePill();
}

function onSegmentValidated(rec) {
  state.totalSegments++;
  if (rec.status in state.counters) state.counters[rec.status]++;
  pushStatus(rec.status);

  if (rec.manifest) {
    if (state.mode !== 'vsi') state.mode = 'manifestbox';
    maybeRenderManifest(rec.manifest, `Segment #${rec.segmentNumber}`);
    // Fallback for manifests that the plugin itself delivers per segment
    // (manifest-box method and demo mode) — only while no CAWG data has been
    // read from the segment bytes.
    if (!state.cawgFromSegments) {
      addCawgEntry({
        kind: 'media',
        mediaType: rec.mediaType,
        quality: rec.quality ?? null,
        segmentNumber: rec.segmentNumber,
        manifestLabel: rec.manifest.label,
        assertions: pickCawgAssertions(rec.manifest.assertions),
      });
    }
  }

  addTick(rec);
  addLogEntry(rec);
  renderCounters();
  updateMeta();
  recomputePill();

  if (rec.status !== 'valid' && rec.status !== 'unverified') {
    const details = [];
    if (rec.sequenceReason) details.push(SEQUENCE_REASONS[rec.sequenceReason] ?? rec.sequenceReason);
    if (rec.previousManifestId) details.push(`Previous manifest: ${rec.previousManifestId}`);
    addProblem({
      badge: `Segment #${rec.segmentNumber}`,
      badgeStatus: rec.status,
      title: `${MEDIA_TYPE_LABELS[rec.mediaType] ?? rec.mediaType}${rec.quality ? ` (${rec.quality})` : ''}: ${statusLabel(rec.status)}`,
      detailLines: details,
      codes: rec.errorCodes ?? [],
    });
  }
}

function onC2paError(e) {
  addProblem({
    badge: 'Pipeline',
    badgeStatus: 'invalid',
    title: `Internal validation error (${e.source})`,
    detailLines: [e.error instanceof Error ? e.error.message : String(e.error)],
  });
}

// ---------------------------------------------------------------------------
// Player lifecycle
// ---------------------------------------------------------------------------

function resetUiState() {
  state.recentStatuses = [];
  state.counters = Object.fromEntries(Object.keys(STATUS_LABELS).map((s) => [s, 0]));
  state.totalSegments = 0;
  state.problemCount = 0;
  state.mode = null;
  state.sessionKeys = 0;
  state.manifestId = null;
  state.lastManifestSig = null;
  state.lastManifestRender = 0;
  state.pendingManifest = null;
  state.noC2paData = false;
  state.hadInitError = false;

  resetCawg();
  tree.clear();
  els.manifestTree.hidden = true;
  els.manifestEmpty.hidden = false;
  els.manifestMeta.innerHTML = '';
  els.pathBar.hidden = true;
  els.problemsList.innerHTML = '';
  els.problemsEmpty.hidden = false;
  els.problemsCount.hidden = true;
  els.logList.innerHTML = '';
  els.logEmpty.hidden = false;
  els.segStrip.innerHTML = '';
  els.errorBanner.hidden = true;
  els.liveBadge.hidden = true;
  els.playerState.textContent = 'Loading …';
  renderCounters();
  updateMeta();
  recomputePill();
}

function teardown() {
  if (c2pa) {
    try {
      c2pa.detach();
    } catch {
      /* plugin may already be detached */
    }
    c2pa = null;
  }
  if (player) {
    if (cawgInterceptor) {
      try {
        player.removeResponseInterceptor?.(cawgInterceptor);
      } catch {
        /* interceptor may already be gone */
      }
      cawgInterceptor = null;
    }
    try {
      if (typeof player.destroy === 'function') player.destroy();
      else player.reset();
    } catch {
      /* player may already be reset */
    }
    player = null;
  }
}

function showPlayerError(message) {
  els.errorBanner.textContent = message;
  els.errorBanner.hidden = false;
  els.playerState.textContent = 'Error';
}

function loadStream(url) {
  teardown();
  resetUiState();

  els.videoPlaceholder.hidden = true;
  localStorage.setItem(STORAGE_KEY, url);

  player = MediaPlayer().create();

  // Important: call attachC2pa BEFORE initialize() so the init segments
  // pass through the interceptor as well.
  c2pa = attachC2pa(player, { mediaTypes: ['video', 'audio'] });
  c2pa.on(C2paEvent.INIT_PROCESSED, onInitProcessed);
  c2pa.on(C2paEvent.SEGMENT_VALIDATED, onSegmentValidated);
  c2pa.on(C2paEvent.ERROR, onC2paError);

  // Own interceptor for the CAWG assertions of each individual segment.
  attachCawgReader(player);

  const ev = MediaPlayer.events;
  player.on(ev.ERROR, (e) => {
    const err = e?.error ?? {};
    const msg = err.message ?? String(err);
    showPlayerError(`Player error${err.code ? ` (${err.code})` : ''}: ${msg}`);
    addProblem({
      badge: 'Player',
      badgeStatus: 'invalid',
      title: 'dash.js reported a playback error',
      detailLines: [msg, 'Note: for third-party streams, missing CORS headers are a common cause.'],
    });
  });
  player.on(ev.STREAM_INITIALIZED, () => {
    els.playerState.textContent = 'Stream initialized';
    try {
      els.liveBadge.hidden = !player.isDynamic();
    } catch {
      /* isDynamic is only available after the manifest has loaded */
    }
  });
  player.on(ev.PLAYBACK_PLAYING, () => (els.playerState.textContent = 'Playing'));
  player.on(ev.PLAYBACK_WAITING, () => (els.playerState.textContent = 'Buffering …'));
  player.on(ev.PLAYBACK_PAUSED, () => (els.playerState.textContent = 'Paused'));

  player.initialize(els.video, url, true);
  els.btnStop.disabled = false;
}

function stopStream() {
  teardown();
  els.playerState.textContent = 'Stopped';
  els.videoPlaceholder.hidden = false;
  els.btnStop.disabled = true;
  recomputePill();
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

els.form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const url = els.url.value.trim();
  if (!url) return;
  loadStream(url);
});

els.btnStop.addEventListener('click', stopStream);

els.preset.addEventListener('change', () => {
  if (els.preset.value) {
    els.url.value = els.preset.value;
    els.preset.selectedIndex = 0;
    loadStream(els.url.value.trim());
  }
});

els.btnExpandAll.addEventListener('click', () => tree.expandAll());
els.btnCollapseAll.addEventListener('click', () => tree.collapseAll());
els.btnCopyJson.addEventListener('click', () => {
  if (!tree.hasData) return;
  copyText(JSON.stringify(toPlainJson(tree.value), null, 2), els.btnCopyJson);
});
els.btnCopyPath.addEventListener('click', () => {
  if (state.selectedNode) copyText(state.selectedNode.path, els.btnCopyPath);
});

els.chkCawgPerSegment.addEventListener('change', () => {
  els.cawgHistoryWrap.hidden = !els.chkCawgPerSegment.checked;
});

els.btnCopyCawg.addEventListener('click', () => {
  const entry = state.cawgLatest;
  if (!entry) return;
  const payload = {
    source: cawgSourceLabel(entry),
    url: entry.url ?? null,
    manifest: entry.manifestLabel ?? null,
    assertions: Object.fromEntries(entry.assertions.map((a) => [a.label, toPlainJson(a.data)])),
  };
  copyText(JSON.stringify(payload, null, 2), els.btnCopyCawg);
});

els.chkOnlyProblems.addEventListener('change', () => {
  els.logList.classList.toggle('only-problems', els.chkOnlyProblems.checked);
});

els.btnClearProblems.addEventListener('click', () => {
  els.problemsList.innerHTML = '';
  state.problemCount = 0;
  els.problemsCount.hidden = true;
  els.problemsEmpty.hidden = false;
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

renderCounters();
updateMeta();
recomputePill();

const params = new URLSearchParams(location.search);
const initialUrl = params.get('src') ?? localStorage.getItem(STORAGE_KEY);
if (initialUrl) {
  els.url.value = initialUrl;
  if (params.get('src')) loadStream(initialUrl);
}

// Debug/demo access from the browser console:
//   __c2paApp.demo()  – plays back a sample sequence including failures
window.__c2paApp = {
  demo: () => runDemo({ onInitProcessed, onSegmentValidated, onError: onC2paError }),
  injectInit: onInitProcessed,
  injectSegment: onSegmentValidated,
  get player() {
    return player;
  },
  get c2pa() {
    return c2pa;
  },
};
