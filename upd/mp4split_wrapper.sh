#!/bin/bash

channel_options="--hls.minimum_fragment_length=48/25 --hls.client_manifest_version=7 --hls.fmp4 --archiving 1 --archive_length=7200 --archive_segment_length=600 --dvr_window_length=30 --restart_on_encoder_reconnect --mpd.suggested_presentation_delay=144/25 --mpd.minimum_update_period=48/25 --mpd.minimum_fragment_length=48/25 --mpd.segment_template=time"
channel=$1

if [ ! -f /var/www/unified-origin/rtmp/$channel/$channel.isml ]
then
  /usr/bin/mp4split --license_key=/etc/usp-license.key -o /var/www/unified-origin/rtmp/$channel/$channel.isml $channel_options
fi