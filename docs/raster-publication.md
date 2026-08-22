# Raster publication recovery contract

Raster eligibility assessment is an upstream catalog contract. Publication
does not define CRS eligibility or rewrite a source raster; it makes every
remaining GeoServer runtime outcome safe, observable, and retryable.

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
