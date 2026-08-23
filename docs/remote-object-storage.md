# Remote object-storage scan contract

EOLab can scan one or more S3-compatible bucket prefixes during the same catalog run as its mounted directories. Remote sources use provider-neutral dataset and object values; only `src/eolab_app/catalog/s3.py` owns S3 listing, signing, HEAD, range-read, and endpoint behavior. Remote objects are never represented as `pathlib.Path` values.

## Deployment configuration

Set `EOLAB_SCAN_REMOTE_S3_SOURCES` to a JSON array. Each entry has exactly four strings:

```json
[
  {
    "id": "research-archive",
    "bucket": "private-geospatial",
    "prefix": "published/",
    "displayName": "Research archive / published"
  }
]
```

`id` is a deployment-stable namespace used in Item identity. Do not rename it after cataloging a source. `bucket` and `prefix` select provider objects. `displayName` is the independent user-facing source description shown in scan paths and Item titles. Prefixes are literal, case-sensitive object-key prefixes and must not begin with `/` or contain a `..` segment. Roots may not overlap within one bucket.

The server-side connection variables are:

- `EOLAB_S3_ENDPOINT_URL`: optional HTTP(S) origin for an S3-compatible provider; omit it for AWS S3.
- `EOLAB_S3_REGION`: signing region, default `us-east-1`.
- `EOLAB_S3_ACCESS_KEY_ID` and `EOLAB_S3_SECRET_ACCESS_KEY`: optional static read-only credentials. Configure both or neither. When omitted, the AWS credential provider chain remains available for workload roles.
- `EOLAB_S3_SESSION_TOKEN`: optional temporary-credential token.
- `EOLAB_S3_LIST_PAGE_SIZE`: objects requested per `ListObjectsV2` call, from 1 through 1,000; default 500.
- `EOLAB_S3_METADATA_CONCURRENCY`: simultaneous remote metadata reads; default 4.

Configure credentials, session tokens, and private endpoints as Coolify secrets. EOLab does not return them through `/api/config`, scan status, errors, STAC Items, or Assets. Items retain unsigned `s3://bucket/key` Asset locations. They also record `eolab:source_kind`, `eolab:source_provider`, the configured source ID, and the listing ETag or version when available. This makes remote capability decisions explicit without authorizing browser access or remote rendering.

## Listing, grouping, and metadata bounds

S3 discovery uses `ListObjectsV2` continuation tokens and requests no more than `EOLAB_S3_LIST_PAGE_SIZE` objects. The scanner releases each listing page after its candidates pass through the existing bounded metadata, progress, failure-isolation, and bulk-upsert pipeline. A Shapefile component group crossing a page boundary retains only the recognized files for its current exact base key. The required `.shp`, `.shx`, `.dbf`, and `.prj` objects and recognized optional sidecars follow the mounted Shapefile rules.

Remote GeoTIFF metadata is opened through GDAL `/vsis3/`, with fixed range-cache and retry limits. It does not use the streaming or HTTP pseudo-drivers that download a whole raster. Remote Shapefile components need coordinated random access across several files. EOLab therefore uses explicit bounded S3 range requests to a temporary directory: no component may exceed 128 MiB and the metadata-required group may not exceed 256 MiB. Optional spatial indexes and XML metadata remain separate catalog Assets but are not downloaded to derive core metadata. Temporary files are removed after each dataset.

Every listed object is checked with HEAD before and after metadata extraction. The scan rejects that dataset result if its size, ETag, or available version changes or if any required object disappears. The isolated error contains no signed URL, credential, or internal endpoint. Unrelated datasets continue.

## Identity, restart, and reconciliation policy

The logical current-object Item ID hashes the configured source ID, bucket, and exact primary key. ETag or provider version is stored on the Asset as the observed revision, not placed in the Item ID. Consequently, rescanning an unchanged object is idempotent, and replacing content at the same key updates the same Item instead of creating a duplicate. Moving an object changes its key and therefore creates a new identity.

Continuation tokens are intentionally scan-local rather than persisted. Cancelling or restarting begins each prefix at its first page; stable Item IDs and catalog upserts make that restart safe. Cancellation stops listing, waits for already-running bounded metadata operations to release resources, cancels pending writes, and does not start new work.

Reconciliation verifies every scanner-owned required Asset before deleting any Item. Mounted `file:` Assets remain confined to the configured mount. Remote `s3:` Assets must remain inside a configured bucket/prefix and are checked with HEAD. A 404 proves an Item stale. Credential, endpoint, or provider failures abort cleanup without deleting anything. Deleted objects are removed from the catalog; moved objects remove the old Item and are cataloged under the new key. If an object changes during metadata extraction but still exists, EOLab retains the prior Item for safety and a later successful scan replaces it.

Remote raster/vector rendering, styling, sampling, and processing are outside this scanner contract. Consumers must inspect `eolab:source_kind` and report remote Assets as an unsupported capability until a separate visualization feature explicitly implements them.
