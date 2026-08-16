#!/bin/sh
#
# Started by nginx (rtmp exec_push) for every stream that is published:
#
#   /usr/local/bin/ingest.sh <application> <stream name>
#
# It reads the published stream back out of the local RTMP server and hands
# it to the CMAF command builder in entrypoint.py, which transcodes it into
# the tracks configured through TRACKS and ingests them into Unified Origin
# (DASH-IF Live Media Ingest Protocol, Interface 1).
#
set -e

app=${1:-live}
name=${2:-stream}

# nginx does not pass this container's environment on to the processes it
# spawns, docker-entrypoint.sh writes it here instead
if [ -f /etc/rtmp-ingest.env ]; then
    . /etc/rtmp-ingest.env
fi

# pull the stream from the local RTMP server instead of listening for the
# encoder ourselves - nginx already terminates the encoder connection
RTMP_URL="rtmp://127.0.0.1:1935/${app}/${name}"
RTMP_LISTEN=0

# lets the statistics UI tell the transcoder apart from ordinary players
RTMP_FLASHVER="USP-CMAF-Transcoder"

export RTMP_URL RTMP_LISTEN RTMP_FLASHVER

echo "ingest: $app/$name -> ${PUB_POINT_URI}" >&2

# exec, so the TERM signal nginx sends when the encoder disconnects reaches
# entrypoint.py directly - it stops ffmpeg and makes sure it is really gone
exec python3 /usr/local/bin/entrypoint.py
