#!/usr/bin/env python3
"""
Glitch proxy - HTTPS reverse proxy in front of the live DASH stream that can
flip bits in CMAF media segments on their way to the player.

Why: the demo signs every segment (C2PA/CAWG). To *show* that the validation
actually does something, the stream has to break somewhere between origin and
player - which is exactly what a man-in-the-middle proxy is. A single flipped
bit is enough: the C2PA hash over the segment no longer matches and the player
reports the segment as tampered, while the picture usually keeps running.
Flip a few thousand bits instead and the decoder starts to visibly complain.

It publishes the same origin layout as tls/nginx.conf, one port further up:

    https://<host>:8444/                        -> c2pa-player   (untouched)
    https://<host>:8444/channel1/....mpd        -> live-origin   (untouched)
    https://<host>:8444/channel1/...m4s         -> live-origin   (bit flipped)
    https://<host>:8444/glitch/                 -> control panel

So the clean stream on :8443 and the damaged one on :8444 are the same stream,
same player, same certificate - only the segments differ.

What is never touched:
  * initialization segments (they carry `moov`) - corrupting those kills the
    decoder outright and every later error becomes noise
  * manifests, /state, the player assets
  * anything while `enabled` is false

Counting is per representation (`channel1-video=4000000-<time>.m4s` and
friends collapse to one key), so "every 5th segment" means every 5th segment
*of each track*, not every 5th HTTP request across four tracks.

Configuration comes from the environment and can be changed at runtime from
/glitch/ or with the JSON API - no restart, which matters when the thing you
want to demo is the transition from clean to broken.
"""

import asyncio
import base64
import functools
import hashlib
import hmac
import json
import logging
import os
import random
import re
import ssl
import time
from collections import OrderedDict, deque

import aiohttp
from aiohttp import web

LOG = logging.getLogger("glitch")

# --- configuration ---------------------------------------------------------

UPSTREAM_STREAM = os.environ.get("UPSTREAM_STREAM", "http://live-origin:80")
UPSTREAM_PLAYER = os.environ.get("UPSTREAM_PLAYER", "http://c2pa-player:80")
# path prefixes that are served from the stream upstream (comma separated)
STREAM_PREFIXES = tuple(
    p.strip() for p in os.environ.get("STREAM_PREFIXES", "/channel1/").split(",") if p.strip()
)

LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "443"))

# Basic auth for /glitch/ only. The stream, the player and the healthcheck stay
# open - the point is to keep a passer-by from flipping the switches during a
# demo, not to protect the video. An empty password turns it off.
GLITCH_USER = os.environ.get("GLITCH_USER", "glitch")
GLITCH_PASSWORD = os.environ.get("GLITCH_PASSWORD", "")
TLS_CERT = os.environ.get("TLS_CERT", "/etc/glitch/certs/server-chain.pem")
TLS_KEY = os.environ.get("TLS_KEY", "/etc/glitch/certs/server-key.pem")

HOP_BY_HOP = frozenset(
    (
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "trailers",
        "transfer-encoding",
        "upgrade",
    )
)

# A signed segment from this stack carries C2PA in two places, and only one of
# them is validated:
#
#   emsg  `urn:c2pa:verifiable-segment-info`, whose message_data is a
#         COSE_Sign1 - the per segment signature the player actually verifies.
#         Damage it and validation fails. This is what `target=c2pa` hits.
#   uuid  the C2PA manifest store (JUMBF). c2pa-live-dashjs reads it to show
#         the CAWG assertions per segment, but the validator never checks it,
#         so flipping bits in there produces no validation error at all - which
#         is why it is not offered as a target.

TARGETS = ("mdat", "moof", "c2pa", "any")


def _env_bool(name, default):
    return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


