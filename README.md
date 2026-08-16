![Image](unifiedstreaming-logo-black.jpg?raw=true)
# Unified Streaming Live Origin Demo <br/> DASH-IF Live Media Ingest Protocol - Interface 1 (CMAF)

> [!WARNING]
> This repository and associated container images are **for demo purposes
> only**.
>
> Please refer to our [Installation
> documentation](https://docs.unified-streaming.com/installation/distributions.html)
> on how to install Unified Origin on your desired operating system and
> architecture where addition configuration options maybe required.

## Overview
This project demonstrates the use of [FFmpeg](https://ffmpeg.org/) and [Unified Streaming - Origin Live](http://www.unified-streaming.com/products/unified-origin) to present a Live Adaptive Bitrate presentation.

FFMPEG delivers CMAF tracks to Unified Origin using the [DASH-IF Live Media Ingest Protocol - Interface 1](https://dashif.org/Ingest/#interface-1)

### What to expect from this demo

The stack accepts an **RTMP** contribution feed (OBS, FFmpeg, a hardware
encoder, ...) and turns it into a live DASH/HLS presentation:

```
encoder --RTMP--> nginx-rtmp --> FFmpeg --CMAF/HTTP--> Unified Origin --> player
        :1935      (rtmp-ingest container)                (live-origin container)
```

`nginx` with the [RTMP module](https://github.com/arut/nginx-rtmp-module)
terminates the RTMP session and starts an FFmpeg transcoder per published
stream (`exec_push`). FFmpeg stamps every fragment with a decode time
derived from the system clock (UTC + time scale x sample duration), which is
what keeps the video and audio tracks synchronized, and pushes them to the
publishing point.

Because nginx - not FFmpeg - is the container's main process, the ingest
container survives an encoder that is not connected yet, disconnects or
reconnects: only the transcoder is started and stopped.

The default track configuration created is below, however encoding parameters
can be updated through the `TRACKS` variable in
[docker-compose.yaml](docker-compose.yaml) or in
[ffmpeg/entrypoint.py](ffmpeg/entrypoint.py).
- Video Track 1 - 1280x720 4000k AVC 48GOP@25FPS
- Video Track 2 - 640x360 2400k AVC 48GOP@25FPS
- Audio Track 1 - 64kbps 48kHz AAC-LC - English language
- Audio Track 2 - 64kbps 48kHz AAC-LC - Dutch language

## Disclaimer
This demo utilises software which is still in development and is therefore not intended for production use. A list of known issues affecting this demo can be tracked [here](https://github.com/unifiedstreaming/live-demo-cmaf/issues).


## Prerequisites
Docker, if not already installed see: https://docs.docker.com/get-docker/

Internet access on host through ports 53 and 80; needed to check license key

## Step 1
Start by cloning the Live streaming trial from GitHub and starting the Docker Compose stack:

```
git clone https://github.com/unifiedstreaming/live-demo-cmaf.git

cd live-demo-cmaf

export UspLicenseKey=<your_license_key>

docker compose up -d
```

Instead of exporting the key in every shell you can put it in `.env`, which
docker compose reads automatically:

```
cp .env.example .env
```

and fill in `UspLicenseKey=`. `.env` is git ignored, so the key stays out of
the repository.
## Step 2
Wait for all the Docker images to build and services to start, you can view the status by checking the logs with:

```
docker compose logs
```

And checking the origin is available by querying it with curl:

```
curl http://localhost/channel1/channel1.isml/state
```

Which should respond:

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- Created with Unified Streaming Platform  (version=1.15.5-31515) -->
<smil
  xmlns="http://www.w3.org/2001/SMIL20/Language">
  <head>
    <meta
      name="updated"
      content="2025-04-16T14:47:11.238512Z">
    </meta>
    <meta
      name="state"
      content="started">
    </meta>
  </head>
</smil>
```
## Step 3
Publish an RTMP feed to the ingest container:

```
rtmp://localhost:1935/live/stream
```

Configure that URL in OBS (Settings &#8594; Stream &#8594; Custom, server
`rtmp://localhost:1935/live`, stream key `stream`), or push a test pattern
with FFmpeg:

```bash
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=25 \
       -f lavfi -i sine=frequency=440:sample_rate=48000 \
       -c:v libx264 -preset veryfast -tune zerolatency -g 50 -b:v 2500k \
       -pix_fmt yuv420p -c:a aac -b:a 128k \
       -f flv rtmp://localhost:1935/live/stream
```

The transcoder starts as soon as the encoder connects. Watch it on the
statistics UI: **http://localhost:8080/stat**

## Step 4
Play the live stream from host running container:

* Open [DASH stream (http://localhost/channel1/channel1.isml/.mpd)](https://shaka-player-demo.appspot.com/demo/#audiolang=en-GB;textlang=en-GB;uilang=en-GB;asset=http://localhost/channel1/channel1.isml/.mpd;panel=CUSTOM%20CONTENT;build=uncompiled) in latest shaka player
* Open [HLS TS stream (http://localhost/channel1/channel1.isml/.m3u8)](https://hls-js.netlify.app/demo/?src=http://localhost/channel1/channel1.isml/.m3u8) in latest hls.js
* Open [HLS CMAF stream (http://localhost/channel1/channel1.isml/.m3u8?hls_fmp4)](https://hls-js.netlify.app/demo/?src=http://localhost/channel1/channel1.isml/.m3u8?hls_fmp4) in latest hls.js

> **_NOTE:_**
The transcoder is configured to encode multiple video and audio tracks in
realtime. Therefore buffering or stalled experienced when playing the stream
from Unified Origin is subject to the performance of the ingest container. If issues persists, please follow step 5.

## Step 5
Stop the services by running:

```
docker compose down
```

### Tips
To check when your license key expires:
```
docker exec -it live-demo-cmaf-live-origin-1 mp4split
--show_license
```

To print and tail origin container's logs:
```
docker logs -f live-demo-cmaf-live-origin-1
```
To get into origin container's shell:
```
docker exec -it -w /var/www/unified-origin live-demo-cmaf-live-origin-1 /bin/sh
```

To follow the transcoder (and RTMP) logs:
```
docker logs -f live-demo-cmaf-rtmp-ingest-1
```

## RTMP ingest
The `rtmp-ingest` service ([upd/](upd/)) is nginx with the
[RTMP module](https://github.com/arut/nginx-rtmp-module):

| | |
|---|---|
| `rtmp://localhost:1935/live/<stream>` | ingest, any stream name works |
| `http://localhost:8080/stat` | statistics UI |
| `http://localhost:8080/healthz` | liveness probe |

* [upd/nginx.conf](upd/nginx.conf) - `exec_push` starts
  [upd/ingest.sh](upd/ingest.sh) for every published stream and terminates it
  again when the encoder disconnects (`respawn on` restarts a transcoder that
  dies while the encoder is still up).
* [upd/ingest.sh](upd/ingest.sh) reads the stream back from nginx
  (`rtmp://127.0.0.1:1935/live/<stream>`) and runs
  [ffmpeg/entrypoint.py](ffmpeg/entrypoint.py), which builds the CMAF ingest
  command from `TRACKS` and stops FFmpeg reliably when nginx signals it.
* The transcoder's own output is written to `/var/log/nginx/transcoder.log`
  inside the container and tailed into the container log, because nginx
  points the stdio of the processes it spawns at `/dev/null`.
* [upd/mp4split_wrapper.sh](upd/mp4split_wrapper.sh) is not used here: it
  creates a publishing point locally, which is only needed when nginx and
  Origin run on the same host. In this stack the origin container creates
  `channel1` itself.

> [!NOTE]
> The ingest container uses the distribution build of FFmpeg, not the patched
> build in [ffmpeg/](ffmpeg/). The two out of tree patches there affect the
> CMAF output: `-audio_track_timescale` (only relevant when the audio
> timescale differs from the sample rate - it does not in the default track
> configuration, where the muxer already uses 48000) and an `stss` box in the
> video init segment. If Origin rejects the ingest, build the patched FFmpeg
> from [ffmpeg/Dockerfile](ffmpeg/Dockerfile) and copy `/usr/local` from that
> image into the ingest image.

### Statistics UI
[upd/stat.xsl](upd/stat.xsl) renders the RTMP statistics XML that nginx
serves at `/stat`. It shows the state of the whole chain (encoder &#8594;
nginx-rtmp &#8594; FFmpeg &#8594; the publishing point), ingest/egress
bitrates with a short history, the codecs, resolution and frame rate reported
by the encoder, and every connected client - the publisher, the transcoder
and any player. The page refreshes itself every two seconds by re-applying
the same stylesheet in the browser, so there is no full page reload, and it
pauses while the tab is in the background.

## Trusted Media (C2PA)
This demo signs the live stream with [C2PA](https://c2pa.org/) provenance
metadata using the Unified Streaming
[Trusted Media](https://docs.unified-streaming.com/tutorials/trusted-media/index.html)
workflow (beta).

> [!IMPORTANT]
> Trusted Media requires a license key with the **Media Authenticity**
> feature enabled. This feature is in beta, contact
> [support@unified-streaming.com](mailto:support@unified-streaming.com) to
> get access. You can check your key with:
> `docker exec live-demo-cmaf-live-origin-1 mp4split --show_license`
> (look for `Media Authenticity: Trusted Media`). The origin entrypoint checks this
> at startup: without the feature it logs a warning and starts an
> **unsigned** publishing point instead (forcing `--aix` without the
> license would make every segment request fail with
> `FMP4_403 media_authenticity: no policy for trusted media`).

### How it works
1. `generate-certs-and-aix.sh` creates a self-signed certificate chain
   (root → intermediate → leaf), a session key and assembles them into an
   AIX (Authentication Information eXchange) document, `minimal.aix`, as
   described in the tutorial:

   ```
   ./generate-certs-and-aix.sh
   ```

   The metadata assertions can be customized:

   ```
   AIX_TITLE="My Live Channel" AIX_PUBLISHER="My Broadcaster" ./generate-certs-and-aix.sh
   ```

2. `docker-compose.yaml` mounts `minimal.aix` into the origin container and
   sets `AIX_FILE=/opt/aix/minimal.aix`.
3. On startup the origin entrypoint verifies the license has
   `Media Authenticity: Yes`, copies the AIX document next to the
   publishing point and creates it with `--aix=minimal.aix`, so the server
   manifest references the AIX document and Unified Origin signs the
   stream during dynamic packaging (per request, the origin is stateless).
   The DASH manifest then advertises the signature via
   `<InbandEventStream schemeIdUri="urn:c2pa:verifiable-segment-info">`
   and segments carry the C2PA manifests as inband `emsg` events.
4. Apache denies external HTTP requests to `*.aix` (the document contains
   private keys); only the origin's internal subrequests may read it.

### Verify the signed stream
The `c2pa-player` service ([c2pa-live-dashjs/](c2pa-live-dashjs/)) is part of
the stack: a dash.js based player that validates the Content Credentials
while the stream plays (interactive manifest tree, CAWG assertions per
segment, validation issues and per-segment status). It comes up with
`docker compose up -d` - open it with the stream to play in the URL:

**http://localhost:8090/?url=http://localhost/channel1/channel1.isml/.mpd**

Without `?url=` the player starts empty; pick *Unified Origin local
(live-demo-cmaf)* from the presets or paste any `.mpd` URL. `?src=` is
accepted as well.

> [!NOTE]
> Ordinary DASH players may refuse this stream - the C2PA signature travels
> as inband `emsg` events. Use the player above (or the hosted validator
> below) to play it.

To rebuild the player after changing `c2pa-live-dashjs/src/`:

```bash
docker compose up -d --build c2pa-player
```

Alternatively serve it from the working copy with
`npm install && npm run build && npm run serve` (also on port 8090, so stop
the container first).

Provenance can also be validated with the hosted
[C2PA validation player](https://c2pa-unified-streaming.qualabs.dev/)
(the stream URL must be reachable from the internet for that) or locally
with [c2patool](https://github.com/contentauth/c2pa-rs) on a downloaded
segment.

> [!WARNING]
> The generated certificates and `minimal.aix` contain private keys and are
> for demo purposes only, they are ignored by git on purpose. For production
> use a proper CA-issued signing certificate.

## What's next?
[Learn more about the key features and benefits of using Unified Origin for live streaming](https://docs.unified-streaming.com/documentation/live/index.html)

or

[Contact us](mailto:%20sales@unified-streaming.com) to purchase a license

Watching the stream can be done using your player of choice, for example FFplay.

```bash
#!/bin/sh
ffplay http://localhost/channel1/channel1.isml/.m3u8
```

And it should look something like:

![example](./ffmpeg/example_cmaf.png?raw=true)
