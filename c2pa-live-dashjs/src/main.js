// Note: dashjs 5.x has no working default export in its ESM build,
// hence the named import.
import { MediaPlayer } from 'dashjs';
import { attachC2pa, C2paEvent, ERROR_CODE_MESSAGES } from '@qualabs/c2pa-live-dashjs-plugin';
import { createJsonTree } from './json-tree.js';
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
  streamSelect: $('streamSelect'),
  video: $('video'),
  videoPlaceholder: $('videoPlaceholder'),
  errorBanner: $('errorBanner'),
  playerState: $('playerState'),
  liveBadge: $('liveBadge'),
  pill: $('statusPill'),
  pillLabel: $('statusPillLabel'),
  pillSub: $('statusPillSub'),
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
  btnToggleAll: $('btnToggleAll'),
  chkLiveUpdate: $('chkLiveUpdate'),
  cawgCount: $('cawgCount'),
  cawgSection: $('cawgSection'),
  btnCawgToggle: $('btnCawgToggle'),
  cawgEmpty: $('cawgEmpty'),
  cawgBody: $('cawgBody'),
  cawgSource: $('cawgSource'),
  cawgAssertions: $('cawgAssertions'),
  cawgHistory: $('cawgHistory'),
  cawgHistoryWrap: $('cawgHistoryWrap'),
  cawgHistoryHint: $('cawgHistoryHint'),
  chkCawgPerSegment: $('chkCawgPerSegment'),
  problemsPanel: $('problemsPanel'),
  problemsBody: $('problemsBody'),
  problemsList: $('problemsList'),
  problemsEmpty: $('problemsEmpty'),
  problemsCount: $('problemsCount'),
  btnProblemsToggle: $('btnProblemsToggle'),
  btnClearProblems: $('btnClearProblems'),
  logPanel: $('logPanel'),
  logBody: $('logBody'),
  logList: $('logList'),
  logEmpty: $('logEmpty'),
  btnLogToggle: $('btnLogToggle'),
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
  cawgCurrent: null, // null until a media segment was read, then 'present' | 'absent'
  cawgCount: 0,
  cawgSeen: new Set(), // "<kind>|<mediaType>|<segmentNumber>" of already reported segments
  cawgSig: null, // signature of the CAWG data currently rendered in the detail block
  cawgFromSegments: false, // true as soon as CAWG data has been read from segment bytes
  cawgOpen: false, // CAWG details start collapsed, the manifest tree gets the space
  problemsOpen: false, // issues list starts collapsed, the count badge carries the summary
  logOpen: false, // segment log starts collapsed
};