class Config:
    """Mutable runtime configuration, seeded from the environment."""

    def __init__(self):
        self.enabled = _env_bool("GLITCH_ENABLED", True)
        # corrupt every Nth media segment per representation, 0 disables
        self.every = max(0, int(os.environ.get("GLITCH_EVERY", "5")))
        # number of individual bit flips per corrupted segment
        self.bits = max(1, int(os.environ.get("GLITCH_BITS", "1")))
        # which part of the segment to hit
        self.target = os.environ.get("GLITCH_TARGET", "mdat").strip().lower()
        if self.target not in TARGETS:
            self.target = "mdat"
        # regex matched against the representation key, empty = every track
        self.tracks = os.environ.get("GLITCH_TRACKS", "").strip()

    def as_dict(self):
        return {
            "enabled": self.enabled,
            "every": self.every,
            "bits": self.bits,
            "target": self.target,
            "tracks": self.tracks,
        }

    def update(self, data):
        """Apply a partial update, ignoring unknown keys. Raises ValueError."""
        if "enabled" in data:
            self.enabled = bool(data["enabled"])
        if "every" in data:
            self.every = max(0, int(data["every"]))
        if "bits" in data:
            self.bits = max(1, int(data["bits"]))
        if "target" in data:
            target = str(data["target"]).lower()
            if target not in TARGETS:
                raise ValueError(f"target must be one of {', '.join(TARGETS)}")
            self.target = target
        if "tracks" in data:
            pattern = str(data["tracks"])
            re.compile(pattern)  # fail here, not on the next segment
            self.tracks = pattern


CFG = Config()

# per representation segment counters and a ring buffer of what was hit,
# both only interesting for the control panel and the log
COUNTERS = {}
EVENTS = deque(maxlen=50)
STATS = {"segments": 0, "corrupted": 0, "no_target": 0, "started": time.time()}

# What was decided for a segment URL, so the answer stays the same when that
# URL comes back. It does come back: dash.js retries at the live edge, the
# DVR window can be seeked into, and a demo usually has more than one browser
# tab open on the proxy. Deciding per *request* instead would let two viewers
# see different bytes for the same segment and would halve the effective
# cadence per tab - "every 5th segment" has to mean every 5th segment.
DECISIONS = OrderedDict()
DECISION_LIMIT = 4096


# --- ISOBMFF ---------------------------------------------------------------


def top_level_boxes(data):
    """Yield (type, payload_start, payload_end) for the top level boxes."""
    boxes = []
    off = 0
    n = len(data)
    while off + 8 <= n:
        size = int.from_bytes(data[off : off + 4], "big")
        btype = data[off + 4 : off + 8].decode("latin-1")
        header = 8
        if size == 1:  # 64 bit largesize
            if off + 16 > n:
                break
            size = int.from_bytes(data[off + 8 : off + 16], "big")
            header = 16
        elif size == 0:  # box runs to the end of the file
            size = n - off
        if size < header or off + size > n:
            break  # truncated or not ISOBMFF at all
        boxes.append((btype, off + header, off + size))
        off += size
    return boxes


def classify(boxes):
    """'init' for a segment carrying `moov`, 'media' for `moof`+`mdat`."""
    types = {b[0] for b in boxes}
    if "moov" in types:
        return "init"
    if "moof" in types and "mdat" in types:
        return "media"
    return "other"


def emsg_c2pa_payload(data, start, end):
    """Range of the COSE_Sign1 inside a C2PA `emsg` box, or None.

    Version 0 puts the two strings before the timing fields, version 1 after
    them; both end with message_data, which for `urn:c2pa:...` is the
    signature. Everything ahead of it is event plumbing - flipping a bit in
    the scheme URI only makes the player *ignore* the event instead of
    failing on it, which is the opposite of what this is for.
    """
    if end - start < 8:
        return None

    version = data[start]
    off = start + 4  # version (1) + flags (3)

    def cstring(i):
        j = data.find(b"\x00", i, end)
        return (data[i:j], j + 1) if j >= 0 else (None, -1)

    if version == 0:
        scheme, off = cstring(off)
        if off < 0:
            return None
        _value, off = cstring(off)
        if off < 0:
            return None
        off += 16  # timescale, presentation_time_delta, event_duration, id
    elif version == 1:
        off += 20  # timescale, presentation_time (64 bit), event_duration, id
        if off >= end:
            return None
        scheme, off = cstring(off)
        if off < 0:
            return None
        _value, off = cstring(off)
        if off < 0:
            return None
    else:
        return None

    if not scheme or not scheme.startswith(b"urn:c2pa:"):
        return None
    return (off, end) if off < end else None


