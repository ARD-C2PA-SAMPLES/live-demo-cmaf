# nginx with the RTMP module as live ingest point.
#
# Instead of running FFmpeg as the container's main process (which exits, and
# takes the container with it, as soon as the RTMP publisher disconnects),
# nginx terminates the RTMP session and spawns FFmpeg per published stream
# via exec_push. FFmpeg transcodes the stream into CMAF and ingests it into
# Unified Origin. When the encoder goes away only FFmpeg is torn down; nginx
# keeps listening on 1935 and keeps serving the statistics UI on 8080.
#
# The build context is the repository root (see docker-compose.yaml) so that
# the FFmpeg command builder in ffmpeg/entrypoint.py can be reused as is.
#
FROM ubuntu:24.04

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        nginx \
        libnginx-mod-rtmp \
        ffmpeg \
        python3 \
        fonts-dejavu-core \
        curl \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# nginx logs (and, through them, the FFmpeg output) go to the container log
RUN ln -sf /dev/stdout /var/log/nginx/access.log && \
    ln -sf /dev/stderr /var/log/nginx/error.log && \
    chown -R www-data:www-data /var/log/nginx && \
    mkdir -p /etc/nginx/dynamic

COPY upd/nginx.conf /etc/nginx/nginx.conf
COPY upd/stat.xsl /var/www/html/stat.xsl
COPY upd/ingest.sh /usr/local/bin/ingest.sh
COPY upd/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY ffmpeg/entrypoint.py /usr/local/bin/entrypoint.py

RUN chmod +x /usr/local/bin/ingest.sh \
             /usr/local/bin/docker-entrypoint.sh \
             /usr/local/bin/entrypoint.py

# where the transcoder ingests into, overridden by docker-compose.yaml
ENV PUB_POINT_URI=http://live-origin/channel1/channel1.isml

# 1935 RTMP ingest, 8080 statistics UI
EXPOSE 1935 8080

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
