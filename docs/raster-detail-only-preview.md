# Raster detail-only visualization

EOLab keeps **normal full visualization** and **detail-only visualization** as
separate contracts. Normal visualization publishes an eligible raster to
GeoServer and permits authorized WMS tiles across its extent. Detail-only
visualization never publishes the raster and never asks GeoServer for a
full-extent map. EOLab reads a small, fixed amount of band-1 data with
Rasterio/GDAL and places only those observations in EOMap.

## Applicability

The fallback is offered only when the current `raster-v3` assessment rejects
normal visualization for one of these overview/scale reasons:

- `internal_overviews_required`
- `incomplete_overview_pyramid`
- `coarsest_overview_dimension_exceeded`
- `coarsest_overview_decoded_size_exceeded`

The deployed GeoServer/GeoTools reader must also accept the raster and its CRS
under the current reader contract. Reader/CRS incompatibility takes precedence
over the fallback. Unsafe source blocks, unsupported band counts or pixel
types, stale sources, invalid extents, and publication failures retain their
existing actionable failures. Detail-only visualization is not a publication
recovery path.

The browser sends only the scanner-owned Collection ID, Item ID, and one fixed
preview mode to `POST /api/rendering/detail-previews`. EOLab reloads the
authoritative Item, resolves its data Asset inside the configured read-only
scan mount, and compares the current filesystem source signature with the
assessment. Browser-supplied paths, bands, dimensions, budgets, CRS values,
and arbitrary GeoServer layer names are not accepted.

## Preview choices and bounds

All preview responses identify themselves as approximate and include the
cataloged **raster extent**. The dashed extent shown in EOMap is not a measured
valid-data footprint.

| Choice | Fixed work bound | Meaning |
| --- | --- | --- |
| Center-pixel sample | One 1 × 1 source-window read | The value and true cell-center position of the source raster's center cell. Nodata is returned as `null` and labeled nodata; it is never converted to zero. |
| Small, bounded sampling grid | A deterministic 5 × 5 grid; at most 25 separate 1 × 1 source-window reads | Sparse observations spanning the raster. Every marker retains its source row, column, longitude, and latitude. It does not interpolate or fill unsampled space. |
| Representative, bounded detail patch | At most nine 128 × 128 source-window reads | A deterministic three-by-three set of candidate locations is ranked by valid finite-pixel coverage, then population standard deviation, then top-left row-major order. The selected already-read window is warped into one 128 × 128 WGS 84 transparent PNG and placed at the returned detail bounds. |

The representative policy does not search the whole raster and cannot promise
to find globally representative or even valid data outside its nine candidates.
If every candidate contains only nodata or non-finite values, EOLab reports that
bounded search honestly. The grayscale stretch is computed only from the
selected patch's finite values and is presentation-only.

## Concurrency, caching, and stale state

Detail reads share the configured bounded Rasterio read concurrency and a
bounded process-local LRU capacity. In-flight identical work is coalesced.
Cache identity includes Collection and Item identity, the assessed source
signature, cataloged raster extent, `bounded-detail-preview-v1`, preview mode,
and the fixed center/grid/candidate-location parameters. The source signature
is checked before and after pixel work; changed files are neither returned nor
cached.

The frontend aborts superseded requests and also compares a monotonic intent
generation after completion. This second check prevents a response from
replacing current map state when network cancellation loses a race. A failed
replacement keeps the existing preview visible.

## Why this is not full-raster visualization

GeoServer response buffers and concurrent-request limits bound output and
control flow, not GDAL source reads. EOLab therefore does not weaken the normal
overview policy and does not authorize an overview-limited raster through the
WMS proxy. Pixels not explicitly represented by the selected samples or patch
remain unknown. Building overviews, safe scale-gated WMS detail tiles, and
user-positioned patches may be added separately without changing these three
fixed preview guarantees.