def target_regions(data, boxes, target):
    """Byte ranges that may be flipped, given the configured target."""
    if target == "any":
        return [(0, len(data))]

    regions = []
    for btype, start, end in boxes:
        if target == "mdat" and btype == "mdat":
            regions.append((start, end))
        elif target == "moof" and btype == "moof":
            regions.append((start, end))
        elif target == "c2pa" and btype == "emsg":
            span = emsg_c2pa_payload(data, start, end)
            if span:
                regions.append(span)
    return regions


def flip_bits(buf, regions, bits, seed):
    """Flip `bits` bits inside `regions`. Deterministic for a given seed."""
    total = sum(end - start for start, end in regions)
    if total <= 0:
        return []

    rnd = random.Random(hashlib.sha256(seed.encode()).digest())
    offsets = []
    for _ in range(bits):
        pick = rnd.randrange(total)
        pos = 0
        for start, end in regions:
            span = end - start
            if pick < span:
                pos = start + pick
                break
            pick -= span
        buf[pos] ^= 1 << rnd.randrange(8)
        offsets.append(pos)
    return offsets


# --- segment bookkeeping ---------------------------------------------------

# `channel1-video=4000000-9000000.m4s` -> `channel1-video=4000000.m4s`, so all
# segments of one representation share a counter
REP_KEY_RE = re.compile(r"-\d+(\.[A-Za-z0-9]+)$")


def representation_key(path):
    name = path.rsplit("/", 1)[-1]
    return REP_KEY_RE.sub(r"\1", name) or path


# `channel1-video=4000000-930839729.m4s` -> 930839729, the $Number$ from the
# MPD's SegmentTemplate. The player labels its segments with the same value,
# so a row in the panel can be matched against a row in the player.
SEGMENT_NUMBER_RE = re.compile(r"-(\d+)\.[A-Za-z0-9]+$")


def segment_number(path):
    match = SEGMENT_NUMBER_RE.search(path.rsplit("/", 1)[-1])
    return int(match.group(1)) if match else None


def _decide(path, key):
    """(count within the representation, corrupt it?, first time we see it?).

    Memoised per segment URL - see DECISIONS.
    """
    memo = DECISIONS.get(path)
    if memo is not None:
        DECISIONS.move_to_end(path)
        return memo + (False,)

    count = COUNTERS.get(key, 0) + 1
    COUNTERS[key] = count
    STATS["segments"] += 1

    on_track = not CFG.tracks or re.search(CFG.tracks, key)
    corrupt = bool(on_track and CFG.every and count % CFG.every == 0)

    DECISIONS[path] = (count, corrupt)
    if len(DECISIONS) > DECISION_LIMIT:
        DECISIONS.popitem(last=False)
    return count, corrupt, True


def maybe_corrupt(path, body):
    """Return (body, info). `info` is None when the segment was left alone."""
    boxes = top_level_boxes(body)
    if classify(boxes) != "media":
        return body, None  # init segment, manifest, /state, ...

    key = representation_key(path)
    count, corrupt, fresh = _decide(path, key)

    # `enabled` is checked after the memo on purpose: switching the corruption
    # off has to clean the stream up immediately, including segments that were
    # already handed out damaged once.
    if not corrupt or not CFG.enabled:
        return body, {"corrupted": False, "count": count, "key": key}

    regions = target_regions(body, boxes, CFG.target)
    if not regions:
        # The segment was due but carries no such box - an unsigned stream
        # with target=c2pa, say. Saying so beats handing out an untouched
        # segment and letting the demo look like the corruption is broken.
        if fresh:
            STATS["no_target"] += 1
            LOG.warning(
                "no %r box in %s #%d - segment left untouched", CFG.target, key, count
            )
        return body, {
            "corrupted": False,
            "count": count,
            "key": key,
            "note": f"no {CFG.target} box in this segment",
        }

    buf = bytearray(body)
    offsets = flip_bits(buf, regions, CFG.bits, f"{path}#{count}")
    if fresh:
        STATS["corrupted"] += 1

    info = {
        "corrupted": True,
        "count": count,
        "number": segment_number(path),
        "key": key,
        "target": CFG.target,
        "bits": CFG.bits,
        "offsets": offsets[:8],
        "size": len(body),
        "path": path,
        "at": time.time(),
    }
    if fresh:
        EVENTS.appendleft(info)
        LOG.info(
            "flipped %d bit(s) in %s segment %s (%s, #%d, %d bytes) at %s",
            CFG.bits,
            key,
            info["number"],
            CFG.target,
            count,
            len(body),
            ",".join(str(o) for o in offsets[:8]),
        )
    return bytes(buf), info


