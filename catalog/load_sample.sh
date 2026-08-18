#!/bin/sh
set -eu

case "${EOLAB_LOAD_SAMPLE_CATALOG}" in
  true)
    pypgstac load collections /catalog/sample/collections.ndjson --method upsert
    pypgstac load items /catalog/sample/items.ndjson --method upsert
    echo "Loaded the EOLab sample Collection and four sample Items."
    ;;
  false)
    echo "Sample catalog loading is disabled."
    ;;
  *)
    echo "EOLAB_LOAD_SAMPLE_CATALOG must be true or false." >&2
    exit 2
    ;;
esac
