#!/bin/sh
set -eu

if ! printf '%s\n' "$GEOSERVER_WMS_RENDER_COUNT" \
    | grep -Eq '^[1-9][0-9]*$'; then
    echo >&2 "GEOSERVER_WMS_RENDER_COUNT must be a positive integer"
    exit 1
fi

if ! printf '%s\n' "$GEOSERVER_MAX_HEAP_SIZE" \
    | grep -Eq '^[1-9][0-9]*[mMgG]$'; then
    echo >&2 "GEOSERVER_MAX_HEAP_SIZE must be an integer followed by m or g"
    exit 1
fi
heap_number=${GEOSERVER_MAX_HEAP_SIZE%?}
case "$GEOSERVER_MAX_HEAP_SIZE" in
    *[mM]) heap_megabytes=$heap_number ;;
    *[gG]) heap_megabytes=$((heap_number * 1024)) ;;
esac
if [ "$heap_megabytes" -lt 256 ]; then
    echo >&2 "GEOSERVER_MAX_HEAP_SIZE must be at least 256m"
    exit 1
fi

export EXTRA_JAVA_OPTS="-Xms256m -Xmx${GEOSERVER_MAX_HEAP_SIZE} \
-javaagent:/opt/eolab-jmx/jmx_prometheus_javaagent-1.6.0.jar=0.0.0.0:9404:/opt/eolab-jmx/jmx-exporter.yml"
printf 'ows.wms.getmap=%s\n' "$GEOSERVER_WMS_RENDER_COUNT" \
    > "${GEOSERVER_DATA_DIR%/}/controlflow.properties"

exec /usr/local/bin/require-read-only-scan-source "$@"