# --- proxying --------------------------------------------------------------


def forward_request_headers(request, force_identity):
    headers = {}
    for name, value in request.headers.items():
        if name.lower() in HOP_BY_HOP:
            continue
        headers[name] = value
    if force_identity:
        # never let the upstream compress a body we are about to rewrite -
        # flipping a bit inside a gzip stream produces a decode error, not a
        # broken segment
        headers["Accept-Encoding"] = "identity"
    return headers


def forward_response_headers(upstream, drop_length=False, no_store=False):
    headers = {}
    for name, value in upstream.headers.items():
        lname = name.lower()
        if lname in HOP_BY_HOP:
            continue
        # the body was rewritten, so the upstream framing no longer applies
        if drop_length and lname in ("content-length", "content-encoding"):
            continue
        headers[name] = value
    # the player may live on another origin (:8443) while the stream comes
    # from here, so be explicit about CORS instead of relying on same origin
    headers["Access-Control-Allow-Origin"] = "*"
    headers["Access-Control-Expose-Headers"] = (
        "X-Glitch, X-Glitch-Count, X-Glitch-Number, X-Glitch-Target, X-Glitch-Bits, "
        "X-Glitch-Offsets, X-Glitch-Note"
    )
    if no_store:
        # same reasoning as tls/nginx.conf: the origin packages per request
        # and a cached manifest would stall playback on the live edge
        headers["Cache-Control"] = "no-store"
    return headers


def is_segment_response(path, content_type):
    ctype = (content_type or "").split(";")[0].strip().lower()
    if ctype in ("video/mp4", "audio/mp4", "application/mp4", "application/octet-stream"):
        return True
    return bool(re.search(r"\.(m4s|mp4|cmf[vat]|dash)$", path, re.I))


async def proxy(request, upstream_base, corrupt):
    url = upstream_base.rstrip("/") + str(request.rel_url)
    headers = forward_request_headers(request, force_identity=corrupt)
    body = await request.read() if request.can_read_body else None

    session = request.app["session"]
    try:
        async with session.request(
            request.method, url, headers=headers, data=body, allow_redirects=False
        ) as upstream:
            if upstream.status in (204, 304) or request.method == "HEAD":
                # nothing to stream and nothing to corrupt, but the upstream
                # framing headers no longer apply
                return web.Response(
                    status=upstream.status,
                    headers=forward_response_headers(
                        upstream, drop_length=True, no_store=corrupt
                    ),
                )

            candidate = corrupt and is_segment_response(
                request.path, upstream.headers.get("Content-Type")
            )

            if not candidate:
                # straight pass through, chunk by chunk: manifests and player
                # assets are none of our business and buffering the live edge
                # would only add latency
                response = web.StreamResponse(
                    status=upstream.status,
                    headers=forward_response_headers(upstream, no_store=corrupt),
                )
                await response.prepare(request)
                async for chunk in upstream.content.iter_chunked(64 * 1024):
                    await response.write(chunk)
                await response.write_eof()
                return response

            data = await upstream.read()
            data, info = maybe_corrupt(request.path, data)
            headers = forward_response_headers(upstream, drop_length=True, no_store=True)
            if info is None:
                headers["X-Glitch"] = "skipped"
            elif info["corrupted"]:
                headers["X-Glitch"] = "corrupted"
                headers["X-Glitch-Count"] = str(info["count"])
                headers["X-Glitch-Number"] = str(info["number"])
                headers["X-Glitch-Target"] = info["target"]
                headers["X-Glitch-Bits"] = str(info["bits"])
                headers["X-Glitch-Offsets"] = ",".join(str(o) for o in info["offsets"])
            elif info.get("note"):
                # due for corruption, but the target box is not in there
                headers["X-Glitch"] = "no-target"
                headers["X-Glitch-Count"] = str(info["count"])
                headers["X-Glitch-Note"] = info["note"]
            else:
                headers["X-Glitch"] = "clean"
                headers["X-Glitch-Count"] = str(info["count"])
            return web.Response(status=upstream.status, headers=headers, body=data)

    except aiohttp.ClientError as exc:
        LOG.warning("upstream %s failed: %s", url, exc)
        return web.Response(status=502, text=f"glitch-proxy: upstream error: {exc}\n")


