#!/bin/sh
#
# Entrypoint of the nginx-rtmp ingest container.
#
# nginx is the container's main process and stays up regardless of whether an
# encoder is connected. The FFmpeg transcoder is spawned per published stream
# by the RTMP module (see exec_push in nginx.conf), which means it does not
# inherit this container's environment - so everything the transcoder needs is
# written to /etc/rtmp-ingest.env for ingest.sh to source.
#
set -e

: "${PUB_POINT_URI:=http://live-origin/channel1/channel1.isml}"
: "${DNS_RESOLVER:=127.0.0.11}"
: "${HOSTNAME:=$(hostname)}"
export PUB_POINT_URI DNS_RESOLVER HOSTNAME

python3 - <<'PY'
import json
import os
import shlex
from urllib.parse import urlsplit

# passed through to ingest.sh / entrypoint.py
KEYS = ("PUB_POINT_URI", "TRACKS", "FRAME_RATE", "GOP_LENGTH", "LOGO_OVERLAY",
        "HOSTNAME")

if not urlsplit(os.environ["PUB_POINT_URI"]).hostname:
    raise SystemExit("PUB_POINT_URI does not contain a host: %r"
                     % os.environ["PUB_POINT_URI"])

with open("/etc/rtmp-ingest.env", "w") as env_file:
    for key in KEYS:
        value = os.environ.get(key)
        if value:
            env_file.write("export %s=%s\n" % (key, shlex.quote(value)))

pub_point_uri = os.environ["PUB_POINT_URI"]

# shown by the statistics dashboard
with open("/var/www/html/ingest.json", "w") as info_file:
    json.dump({"pub_point_uri": pub_point_uri}, info_file)

# Let the dashboard poll the state of the publishing point through nginx,
# the origin runs on a different origin (as in CORS) than this UI. The URI
# goes through a variable on purpose: that defers name resolution to request
# time, so this container also starts when the origin is not up yet.
state_uri = pub_point_uri.rstrip("/") + "/state"
with open("/etc/nginx/dynamic/origin-state.conf", "w") as conf_file:
    conf_file.write(
        "location = /origin/state {\n"
        "    resolver %s ipv6=off valid=10s;\n"
        "    set $origin_state_uri \"%s\";\n"
        "    proxy_pass $origin_state_uri;\n"
        "    proxy_connect_timeout 2s;\n"
        "    proxy_read_timeout 3s;\n"
        "    add_header Cache-Control \"no-store\" always;\n"
        "}\n" % (os.environ["DNS_RESOLVER"], state_uri)
    )

print("rtmp-ingest: publishing point %s" % pub_point_uri)
print("rtmp-ingest: RTMP ingest     rtmp://<host>:1935/live/<stream>")
print("rtmp-ingest: statistics UI   http://<host>:8080/stat")
PY

# The transcoder is a child of nginx, which points its stdio at /dev/null,
# so nginx.conf redirects it into this file - follow it into the container
# log to keep `docker compose logs` useful.
TRANSCODER_LOG=/var/log/nginx/transcoder.log
: > "$TRANSCODER_LOG"
chown www-data:www-data "$TRANSCODER_LOG"
tail -n 0 --follow=name --retry "$TRANSCODER_LOG" &

exec "$@"
