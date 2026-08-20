# glitch-proxy

HTTPS reverse proxy in front of the live stream that flips bits in CMAF media
segments on their way to the player, so the C2PA validation in
`c2pa-live-dashjs` has something to fail on.

```
              :8443  tls-proxy    ->  clean stream
browser
              :8444  glitch-proxy ->  same stream, every Nth segment damaged
                     /glitch/     ->  control panel
```

Both ports serve the same player and the same origin layout, so the only
difference between the two windows is the bit that was flipped.

## Running

Comes up with the `tls` profile of the top level `docker-compose.yaml` (it
reads the certificate from `../tls/`), or on its own with the `glitch`
profile:

```bash
docker compose --profile glitch up -d glitch-proxy
```

## How it decides what to break

1. Only responses from the stream upstream are candidates (`STREAM_PREFIXES`,
   `/channel1/` by default), and only those that look like a segment by
   content type or file extension.
2. The body is parsed as ISOBMFF. A segment carrying `moov` is an
   *initialization* segment and is left alone - breaking those kills the
   decoder outright and every later error becomes noise. Only `moof`+`mdat`
   segments are touched.
3. The segment name is reduced to a representation key
   (`channel1-video=4000000-9000000.m4s` -> `channel1-video=4000000.m4s`) and
   counted, so `every: 5` means every 5th segment *per track*, not every 5th
   HTTP request across four tracks.
4. If the count is due and the track matches `tracks`, `bits` bit flips are
   placed inside the boxes selected by `target`. Positions are derived from a
   hash of path and count, so the same segment always breaks the same way.
   If the segment carries no such box the segment is left alone and the
   response says `X-Glitch: no-target` - a silent no-op would look exactly
   like a broken proxy.
5. The verdict is remembered per segment URL, so a URL that is requested again
   gets the same answer and the same bytes. That matters more than it sounds:
   dash.js retries at the live edge, the DVR window can be seeked into, and a
   demo tends to have two tabs open on the proxy - deciding per request
   instead would let those two tabs see different bytes for one segment and
   would halve the cadence each of them sees. Switching `enabled` off is the
   one thing that overrides the memory, so the stream cleans up at once.

## API

| method | path | does |
| --- | --- | --- |
| `GET` | `/glitch/` | control panel |
| `GET` | `/glitch/api/config` | config, counters, stats and the last 50 corrupted segments |
| `POST` | `/glitch/api/config` | partial update, e.g. `{"every": 3, "bits": 4000}` |
| `POST` | `/glitch/api/reset` | zero the counters |
| `GET` | `/glitch/healthz` | healthcheck |

Everything under `/glitch/` except `healthz` is behind HTTP basic auth when
`GLITCH_PASSWORD` is set (`curl -u glitch:glitch ...`). The stream and the
player are not - a viewer needs no credentials, only whoever flips the
switches does.

Response headers on segment responses:

```
X-Glitch: corrupted | clean | skipped | no-target
X-Glitch-Count:   sequence number within the representation (drives the cadence)
X-Glitch-Number:  the $Number$ from the MPD, what the player calls "Segment #"
X-Glitch-Target:  mdat | moof | c2pa | any
X-Glitch-Bits:    how many bits were flipped
X-Glitch-Offsets: byte offsets that were flipped, from the start of the segment
X-Glitch-Note:    why nothing was flipped, when X-Glitch is no-target
```

## Environment

| variable | default | meaning |
| --- | --- | --- |
| `UPSTREAM_STREAM` | `http://live-origin:80` | where `/channel1/` comes from |
| `UPSTREAM_PLAYER` | `http://c2pa-player:80` | where everything else comes from |
| `STREAM_PREFIXES` | `/channel1/` | comma separated path prefixes served from the stream upstream |
| `LISTEN_PORT` | `443` | port inside the container |
| `TLS_CERT` / `TLS_KEY` | `/etc/glitch/certs/server-chain.pem`, `-key.pem` | missing cert falls back to plain HTTP |
| `GLITCH_ENABLED` | `true` | master switch |
| `GLITCH_EVERY` | `5` | corrupt every Nth media segment per representation, `0` = never |
| `GLITCH_BITS` | `1` | bit flips per corrupted segment |
| `GLITCH_TARGET` | `mdat` | `mdat`, `c2pa`, `moof` or `any`, see below |
| `GLITCH_TRACKS` | *(empty)* | regex on the segment name, empty = all tracks |
| `GLITCH_USER` | `glitch` | basic auth user for `/glitch/` |
| `GLITCH_PASSWORD` | *(empty)* | basic auth password; empty disables the prompt |

## Targets, and which failure each one produces

A signed segment from this stack carries C2PA in **two** places, and only one
of them is validated. Picking the wrong one is why corruption can look like it
does nothing:

```
styp  emsg  prft  uuid  moof  mdat
      \__/        \__/  \__/  \__/
       |           |     |     |
       |           |     |     `- target: mdat
       |           |     `------- target: moof
       |           `------------- not a target, see below
       `------------------------- target: c2pa
```

| target | box | what the player does |
| --- | --- | --- |
| `mdat` | media payload | the hash over the segment no longer matches: *Cryptographic verification failed*, picture usually keeps running |
| `c2pa` | `emsg`, `urn:c2pa:verifiable-segment-info`, whose message_data is a **COSE_Sign1** | the per segment signature fails to verify - this is the one that produces validation errors |
| `moof` | fragment header | the decoder fails, not the signature |
| `any` | anywhere | whatever it hits |

The top level `uuid` box - the C2PA manifest store (JUMBF) - is deliberately
**not** a target. It is what `cawg.js` reads to display the CAWG assertions,
while the validator verifies the `emsg` signature and never looks at it, so
corrupting it produces no validation error and only looks like a broken proxy.

For `c2pa` only the message_data is touched, never the scheme URI or the
timing fields ahead of it - flipping a bit in those makes the player *ignore*
the event rather than fail on it.

## Caveats

A segment has to be buffered to be rewritten, so the glitched stream lags the
clean one slightly and chunked low latency delivery is flattened to one
response per segment. `Accept-Encoding: identity` is forced upstream, because
flipping a bit inside a gzip stream produces a decode error rather than a
broken segment. Demo tool - not something to put in front of anything real.