# --- control API and panel -------------------------------------------------


async def api_config(request):
    if request.method == "GET":
        return web.json_response(
            {
                "config": CFG.as_dict(),
                "stats": {**STATS, "uptime": round(time.time() - STATS["started"])},
                "counters": dict(sorted(COUNTERS.items())),
                "events": list(EVENTS),
            }
        )

    try:
        CFG.update(await request.json())
    except (ValueError, TypeError, json.JSONDecodeError, re.error) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    LOG.info("config changed: %s", CFG.as_dict())
    return web.json_response({"config": CFG.as_dict()})


async def api_reset(request):
    COUNTERS.clear()
    DECISIONS.clear()
    EVENTS.clear()
    STATS.update(segments=0, corrupted=0, no_target=0, started=time.time())
    return web.json_response({"ok": True})


def _authorised(request):
    if not GLITCH_PASSWORD:
        return True

    scheme, _, raw = request.headers.get("Authorization", "").partition(" ")
    if scheme.lower() != "basic":
        return False
    try:
        user, _, password = base64.b64decode(raw, validate=True).decode().partition(":")
    except (ValueError, UnicodeDecodeError):
        return False

    # both halves are always compared, so how long the answer takes does not
    # depend on how much of the guess was right
    user_ok = hmac.compare_digest(user, GLITCH_USER)
    password_ok = hmac.compare_digest(password, GLITCH_PASSWORD)
    return user_ok and password_ok


def protected(handler):
    """Basic auth for the control interface.

    Only the switches sit behind it - the stream, the player and /healthz stay
    open, so the docker healthcheck and the player need no credentials.
    """

    @functools.wraps(handler)
    async def wrapper(request):
        if not _authorised(request):
            return web.Response(
                status=401,
                text="glitch-proxy: authentication required\n",
                headers={
                    "WWW-Authenticate": 'Basic realm="glitch-proxy", charset="UTF-8"',
                    "Cache-Control": "no-store",
                },
            )
        return await handler(request)

    return wrapper


async def healthz(request):
    return web.json_response({"ok": True, "config": CFG.as_dict()})


async def panel(request):
    return web.Response(
        text=PANEL_HTML, content_type="text/html",
        headers={"Cache-Control": "no-store"},
    )


async def panel_redirect(request):
    # without the trailing slash the panel's relative fetches would resolve
    # against / and end up at the player
    raise web.HTTPFound("/glitch/")