const tree = createJsonTree(els.manifestTree, {
  // Fully expanded on first render: the parts of a C2PA manifest worth looking
  // at - signatureInfo, the assertion list - sit below depth 2, and opening
  // them by hand on every reload is friction in a demo. Collapse/expand after
  // that is remembered, so this only decides the starting state.
  initialDepth: Infinity,
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
  let sub = 'Pick a stream to start validation';

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
  // state.mode is still tracked - it decides whether the session key count is
  // meaningful - it is just no longer shown as its own stat.
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
  syncTreeToggle();

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
// A flattened path is one long token, so a browser wraps it mid-word:
// "signer_payload.referen / ced_assertions[0].url". A zero-width space before
// each separator gives it somewhere better to break; the overflow-wrap in the
// stylesheet stays the fallback for a run that has none.
function breakableCawgKey(key) {
  return key.replace(/([.[])/g, '\u200B$1');
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
    dt.textContent = breakableCawgKey(key);
    const dd = document.createElement('dd');
    dd.textContent = value;
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

// Why a media segment ended up without CAWG data - the second line of the
// notice in the detail block and the tooltip of the marker row.
const CAWG_ABSENT_REASONS = {
  nobox: 'The segment carries no C2PA manifest box.',
  nocawg: 'The C2PA manifest box of the segment has no cawg.* assertions.',
  unreadable: 'The C2PA manifest box of the segment could not be parsed.',
};

function renderCawgAbsent(entry, reason) {
  els.cawgSource.textContent = `${cawgSourceLabel(entry)} · ${fmtTime(entry.timestamp)}`;
  els.cawgSource.title = entry.url ?? '';

  // The notice is only rebuilt when it changes; the source line above moves
  // on with every segment.
  const current = els.cawgAssertions.firstElementChild;
  if (current?.classList.contains('cawg-absent') && current.dataset.reason === reason) return;
  els.cawgAssertions.innerHTML = '';
  const note = document.createElement('div');
  note.className = 'cawg-absent';
  note.dataset.reason = reason;
  note.innerHTML = '<b>No CAWG assertions in this segment</b><small></small>';
  note.querySelector('small').textContent = CAWG_ABSENT_REASONS[reason] ?? '';
  els.cawgAssertions.appendChild(note);
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

  prependCawgHistoryRow(row);
}

// One muted row marks where the CAWG data stops. A row for every segment
// without it would push the rows that carry data out of the capped list
// within a minute on a channel that alternates signed and unsigned sources.
function addCawgGapRow(entry, reason) {
  const row = document.createElement('div');
  row.className = 'cawg-row cawg-row-none';
  row.innerHTML = `<span class="cawg-row-seg"></span><span class="cawg-row-type"></span><span class="cawg-row-sum">no CAWG assertions</span><time>${fmtTime(entry.timestamp)}</time>`;
  row.querySelector('.cawg-row-seg').textContent = `#${entry.segmentNumber}`;
  row.querySelector('.cawg-row-type').textContent = entry.mediaType
    ? (MEDIA_TYPE_LABELS[entry.mediaType] ?? entry.mediaType)
    : '';
  row.title = CAWG_ABSENT_REASONS[reason] ?? '';
  prependCawgHistoryRow(row);
}

function prependCawgHistoryRow(row) {
  els.cawgHistory.prepend(row);
  while (els.cawgHistory.children.length > MAX_CAWG_ENTRIES) {
    els.cawgHistory.removeChild(els.cawgHistory.lastChild);
  }
  els.cawgHistoryHint.textContent = `· ${state.cawgCount} segment${state.cawgCount === 1 ? '' : 's'} with CAWG data`;
  syncCawgVisibility();
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

  // The detail block follows the media segments. An init segment says nothing
  // about the media segments to come, so it only fills the block while no
  // media segment has been read yet.
  if (entry.kind === 'media' || state.cawgCurrent === null) {
    state.cawgCurrent = 'present';
    renderCawgDetail(entry);
  }
  syncCawgVisibility();
  addCawgHistoryRow(entry);
  return true;
}

// A media segment without CAWG data takes over the detail block. On a channel
// that switches between signed and unsigned sources the block would otherwise
// keep showing the CAWG data of the last signed source as if it were current.
// Init segments are left out: in a VSI stream they never carry cawg.*, and
// every source switch begins with one. "Current" follows the download, not
// the playhead - dash.js fetches a buffer's worth of segments ahead, so the
// block changes a few segments before the picture does.
function noteCawgAbsent(meta, reason) {
  if (meta.kind !== 'media') return;
  const entry = { ...meta, timestamp: Date.now() };
  const changed = state.cawgCurrent !== 'absent';
  state.cawgCurrent = 'absent';
  state.cawgSig = null; // the next segment with data rebuilds the values
  renderCawgAbsent(entry, reason);
  if (changed) addCawgGapRow(entry, reason);
  syncCawgVisibility();
}

// Reads the CAWG assertions of a single segment. Runs outside the interceptor
// chain, so a segment is never delayed by the parsing.
function parseCawgBox(box, meta) {
  let manifest = null;
  try {
    manifest = readManifestBox(box);
  } catch (error) {
    console.warn('[cawg] manifest box could not be parsed', error);
  }
  if (!manifest) {
    noteCawgAbsent(meta, 'unreadable');
    return;
  }
  const assertions = pickCawgAssertions(manifest.assertions);
  if (assertions.length === 0) {
    noteCawgAbsent(meta, 'nocawg');
    return;
  }
  const added = addCawgEntry({ ...meta, manifestLabel: manifest.label, assertions });
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

  const url = response.request?.url;
  const meta = {
    kind,
    mediaType: request.mediaType ?? null,
    quality: request.representationId ? String(request.representationId) : qualityFromUrl(url),
    segmentNumber: segmentNumberFromUrl(url) ?? (request.index ?? 0) + 1,
    url,
  };

  // Copy the C2PA box out while the buffer is still intact — dash.js transfers
  // it to MSE once the interceptor chain has resolved. Only the box is copied,
  // not the (up to several MB) segment.
  let box = null;
  try {
    box = extractC2paManifestBox(data);
  } catch (error) {
    console.warn('[cawg] C2PA box could not be read', error);
    queueMicrotask(() => noteCawgAbsent(meta, 'unreadable'));
    return;
  }
  if (!box) {
    // A segment of an unsigned source. Reported outside the interceptor chain
    // like the parsed ones, so the entries keep the order of the downloads.
    queueMicrotask(() => noteCawgAbsent(meta, 'nobox'));
    return;
  }
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

// The CAWG block (cawg.metadata, cawg.identity and the per segment list) is
// only rendered while it is expanded - collapsed it takes a single line, so
// the manifest tree underneath gets the room.
function syncCawgVisibility() {
  // The block has something to say once a media segment was read: CAWG data,
  // or the notice that the current segment carries none.
  const hasData = state.cawgCount > 0 || state.cawgCurrent !== null;
  els.cawgSection.classList.toggle('is-collapsed', !state.cawgOpen);
  els.cawgBody.hidden = !state.cawgOpen || !hasData;
  els.cawgEmpty.hidden = !state.cawgOpen || hasData;
  els.cawgHistoryWrap.hidden = !els.chkCawgPerSegment.checked || els.cawgHistory.children.length === 0;
  els.btnCawgToggle.textContent = state.cawgOpen ? 'Hide details' : 'Show details';
  els.btnCawgToggle.setAttribute('aria-expanded', String(state.cawgOpen));
}

function resetCawg() {
  state.cawgLatest = null;
  state.cawgCurrent = null;
  state.cawgCount = 0;
  state.cawgSeen.clear();
  state.cawgSig = null;
  state.cawgFromSegments = false;
  els.cawgCount.hidden = true;
  els.cawgCount.textContent = '0';
  els.cawgSource.textContent = '';
  els.cawgAssertions.innerHTML = '';
  els.cawgHistory.innerHTML = '';
  els.cawgHistoryHint.textContent = '';
  syncCawgVisibility();
}

// ---------------------------------------------------------------------------
// Collapsible panels
// ---------------------------------------------------------------------------

// Same deal as the CAWG block: collapsed a panel is only its heading row, and
// the button is labelled with the action it performs, not with the state it is
// in. The contents keep rendering underneath - reopening shows the full list.
function syncPanelToggle(panel, body, button, open) {
  panel.classList.toggle('is-collapsed', !open);
  body.hidden = !open;
  button.textContent = open ? 'Hide details' : 'Show details';
  button.setAttribute('aria-expanded', String(open));
}

function syncProblemsVisibility() {
  syncPanelToggle(els.problemsPanel, els.problemsBody, els.btnProblemsToggle, state.problemsOpen);
}

function syncLogVisibility() {
  syncPanelToggle(els.logPanel, els.logBody, els.btnLogToggle, state.logOpen);
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

// Sequence findings that this deployment does not treat as a problem.
//
// Unified Origin signs every track and every rendition on its own, while the
// plugin follows one sequence per stream: whenever dash.js switches
// representation (ABR) or joins mid stream, the sequence number of the next
// segment does not continue the previous one, which the plugin reports as a
// gap / livevideo.assertion.invalid. The signature of each segment itself is
// still verified - only the sequence finding is dropped.
const IGNORED_SEQUENCE_REASONS = new Set([
  'gap_detected',
  'duplicate',
  'out_of_order',
  'sequence_number_below_minimum',
]);
const IGNORED_ERROR_CODES = new Set(['livevideo.assertion.invalid']);

// Statuses this deployment does not report at all. They are all sequence
// bookkeeping rather than a statement about the signature, and for the same
// reason as the gap above they say nothing here: with one signing sequence per
// rendition, every ABR switch looks like a replay or a reorder. A segment that
// carries nothing but one of these is shown as valid; if it also has a real
// error code, that code decides and the status is left alone.
const IGNORED_STATUSES = new Set(['replayed', 'reordered', 'warning']);

function withIgnoredFindingsDropped(rec) {
  if (rec.status === 'valid' || rec.status === 'unverified') return rec;

  const reason = rec.sequenceReason && !IGNORED_SEQUENCE_REASONS.has(rec.sequenceReason)
    ? rec.sequenceReason
    : null;
  const codes = (rec.errorCodes ?? []).filter((code) => !IGNORED_ERROR_CODES.has(code));
  const status = IGNORED_STATUSES.has(rec.status)
    ? (codes.length ? 'invalid' : 'valid')
    : rec.status;

  const dropped = reason !== (rec.sequenceReason ?? null)
    || codes.length !== (rec.errorCodes?.length ?? 0)
    || status !== rec.status;
  if (!dropped) return rec;

  // if the ignored findings were the only ones, the segment itself is fine
  const nothingLeft = !reason && codes.length === 0;
  return {
    ...rec,
    status: nothingLeft ? 'valid' : status,
    sequenceReason: reason,
    errorCodes: codes,
  };
}

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
  rec = withIgnoredFindingsDropped(rec);
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
  setTreeToggle(false);
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
  stopRecovery();
  stopRestart();
  restartAttempts = 0;
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

// ---------------------------------------------------------------------------
// Live-stream recovery
// ---------------------------------------------------------------------------

// Unified Origin answers with a type="static" MPD as soon as its publishing
// point is not "started" (encoder disconnect, EOS, restart). dash.js follows
// DASH-IF IOP 4.6.4 and takes that as the end of the live presentation: it
// stops refreshing the MPD, plays the buffer out and ends - without raising an
// error. A refreshManifest() does not help, the player keeps its internal
// "finished" state. So the origin is polled until its MPD is dynamic again and
// the source is attached anew (see reattachStream).
const RECOVERY_POLL_MS = 1000;
const RECOVERY_GIVE_UP_MS = 120000;

let recovery = null; // { timer, startedAt, url } while a recovery is running
let streamIsLive = false;

async function fetchMpdType(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const m = text.match(/<MPD[^>]*\stype="(\w+)"/);
  return m ? m[1] : null;
}

function stopRecovery() {
  if (!recovery) return;
  clearTimeout(recovery.timer);
  recovery = null;
}

function startRecovery(reason) {
  if (recovery || restart || !player || !currentStreamUrl) return;
  const url = currentStreamUrl;
  const startedAt = Date.now();
  addProblem({
    badge: 'Player',
    badgeStatus: 'unverified',
    title: 'Origin signalled the end of the live stream',
    detailLines: [reason, 'Polling the manifest until it is dynamic again, then re-attaching the stream.'],
  });
  els.playerState.textContent = 'Reconnecting …';

  const poll = async () => {
    if (!recovery || recovery.url !== url) return;
    let type = null;
    try {
      type = await fetchMpdType(url);
    } catch {
      /* transient network error, keep polling */
    }
    if (!recovery || recovery.url !== url) return; // torn down meanwhile
    if (type === 'dynamic') {
      recovery = null;
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      addProblem({
        badge: 'Player',
        badgeStatus: 'unverified',
        title: `Manifest is dynamic again after ${seconds} s, stream re-attached`,
      });
      reattachStream(url);
      return;
    }
    if (Date.now() - startedAt > RECOVERY_GIVE_UP_MS) {
      recovery = null;
      showPlayerError('Live stream ended: the manifest stayed static for two minutes');
      return;
    }
    recovery.timer = setTimeout(poll, RECOVERY_POLL_MS);
  };
  recovery = { timer: setTimeout(poll, RECOVERY_POLL_MS), startedAt, url };
}

// ---------------------------------------------------------------------------
// Restart after a failed init segment
// ---------------------------------------------------------------------------

// dash.js gives up on an init segment once its retries are spent and reports
// error 28 (DOWNLOAD_ERROR_ID_INITIALIZATION) - and then leaves the period
// without one: it cannot start, and playback stalls at its boundary. Seen on
// the source-switching channel, where the failing URL joined the host of one
// period with the init file name of another: dash.js resolves BaseURLs by
// period position, and a period that has already dropped out of the MPD keeps
// the position it had. Attaching the source anew reloads the MPD and rebuilds
// the periods, so playback is restarted - with a growing delay in case the
// same error comes straight back.
const RESTART_ERROR_CODES = new Set([28]);
const RESTART_MIN_DELAY_MS = 2000;
const RESTART_MAX_DELAY_MS = 30000;

let restart = null; // { timer, url } while a restart is pending
let restartAttempts = 0; // restarts since playback last ran

function stopRestart() {
  if (!restart) return;
  clearTimeout(restart.timer);
  restart = null;
}

function scheduleRestart(reason) {
  if (restart || !player || !currentStreamUrl) return;
  stopRecovery();
  const url = currentStreamUrl;
  const attempt = ++restartAttempts;
  const delay = Math.min(RESTART_MIN_DELAY_MS * 2 ** (attempt - 1), RESTART_MAX_DELAY_MS);
  const seconds = Math.round(delay / 1000);
  addProblem({
    badge: 'Player',
    badgeStatus: 'unverified',
    title: `Restarting playback in ${seconds} s (attempt ${attempt})`,
    detailLines: [reason, 'An init segment could not be loaded; the stream is attached anew.'],
  });
  els.errorBanner.textContent = `${reason} · restarting playback in ${seconds} s`;
  els.errorBanner.hidden = false;
  els.playerState.textContent = `Restarting in ${seconds} s …`;
  const timer = setTimeout(() => {
    if (!restart || restart.url !== url || !player) return;
    restart = null;
    reattachStream(url);
  }, delay);
  restart = { timer, url };
}

// attachSource() keeps the player instance, so the C2PA plugin, the CAWG
// interceptor and the event handlers stay in place; the plugin only has its
// session keys and sequence state cleared for the init segments to come.
function reattachStream(url) {
  try {
    c2pa?.reset();
  } catch {
    /* plugin may already be detached */
  }
  els.playerState.textContent = 'Restarting …';
  player.attachSource(url);
}

function loadStream(url) {
  teardown();
  resetUiState();
  streamIsLive = false;

  els.videoPlaceholder.hidden = true;

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
    const text = `Player error${err.code ? ` (${err.code})` : ''}: ${msg}`;
    if (RESTART_ERROR_CODES.has(err.code)) {
      // the init segments of one period fail together; one restart covers them
      scheduleRestart(text);
      return;
    }
    showPlayerError(text);
    addProblem({
      badge: 'Player',
      badgeStatus: 'invalid',
      title: 'dash.js reported a playback error',
      detailLines: [msg, 'Note: for third-party streams, missing CORS headers are a common cause.'],
    });
  });
  player.on(ev.STREAM_INITIALIZED, () => {
    els.playerState.textContent = 'Stream initialized';
    if (restartAttempts > 0) els.errorBanner.hidden = true; // the restart got the stream back
    try {
      streamIsLive = player.isDynamic();
      els.liveBadge.hidden = !streamIsLive;
    } catch {
      /* isDynamic is only available after the manifest has loaded */
    }
  });
  player.on(ev.DYNAMIC_TO_STATIC, () =>
    startRecovery('dash.js received a type="static" MPD (DYNAMIC_TO_STATIC): Unified Origin reports its publishing point as stopped.')
  );
  player.on(ev.PLAYBACK_ENDED, () => {
    if (streamIsLive) startRecovery('Playback reached the end of the live presentation (PLAYBACK_ENDED).');
  });
  player.on(ev.PLAYBACK_PLAYING, () => {
    els.playerState.textContent = 'Playing';
    restartAttempts = 0; // playback is back, the next restart starts with the short delay again
  });
  player.on(ev.PLAYBACK_WAITING, () => (els.playerState.textContent = 'Buffering …'));
  player.on(ev.PLAYBACK_PAUSED, () => (els.playerState.textContent = 'Paused'));

  player.initialize(els.video, url, true);
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

// The picker is the only stream control - choosing an entry loads it straight
// away, which is why there is no Load button. Streams come from the <option>
// list in the HTML, so the demo line-up can change without rebuilding this
// bundle.
const CUSTOM_OPTION_ID = 'streamOptionCustom';
let currentStreamUrl = '';

// Puts the picker on the entry for `url`. A URL that is not in the list - a
// hand written ?url= - gets an entry of its own, so the picker never claims to
// be showing something other than what is actually playing.
function selectStreamOption(url) {
  const sel = els.streamSelect;
  const match = [...sel.options].find((o) => o.value === url && !('newtab' in o.dataset));

  if (match) {
    sel.value = url;
  } else {
    let custom = $(CUSTOM_OPTION_ID);
    if (!custom) {
      custom = document.createElement('option');
      custom.id = CUSTOM_OPTION_ID;
      // after the "choose a stream" placeholder, ahead of the fixed line-up
      sel.insertBefore(custom, sel.options[1] ?? null);
    }
    let label = 'Custom stream';
    try {
      label = `Custom stream (${new URL(url, location.href).host})`;
    } catch {
      /* not parseable as a URL, the plain label will do */
    }
    custom.value = url;
    custom.textContent = label;
    custom.title = url;
    sel.value = url;
  }

  currentStreamUrl = url;
}

els.streamSelect.addEventListener('change', () => {
  const opt = els.streamSelect.selectedOptions[0];
  if (!opt) return;

  // the glitch control panel is a page, not a stream: open it in a tab and put
  // the picker back on whatever is playing
  if ('newtab' in opt.dataset) {
    window.open(opt.value, '_blank', 'noopener');
    els.streamSelect.value = currentStreamUrl;
    return;
  }

  const url = opt.value.trim();
  if (!url) return;
  currentStreamUrl = url;
  loadStream(url);
});

els.btnCawgToggle.addEventListener('click', () => {
  state.cawgOpen = !state.cawgOpen;
  syncCawgVisibility();
});

// One button for both directions. It is labelled with the action it performs,
// not with the current state, so "Expand all" opens the tree and then turns
// into "Collapse all".
let treeExpanded = false;

function setTreeToggle(expanded) {
  treeExpanded = expanded;
  els.btnToggleAll.textContent = expanded ? 'Collapse all' : 'Expand all';
  els.btnToggleAll.setAttribute('aria-expanded', String(expanded));
}

// Read the state back off the tree rather than assuming it: a manifest can
// already be fully open at the depth the tree seeds to, and single rows can be
// folded by hand, either of which would leave a remembered flag lying. Every
// container node carries a .jt-children wrapper whether it is open or not.
function syncTreeToggle() {
  const containers = [...els.manifestTree.querySelectorAll('.jt-children')].map((c) => c.parentElement);
  const allOpen = containers.length > 0 && containers.every((n) => n.classList.contains('jt-expanded'));
  setTreeToggle(allOpen);
}

els.btnToggleAll.addEventListener('click', () => {
  if (!tree.hasData) return;
  if (treeExpanded) tree.collapseAll();
  else tree.expandAll();
  syncTreeToggle();
});

els.chkCawgPerSegment.addEventListener('change', syncCawgVisibility);

els.chkOnlyProblems.addEventListener('change', () => {
  els.logList.classList.toggle('only-problems', els.chkOnlyProblems.checked);
});

els.btnProblemsToggle.addEventListener('click', () => {
  state.problemsOpen = !state.problemsOpen;
  syncProblemsVisibility();
});

els.btnLogToggle.addEventListener('click', () => {
  state.logOpen = !state.logOpen;
  syncLogVisibility();
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
syncProblemsVisibility();
syncLogVisibility();

const params = new URLSearchParams(location.search);

// The picker contents come from streams.json next to the page, so a deployment
// can change its line-up without rebuilding this bundle. The <option> list in
// the HTML is the fallback and stays put if the file is missing, unreachable or
// malformed - a demo with the wrong streams beats a demo with an empty picker.
const STREAMS_URL = 'streams.json';
const STREAMS_TIMEOUT_MS = 3000;

// exact hostname, or a trailing '*' wildcard; '*' alone matches anything
function hostMatches(pattern, host) {
  if (typeof pattern !== 'string') return false;
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return host.startsWith(pattern.slice(0, -1));
  return pattern === host;
}

// either a file holding one environment ({ items: [...] }) or one holding
// several ({ profiles: [{ id, hosts, items }] }), first host match wins
function pickStreamItems(config, wantedId) {
  if (Array.isArray(config?.items)) return config.items;

  const profiles = Array.isArray(config?.profiles) ? config.profiles : [];
  const profile = wantedId
    ? profiles.find((p) => p?.id === wantedId)
    : profiles.find((p) => (p?.hosts ?? []).some((h) => hostMatches(h, location.hostname)));

  return Array.isArray(profile?.items) ? profile.items : null;
}

function applyStreamItems(items) {
  const sel = els.streamSelect;
  const placeholder = sel.options[0];
  sel.replaceChildren(placeholder);

  for (const item of items) {
    const opt = document.createElement('option');
    if (item?.separator) {
      opt.disabled = true;
      opt.textContent = '──────────────';
    } else {
      if (!item?.url) continue;
      const label = item.label ?? item.url;
      // {host} lets one entry serve every machine the demo is set up on: the
      // player, the glitch proxy and the ingest stats all sit on the host that
      // served this page, only on different ports
      opt.value = String(item.url).replace(/\{host\}/g, location.hostname);
      // an arrow marks the entries that open a page instead of playing a stream
      opt.textContent = item.newTab ? `${label} \u2197` : label;
      if (item.newTab) opt.dataset.newtab = '';
    }
    sel.appendChild(opt);
  }
}

async function loadStreamList() {
  const ctrl = new AbortController();
  // never let a hanging request hold up the stream the page was opened for
  const timer = setTimeout(() => ctrl.abort(), STREAMS_TIMEOUT_MS);
  try {
    const res = await fetch(STREAMS_URL, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = pickStreamItems(await res.json(), params.get('streams'));
    if (!items?.length) throw new Error('no profile matched and no items given');
    applyStreamItems(items);
  } catch (err) {
    console.warn(`[streams] keeping the built-in list, ${STREAMS_URL} not applied:`, err);
  } finally {
    clearTimeout(timer);
  }
}

// ?url= (or ?src=) loads that stream right away and moves the picker onto the
// matching entry, e.g.
//   /?url=https://example.cloudfront.net/channel1/channel1.isml/.mpd
// without a parameter nothing is loaded and the picker stays on its placeholder.
// The list is settled first so the parameter can land on a real entry.
void (async () => {
  await loadStreamList();

  const paramUrl = (params.get('url') ?? params.get('src'))?.trim();
  if (paramUrl) {
    selectStreamOption(paramUrl);
    loadStream(paramUrl);
  }
})();

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
