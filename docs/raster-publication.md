# Raster publication recovery contract

Raster eligibility assessment is an upstream catalog contract. Publication
does not define CRS eligibility or rewrite a source raster; it makes every
remaining GeoServer runtime outcome safe, observable, and retryable.

## Source identity

The scanner persists one canonical raster identity in this order: inode, byte
size, nanosecond modification time, and nanosecond metadata-change time. Inode
detects replacement at the same mounted path, size and modification time detect
content changes, and metadata-change time strengthens mutation and replacement
detection. Assessment, publication, catalog-authorized analysis, detail-only
preview, and process-local WMS authorization all use this same typed identity.

Filesystem device number is not part of raster identity. It names the current
mount instance rather than the GeoTIFF and can change when an unchanged
NFS-backed source is remounted into a replacement container. Catalog records
written with the former five-field representation remain readable through an
explicit compatibility parser that discards only the leading device number;
the catalog is not rewritten during publication. Malformed assessment identity
metadata receives a distinct reassessment error, while a mismatch in any
retained field continues to report a changed source.

## Publication state

Before mutating GeoServer, EOLab reads the initializer-owned workspace and
shared `dynamic-raster` style, then the selected raster's coverage store,
configured coverage, and layer. Resource inspection accepts exactly `200`
(present) or `404` (absent).

| Store | Coverage | Layer | Transition |
| --- | --- | --- | --- |
| absent | absent | absent | Create the external GeoTIFF publication, verify all three resources, and assign the shared style. |
| present | present | present | Preserve the resources and idempotently assign the shared style. This is also how a restarted app reauthorizes an existing layer in its process-local registry. |
| present | absent | absent | Delete the orphan store recursively, confirm a clean state, then perform clean creation. |
| any other combination | any other combination | any other combination | Preserve every existing resource and return a configuration failure for administrator inspection. |

Clean external-GeoTIFF creation accepts exactly `201`. Successful creation is
not trusted until the store, coverage, and layer each return `200`. Style
assignment and recursive coverage-store deletion each accept exactly `200`.
An arbitrary other `2xx` response is a contract failure, not implicit success.

If clean creation fails, EOLab best-effort removes the coverage store created
by that attempt. This is safe because the pre-request snapshot proved that no
raster-specific resource existed. If later style assignment fails, the now
healthy store, coverage, and layer are retained; a retry only reconciles the
style. Cleanup can never replace the original publication error, and the next
retry re-inspects the authoritative GeoServer state.

## Failure boundary

Every rejected REST response is logged with a stable operation name, HTTP
status, and at most 512 response characters. Control characters are collapsed,
common authorization and secret forms are redacted, file URLs are removed,
and request headers, credentials, and source request bodies are never logged.
Transport logs use fixed details instead of exception text that could contain
an internal URL.

The rendering API exposes a concise message and one stable category:

| Category | Meaning and recovery |
| --- | --- |
| `reader_rejection` | GeoServer rejected the raster reader or CRS configuration; verify GeoTIFF/CRS compatibility and retry. |
| `connectivity` | GeoServer could not be reached; retry when the service is reachable. |
| `authentication` | Internal GeoServer credentials were rejected; an administrator must verify deployment credentials. |
| `timeout` | GeoServer did not complete the operation in time; retry publication. |
| `configuration` | Initialized prerequisites are absent or existing raster resources are inconsistent; an administrator must inspect or redeploy GeoServer. |
| `upstream_failure` | Another exact REST contract failed; retry and use the bounded application log if it persists. |

The browser preserves the category on its rendering error and displays the
server-provided actionable message beside **View on map**. GeoServer remains
private, and WMS requests continue to accept exactly one app-authorized layer.
