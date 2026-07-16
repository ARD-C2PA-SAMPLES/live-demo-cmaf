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

The 2x FFmpeg containers send synchronized Video & Audio fragments to Unified Origin. To achieve this, each encoder using its internal system clock (UTC) as reference stamps the fragment with a decode time offset based upon the same algorithm (UTC + Time Scale x Sample Duration).

The default track configuration created is below, however encoding parameters can be updated within the [ffmpeg/entrypoint.py](entrypoint.py).
- Video Track 1 - 1280x720 500k AVC 48GOP@25FPS
- Video Track 2 - 640x360 300k AVC 48GOP@25FPS
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
Play the live stream from host running container:

* Open [DASH stream (http://localhost/channel1/channel1.isml/.mpd)](https://shaka-player-demo.appspot.com/demo/#audiolang=en-GB;textlang=en-GB;uilang=en-GB;asset=http://localhost/channel1/channel1.isml/.mpd;panel=CUSTOM%20CONTENT;build=uncompiled) in latest shaka player
* Open [HLS TS stream (http://localhost/channel1/channel1.isml/.m3u8)](https://hls-js.netlify.app/demo/?src=http://localhost/channel1/channel1.isml/.m3u8) in latest hls.js
* Open [HLS CMAF stream (http://localhost/channel1/channel1.isml/.m3u8?hls_fmp4)](https://hls-js.netlify.app/demo/?src=http://localhost/channel1/channel1.isml/.m3u8?hls_fmp4) in latest hls.js

> **_NOTE:_**
The FFmpeg container is configured to encode multiple video and audio tracks in
realtime. Therefore buffering or stalled experienced when playing the stream
from Unified Origin is subject to the performance of the FFmpeg container. If issues persists, please follow step 4.

## Step 4
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
Play the stream as usual (see Step 3) and validate provenance with the
[C2PA validation player](https://c2pa-unified-streaming.qualabs.dev/)
(the stream URL must be reachable from the internet for the hosted
validator) or locally with [c2patool](https://github.com/contentauth/c2pa-rs)
on a downloaded segment.

For local verification a dash.js based C2PA player is available in the
[C2PA Live Video Toolkit](https://github.com/ARD-C2PA-SAMPLES/c2pa-live-video-toolkit)
under `c2pa-live-dashjs`: a static website that plays DASH live streams
with real-time C2PA validation (interactive manifest tree, validation
issues and per-segment status). Run it with `npm install && npm run build
&& npm run serve` and open http://localhost:8090, then play
`http://localhost/channel1/channel1.isml/.mpd`.

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