PANEL_HTML = """<!doctype html>
<meta charset="utf-8">
<title>Glitch proxy</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem;
         max-width: 46rem; }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
  p.lead { margin: 0 0 1.5rem; opacity: .7; }
  fieldset { border: 1px solid rgba(128,128,128,.4); border-radius: 8px;
             padding: 1rem 1.25rem; margin: 0 0 1rem; }
  legend { padding: 0 .4rem; font-weight: 600; }
  label { display: flex; align-items: center; gap: .75rem; margin: .5rem 0; }
  label span { flex: 0 0 11rem; }
  input[type=number], input[type=text], select { padding: .3rem .5rem;
    border-radius: 6px; border: 1px solid rgba(128,128,128,.5);
    background: transparent; color: inherit; font: inherit; }
  input[type=number] { width: 6rem; }
  input[type=text] { flex: 1; min-width: 0; }
  button { font: inherit; padding: .45rem 1rem; border-radius: 6px;
           border: 1px solid rgba(128,128,128,.5); background: transparent;
           color: inherit; cursor: pointer; }
  button.primary { background: #b3261e; border-color: #b3261e; color: #fff; }
  .row { display: flex; gap: .75rem; align-items: center; margin-top: .75rem; }
  .stats { display: flex; gap: 2rem; flex-wrap: wrap; }
  .stats div b { display: block; font-size: 1.5rem; font-weight: 600; }
  .stats div span { opacity: .7; font-size: .85rem; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  td, th { text-align: left; padding: .25rem .5rem; border-bottom:
           1px solid rgba(128,128,128,.2); }
  code { font-size: .85em; background: rgba(128,128,128,.15);
         padding: .1rem .3rem; border-radius: 4px; }
  #saved { opacity: 0; transition: opacity .2s; font-size: .85rem; }
  #saved.show { opacity: .7; }
  p.hint { margin: .1rem 0 .5rem 11.75rem; font-size: .82rem; opacity: .7; }
  p.warn { margin: .75rem 0 0; padding: .5rem .7rem; border-radius: 6px;
           font-size: .85rem; background: rgba(179,38,30,.12);
           border: 1px solid rgba(179,38,30,.45); }
  td.num { font-variant-numeric: tabular-nums; }
</style>
<h1>Glitch proxy</h1>
<p class="lead">Flips bits in CMAF media segments between origin and player.
Init segments and manifests are never touched.</p>

<fieldset>
  <legend>Corruption</legend>
  <label><span>Enabled</span><input type="checkbox" id="enabled"></label>
  <label><span>Every Nth segment</span><input type="number" id="every" min="0" step="1">
    <small style="opacity:.7">per representation, 0 = off</small></label>
  <label><span>Bits per segment</span><input type="number" id="bits" min="1" step="1">
    <small style="opacity:.7">1 breaks validation, ~2000 breaks the picture</small></label>
  <label><span>Target box</span>
    <select id="target">
      <option value="mdat">mdat &mdash; media payload (segment hash fails)</option>
      <option value="c2pa">c2pa &mdash; inband signature (emsg/COSE, validation fails)</option>
      <option value="moof">moof &mdash; fragment header (decoder fails)</option>
      <option value="any">any &mdash; anywhere</option>
    </select></label>
  <p class="hint" id="targetHint"></p>
  <label><span>Track filter</span><input type="text" id="tracks"
    placeholder="regex on the segment name, e.g. video"></label>
  <div class="row">
    <button class="primary" id="save">Apply</button>
    <button id="reset">Reset counters</button>
    <span id="saved">saved</span>
  </div>
</fieldset>

<fieldset>
  <legend>Live</legend>
  <div class="stats">
    <div><b id="sSeg">0</b><span>media segments</span></div>
    <div><b id="sCor">0</b><span>corrupted</span></div>
  </div>
  <p class="warn" id="noTarget" hidden></p>
  <table id="events" style="margin-top:1rem"><thead><tr>
    <th>when</th><th>representation</th><th>segment</th><th>seq</th>
    <th>target</th><th>offset</th>
  </tr></thead><tbody></tbody></table>
  <p class="hint" style="margin-left:0">&ldquo;segment&rdquo; is the
  <code>$Number$</code> from the MPD, the same one the player shows as
  <em>Segment #</em>. &ldquo;seq&rdquo; counts segments within the
  representation, so every 5th one is hit. &ldquo;offset&rdquo; is the byte
  offset from the start of the segment file (first 8 shown).</p>
</fieldset>

<script>
const $ = (id) => document.getElementById(id);

// Absolute, and built from origin + pathname rather than from location itself:
// opening the panel as https://user:pass@host/glitch/ (a reasonable way to
// skip the auth dialog) puts credentials in the document URL, and fetch()
// refuses any request whose URL carries them - a relative 'api/config' would
// inherit them and throw. origin and pathname both drop the credentials.
const API = new URL('api/', location.origin + location.pathname).href;

// Which target produces which failure - worth spelling out, the difference
// between a validation error and a decoder error is the whole demo.
const HINTS = {
  mdat: 'Breaks the hash over the media, so the segment fails validation while the picture usually survives.',
  c2pa: 'Breaks the COSE_Sign1 the player verifies per segment - this is the one that produces validation errors.',
  moof: 'Breaks the fragment header, so the decoder fails rather than the signature.',
  any: 'Anywhere in the segment - whatever it hits, it hits.',
};

let dirty = false;
['enabled','every','bits','target','tracks'].forEach(
  (id) => $(id).addEventListener('input', () => { dirty = true; }));

async function refresh() {
  const res = await fetch(API + 'config');
  if (!res.ok) throw new Error('api/config: ' + res.status);
  const r = await res.json();
  if (!dirty) {
    $('enabled').checked = r.config.enabled;
    $('every').value = r.config.every;
    $('bits').value = r.config.bits;
    $('target').value = r.config.target;
    $('tracks').value = r.config.tracks;
  }
  $('sSeg').textContent = r.stats.segments;
  $('sCor').textContent = r.stats.corrupted;
  $('targetHint').textContent = HINTS[r.config.target] || '';

  const missed = r.stats.no_target || 0;
  $('noTarget').hidden = missed === 0;
  $('noTarget').textContent = missed + ' segment(s) were due but carry no '
    + r.config.target + ' box, so nothing was flipped in them.'
    + (r.config.target === 'c2pa'
        ? ' The stream looks unsigned - check the origin has a Media Authenticity license.'
        : '');

  $('events').tBodies[0].innerHTML = r.events.map((e) => `<tr>
    <td>${new Date(e.at * 1000).toLocaleTimeString()}</td>
    <td><code>${e.key}</code></td>
    <td class="num">${e.number ?? '&mdash;'}</td>
    <td class="num">${e.count}</td>
    <td>${e.target} (${e.bits} bit)</td><td>${e.offsets.join(', ')}</td></tr>`).join('');
}

$('save').addEventListener('click', async () => {
  await fetch(API + 'config', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: $('enabled').checked, every: Number($('every').value),
      bits: Number($('bits').value), target: $('target').value,
      tracks: $('tracks').value }) });
  dirty = false;
  $('saved').classList.add('show');
  setTimeout(() => $('saved').classList.remove('show'), 1200);
  refresh();
});

$('reset').addEventListener('click', async () => {
  await fetch(API + 'reset', { method: 'POST' });
  refresh();
});

function tick() {
  refresh().catch((err) => {
    $('noTarget').hidden = false;
    $('noTarget').textContent = 'Cannot read the proxy state: ' + err.message;
  });
}

tick();
setInterval(tick, 2000);
</script>
"""


