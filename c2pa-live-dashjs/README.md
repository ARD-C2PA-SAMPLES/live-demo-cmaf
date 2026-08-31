# C2PA Live · DASH Player

Static website for playing DASH live streams with **real-time C2PA validation**
(Content Credentials). Playback via [dash.js](https://github.com/Dash-Industry-Forum/dash.js),
validation via [@qualabs/c2pa-live-dashjs-plugin](https://www.npmjs.com/package/@qualabs/c2pa-live-dashjs-plugin)
(SVTA Common Media Library). The implemented spec is C2PA 2.4, §19.4
“Verifiable Segment Info” — see [below](#c2pa-spec-194--verifiable-segment-info).

## Features

- **Live playback** of any DASH stream (`.mpd`), entered in the URL field or
  passed in as `?url=`
- **C2PA manifest as an interactive JSON tree**: nodes are clickable and
  expandable/collapsible, with a path display (`$.assertions[1].data.hash`), byte values
  rendered as hex, “Expand all / Collapse all”, “Copy JSON”, and throttleable live updates
  whenever the manifest changes
- **CAWG section per segment**: the C2PA manifest box of *every* segment is read
  directly from the segment bytes, and its `cawg.*` assertions
  (`cawg.metadata` with `dc:title` / `dc:publisher` / `dc:rights`, `cawg.identity`
  with `sig_type`, referenced assertions and signature) are shown as key/value
  pairs — with a per-segment list that can be switched off (“Per segment”) and
  “Copy CAWG JSON”
- **Validation issues** with plain-text messages plus the original
  C2PA status codes (e.g. `claim.signature.mismatch`, `livevideo.segment.invalid`)
- **Overall status display** (Valid / Warning / Invalid / Replay / Gap / Unverified),
  segment timeline, per-status counters, segment log with an “Issues only” filter
- Detection of the validation method: **VSI** (session keys in the init segment) or
  **Manifest Box** (manifest per segment)

## C2PA spec §19.4 — Verifiable Segment Info

This is the part of the specification the player implements. C2PA §19 (“Live
Video”) offers two methods of making a live stream verifiable; §19.4 is the one
built for continuous streams:

| | §19.3 Per-segment C2PA Manifest Box | §19.4 Verifiable Segment Info (VSI) |
|---|---|---|
| Carrier | a full C2PA manifest (`uuid` box) in every segment | a small signed structure in an `emsg` box per segment |
| Signed by | the claim generator’s X.509 certificate | a **session key** whose public half is delivered in the manifest |
| Overhead | one manifest per segment | a few hundred bytes per segment |

**Definition.** A *verifiable-segment-info* is a `COSE_Sign1_Tagged` structure
whose payload is a CBOR-serialised `segment-info-map`. The payload is attached
(never detached), the protected header carries the signature algorithm (`alg`,
optionally `iat` as the claimed time of signing), and the unprotected header
carries the session key identifier (`kid`). It gives each segment enough
information to be validated **on its own**, without re-reading a whole manifest.

```cddl
verifiable-segment-info = COSE_Sign1_Tagged

segment-info-map = {
    "sequenceNumber" => uint,               ; increases by 1 per segment, never repeats or decreases
    "bmffHash"       => bmff-hash-map,      ; c2pa.hash.bmff.v3 over the segment, C2PA emsg boxes excluded
    "manifestId"     => tstr,               ; identifier of the currently active manifest
    ? "manifestUri"  => hashed-ext-uri-map  ; optional URL to fetch that manifest from
}
```

**Transport.** The structure travels in the segment’s `emsg` box with `version`
0, `scheme_id_uri` `urn:c2pa:verifiable-segment-info`, `value` `"fseg"`,
`presentation_time_delta` 0, `timescale`/`event_duration` covering the whole
segment, and `message_data` holding the encoded verifiable-segment-info. The
`bmffHash` deliberately excludes those C2PA `emsg` boxes via an exclusion-map
(`xpath` `/emsg`, `data` offset 0, value `urn:c2pa:verifiable-segment-info`), so
that the hash covers the media and not the signature carrying it.

**Session keys (§19.4.4).** Segments are *not* signed with the claim
generator’s certificate but with a short-lived asymmetric session key. The
public halves arrive in a session keys assertion inside the C2PA manifest of the
**init segment**, and may be rotated later via further init segments, a manifest
box, or the `manifestUri`. A validator picks the key by `kid`, then checks the
manifest identifier against `manifestId`.

**Validation (§19.7.3).** Per segment, a validator verifies the COSE signature
with the session key, that `sequenceNumber` is not below the key’s
`minSequenceNumber`, that the presentation time is inside the key’s validity
period, and that the segment hash matches `bmffHash`. Failures surface as
`livevideo.segment.invalid`; a missing, malformed, or expired session key (or a
revoked signing certificate) as `livevideo.sessionkey.invalid` — both codes are
shown verbatim in the “Validation issues” panel.

**What that means for this player.** Signature and hash checking happen inside
`@qualabs/c2pa-live-dashjs-plugin`; this site visualises the result. The mode is
derived from the `INIT_PROCESSED` event: if it reports `sessionKeysCount > 0`,
the stream uses **VSI**, otherwise **Manifest Box** (see `state.mode` in
[src/main.js](src/main.js)) — the key count is shown next to it. Under VSI the
plugin only reports the manifest of the init segment, which is why
[src/cawg.js](src/cawg.js) reads the per-segment manifest boxes separately —
see [CAWG per segment](#cawg-per-segment).

## Quick start

```bash
npm install
npm run build     # bundles src/ → app.bundle.js
npm run serve     # http://localhost:8090
```

Or as part of the [live-demo-cmaf](../README.md) stack, which builds the bundle
in the image and serves it on the same port:

```bash
docker compose up -d c2pa-player     # from the repository root
```

The finished site is purely static — deploying only takes these three files:
`index.html`, `styles.css`, `app.bundle.js` (any static host, no server code required).

### Passing a stream in the URL

`?url=` loads a stream right away, which makes the player linkable:

```
http://localhost:8090/?url=http://localhost/channel1/channel1.isml/.mpd
```

`?src=` does the same. Without a parameter the last URL used is restored into
the input field, but not loaded.

## Getting a C2PA-signed test stream

There are currently no public C2PA-signed live streams. The
[C2PA Live Video Toolkit](https://github.com/qualabs/c2pa-live-video-toolkit) by Qualabs
starts a complete local pipeline (encoder → signer → origin → attack proxy):

```bash
git clone https://github.com/qualabs/c2pa-live-video-toolkit
cd c2pa-live-video-toolkit
docker compose up --build
```

Then load `http://localhost:8083/stream.mpd` in this website. The toolkit’s
attack proxy can deliberately simulate validation failures (tampered,
replayed, or missing segments) — these then show up in the “Validation
issues” panel.

For a playback-only test without C2PA, load
`https://livesim2.dashif.org/livesim2/testpic_2s/Manifest.mpd` — segments are
then shown as **Unverified / No C2PA data**.

> **Sequence findings:** gaps in the C2PA sequence
> (`gap_detected` / `livevideo.assertion.invalid`) are not reported as issues.
> Unified Origin signs every rendition separately while the plugin follows one
> sequence per stream, so every ABR switch would otherwise be flagged. See
> `IGNORED_SEQUENCE_REASONS` in [src/main.js](src/main.js) to switch it back on.
> The signature of each segment itself is still verified.

> **CORS note:** third-party streams must send CORS headers, otherwise dash.js
> reports a download error (shown in the issues panel).

## Demo without a stream

In the browser console:

```js
__c2paApp.demo()
```

plays back a sample sequence (valid segments, a warning, an invalid signature,
a replay attack, a sequence gap, a pipeline error) including a sample manifest —
useful for exploring the UI without the Docker pipeline. Also available:
`__c2paApp.injectInit(payload)` and `__c2paApp.injectSegment(record)`.

Direct start with a URL parameter: `http://localhost:8090/?src=<MPD-URL>`.

## Architecture

```
index.html          Page structure (no framework)
styles.css          Dark monitoring theme
app.bundle.js       Bundled app (esbuild; dash.js + plugin + UI code)
src/
  main.js           Player setup, plugin events → UI (pill, counters, log, issues)
  cawg.js           Reads the C2PA manifest box of a segment → cawg.* assertions
  json-tree.js      Interactive JSON tree (path-based expansion state)
  messages.js       Status labels and sequence-anomaly messages
  demo.js           Sample events/manifest for demo mode
build.mjs           esbuild configuration
```

Plugin wiring (core of `src/main.js`):

```js
import { MediaPlayer } from 'dashjs';
import { attachC2pa, C2paEvent } from '@qualabs/c2pa-live-dashjs-plugin';

const player = MediaPlayer().create();
const c2pa = attachC2pa(player);                       // before initialize()!
c2pa.on(C2paEvent.INIT_PROCESSED, e => { /* manifest, session keys */ });
c2pa.on(C2paEvent.SEGMENT_VALIDATED, r => { /* per-segment status */ });
c2pa.on(C2paEvent.ERROR, e => { /* internal errors */ });
player.initialize(videoEl, mpdUrl, true);
```

Segment statuses reported by the plugin: `valid`, `invalid`, `replayed`,
`reordered`, `missing`, `warning`, `unverified`.

> **Gotcha in dashjs 5.x:** the ESM build of dashjs 5 has no working default
> export — hence the named import `{ MediaPlayer }`.

### CAWG per segment

While a stream is validated via **VSI** (session keys in the init segment), the
plugin only reports the manifest of the *init* segment — but signers such as
Unified Origin put the CAWG assertions into the C2PA manifest box of every media
segment. `src/cawg.js` therefore reads them straight from the segment bytes via
an own dash.js response interceptor:

```js
player.addResponseInterceptor(async (response) => {
  const box = extractC2paManifestBox(response.data); // uuid box, copied
  if (box) queueMicrotask(() => {
    const manifest = readManifestBox(box);           // JUMBF → c2pa.assertions
    show(pickCawgAssertions(manifest.assertions));   // cawg.metadata, cawg.identity
  });
  return response;                                   // never delay the segment
});
```

Only the C2PA box is copied out of the response (not the whole segment), and
parsing happens outside the interceptor chain. It is purely structural — hash
and signature validation stays with the plugin. The same data is what
`c2patool -d` reports for an init segment concatenated with a media segment:

```bash
wget http://<origin>/channel1/channel1.isml/dash/video=1200000.dash
wget http://<origin>/channel1/channel1.isml/dash/video=1200000-<time>.dash
bbe -e 's/uuid/free/' video=1200000.dash > init.mp4   # blank out the init manifest
cat init.mp4 video=1200000-<time>.dash > segment.mp4
c2patool -d segment.mp4                               # → "cawg.metadata": { … }
```

## Sources

- [@qualabs/c2pa-live-dashjs-plugin (npm)](https://www.npmjs.com/package/@qualabs/c2pa-live-dashjs-plugin)
- [C2PA Live Video Toolkit (GitHub)](https://github.com/qualabs/c2pa-live-video-toolkit)
- [C2PA specification 2.4, §19.4 Verifiable Segment Info](https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html#verifiable_segment_info)
- [Qualabs: C2PA for live video](https://www.qualabs.com/our-work/c2pa-for-live-video-how-to-sign-and-authenticate-content-in-real-time)
- [dash.js (DASH Industry Forum)](https://github.com/Dash-Industry-Forum/dash.js)
