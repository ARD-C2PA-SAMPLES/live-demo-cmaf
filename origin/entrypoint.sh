#!/bin/sh
set -e

# Validate license key variable is set
if [ -z "$UspLicenseKey" ] && [ -z "$USP_LICENSE_KEY" ]
  then
  echo >&2 "Error: UspLicenseKey environment variable is required but not set."
  exit 1
elif [ -z "$UspLicenseKey" ]
  then
  export UspLicenseKey=$USP_LICENSE_KEY
fi

# write license key to file
echo "$UspLicenseKey" > /etc/usp-license.key

# If specified, override default log level and format config
if [ "$LOG_FORMAT" ]
then
  export EXTRA_OPTIONS="$EXTRA_OPTIONS -D LOG_FORMAT"
fi
if [ "$LOG_LEVEL" ]
then
  export EXTRA_OPTIONS="$EXTRA_OPTIONS -D LOG_LEVEL"
fi

# Remote storage URL and storage proxy config
if [ "$REMOTE_STORAGE_URL" ]
then
  export EXTRA_OPTIONS="$EXTRA_OPTIONS -D REMOTE_STORAGE_URL"
  if [ -z "$REMOTE_PATH" ]
  then
    export REMOTE_PATH=remote
  fi
fi
if [ "$S3_ACCESS_KEY" ]
then
  export EXTRA_OPTIONS="$EXTRA_OPTIONS -D S3_ACCESS_KEY"
fi
if [ "$S3_SECRET_KEY" ]
then
  export EXTRA_OPTIONS="$EXTRA_OPTIONS -D S3_SECRET_KEY"
fi
if [ "$S3_SECURITY_TOKEN" ]
then
  export EXTRA_OPTIONS="$EXTRA_OPTIONS -D S3_SECURITY_TOKEN"
fi
if [ "$S3_REGION" ]
then
  export EXTRA_OPTIONS="$EXTRA_OPTIONS -D S3_REGION"
fi

# REST API
if [ "$REST_API_PORT" ]
  then
  export EXTRA_OPTIONS="$EXTRA_OPTIONS -D REST_API_PORT"
fi

# Change 'Listen 80' to 'Listen 0.0.0.0:80' to avoid some strange issues when IPv6 is available
/bin/sed -i "s@Listen 80@Listen 0.0.0.0:80@g" /etc/apache2/httpd.conf

rm -f /run/apache2/httpd.pid

# Trusted Media (C2PA): stage the AIX document next to the publishing point
# and reference it from the server manifest so Unified Origin signs the
# stream during dynamic packaging. Requires a license key with the
# Media Authenticity (beta) feature enabled, see README. Without that
# feature segment requests would fail with
# 'FMP4_403 media_authenticity: no policy for trusted media',
# so fall back to an unsigned stream when the license does not allow it.
if [ "$AIX_FILE" ]
  then
  if [ ! -f "$AIX_FILE" ]
    then
      echo >&2 "Warning: AIX_FILE=$AIX_FILE not found, publishing point will NOT be C2PA signed."
  elif ! mp4split --show_license 2>/dev/null | grep "Media Authenticity:" | grep -qv ": No"
    then
      echo >&2 "Warning: license key has no Media Authenticity (beta) feature,"
      echo >&2 "         publishing point will NOT be C2PA signed."
      echo >&2 "         Contact support@unified-streaming.com to enable Trusted Media."
  else
    AIX_NAME=$(basename "$AIX_FILE")
    mkdir -p /var/www/unified-origin/$PUB_POINT_NAME
    cp "$AIX_FILE" "/var/www/unified-origin/$PUB_POINT_NAME/$AIX_NAME"
    PUB_POINT_OPTS="$PUB_POINT_OPTS --aix=$AIX_NAME"
    echo "Trusted Media: publishing point will be C2PA signed using $AIX_NAME"
  fi
fi

# create ingest publishing point
if [ ! -f /var/www/unified-origin/$PUB_POINT_NAME/$PUB_POINT_NAME.isml ]
  then
    mkdir -p /var/www/unified-origin/$PUB_POINT_NAME
    chown -R apache:apache /var/www/unified-origin/$PUB_POINT_NAME
    mp4split \
      -o "/var/www/unified-origin/$PUB_POINT_NAME/$PUB_POINT_NAME.isml" \
      $PUB_POINT_OPTS
fi


# First arg is `-f` or `--some-option`
if [ "${1#-}" != "$1" ]; then
  set -- httpd $EXTRA_OPTIONS "$@"
fi

exec "$@"