# --- wiring ----------------------------------------------------------------


async def route(request):
    if request.method == "OPTIONS":
        # dash.js sends Range requests, which are preflighted cross origin
        return web.Response(
            status=204,
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                "Access-Control-Allow-Headers": "Range, Content-Type",
                "Access-Control-Max-Age": "600",
            },
        )
    if request.path.startswith(STREAM_PREFIXES):
        return await proxy(request, UPSTREAM_STREAM, corrupt=True)
    return await proxy(request, UPSTREAM_PLAYER, corrupt=False)


async def on_startup(app):
    app["session"] = aiohttp.ClientSession(
        auto_decompress=False,
        timeout=aiohttp.ClientTimeout(total=None, sock_connect=5, sock_read=30),
    )


async def on_cleanup(app):
    await app["session"].close()


def build_app():
    app = web.Application(client_max_size=64 * 1024 * 1024)
    app.router.add_get("/glitch/", protected(panel))
    app.router.add_get("/glitch", panel_redirect)
    app.router.add_get("/glitch/healthz", healthz)  # open, the healthcheck uses it
    app.router.add_route("*", "/glitch/api/config", protected(api_config))
    app.router.add_post("/glitch/api/reset", protected(api_reset))
    app.router.add_route("*", "/{tail:.*}", route)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


def main():
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    ssl_ctx = None
    if os.path.exists(TLS_CERT) and os.path.exists(TLS_KEY):
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(TLS_CERT, TLS_KEY)
    else:
        # plain HTTP is only useful for a quick local test, the player needs a
        # secure context for crypto.subtle
        LOG.warning("no certificate at %s, falling back to plain HTTP", TLS_CERT)

    if GLITCH_PASSWORD:
        LOG.info("/glitch/ requires basic auth as %r", GLITCH_USER)
    else:
        LOG.warning("/glitch/ is unauthenticated - set GLITCH_PASSWORD to lock it")

    LOG.info(
        "glitch-proxy on :%d -> stream %s, player %s, config %s",
        LISTEN_PORT,
        UPSTREAM_STREAM,
        UPSTREAM_PLAYER,
        CFG.as_dict(),
    )
    web.run_app(build_app(), port=LISTEN_PORT, ssl_context=ssl_ctx, access_log=None)


if __name__ == "__main__":
    main()
