# C2PA Live · DASH Player

Static website for playing DASH live streams with **real-time C2PA validation**
(Content Credentials). Playback via [dash.js](https://github.com/Dash-Industry-Forum/dash.js),
validation via [@qualabs/c2pa-live-dashjs-plugin](https://www.npmjs.com/package/@qualabs/c2pa-live-dashjs-plugin)
(SVTA Common Media Library, C2PA spec §19 “Live Video”).

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
- [C2PA specification 2.3, §19 Live Video](https://c2pa.org/specifications/specifications/2.3/specs/C2PA_Specification.html#_live_video)
- [Qualabs: C2PA for live video](https://www.qualabs.com/our-work/c2pa-for-live-video-how-to-sign-and-authenticate-content-in-real-time)
- [dash.js (DASH Industry Forum)](https://github.com/Dash-Industry-Forum/dash.js)
