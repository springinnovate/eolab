# Adaptive bounded raster visualization

EOLab keeps normal full visualization and adaptive bounded visualization as
separate contracts. Normal visualization publishes an eligible raster to
GeoServer and permits authorized WMS tiles. Adaptive visualization never
publishes an overview-limited raster. Broad map views instead use one fixed,
approximate Rasterio sample grid; sufficiently close views use one complete,
strictly bounded native source window.

Neither representation grants whole-raster visualization or authorizes an
arbitrary WMS request.

## Applicability and authorization

The fallback is offered only when the current `raster-v3` assessment rejects
normal visualization for an overview/scale reason:

- `internal_overviews_required`
- `incomplete_overview_pyramid`
- `coarsest_overview_dimension_exceeded`
- `coarsest_overview_decoded_size_exceeded`

The deployed GeoServer/GeoTools reader must still accept the raster and its
CRS, and the structural assessment must report bounded native blocks. Reader
or CRS incompatibility, unsafe blocks, unsupported bands or data types, stale
sources, invalid extents, and publication failures remain actionable failures.

The browser sends only scanner-owned Collection and Item IDs and, during
refinement, an optional canonical non-wrapping WGS 84 map rectangle. Sampling
mode, density, source path, source window, dimensions, work budgets, CRS,
style, and GeoServer layer name are not browser inputs. EOLab reloads the
authoritative Item, resolves its Asset inside the configured read-only scan
mount, and checks the source signature around every read.

The authorized signature owns only the GeoTIFF. Georeferencing and validity
metadata must therefore be embedded in that file. External GDAL masks,
overviews, auxiliary metadata, alpha masks, and per-dataset masks are not part
of this bounded band-one contract.

## Fixed sampled policy

Policy `bounded-adaptive-raster-v8` always builds a grid directly in EPSG:3857
with:

- exactly 127 cells on the displayed rectangle's longest edge;
- an aspect-preserving shorter edge, rounded to the nearest cell with a
  minimum of one; and
- exactly one source observation at each map cell's center.

For example, a 2:1 landscape rectangle is 127 × 64 and the corresponding
portrait rectangle is 64 × 127. EOLab never silently substitutes a smaller
grid. A center observation that maps to nodata stays transparent; it is never
converted to zero.

Every response carries `approximate: true`. A `sampleGrid` is explicitly a
low-resolution approximation of the displayed area. The response also carries
the cataloged **raster extent**, which is not a measured valid-data footprint.
The orange dashed map outline is labeled and treated as that extent.

Sample grids use browser image smoothing so their enlarged cell edges look
soft. This is presentation only: it adds no observations and changes no
reported resolution. Exact current-view images use crisp nearest-neighbor
presentation.

## Zoom-adaptive detail

The initial grid covers the displayable raster extent. Once the map is at least
one zoom level closer than the fitted extent, EOLab requests the same fixed
127-longest-edge policy over only the visible map/raster intersection. As that
rectangle shrinks, its 127 centers sample progressively finer source spacing.
Panning requests the same policy at the new location.

Before sampling a current view, the server conservatively maps it into source
pixels and tests whether the complete intersecting source window is safe.
Exact detail is admitted only when all of these hold:

- source width and height are each at most 512 pixels;
- at most 1,024 native blocks intersect the window; and
- decoded band-one values plus validity require at most 67,108,864 bytes.

When admitted, each intersecting block is read once at base resolution, the
complete source window is assembled, and it is nearest-neighbor reprojected at
the same dimensions for map placement. This is labeled exact bounded source
detail at the current scale, not a whole-raster rendering. Otherwise the fixed
center-sample grid remains in effect.

The Catalog inspector reports the active map rectangle, sample dimensions,
native block count, decoded work, and source window when exact detail is
active. A prominent map notice distinguishes approximate sampling from exact
bounded detail.

## Work bounds and cancellation

For each sampled cell, EOLab transforms its fixed center into the raster CRS,
applies the complete inverse source affine (including rotated or skewed
grids), and discards positions outside the raster. It does not read the broad
view's potentially enormous source-pixel envelope.

Valid positions are deduplicated and grouped by native TIFF block. Each
required band-one block is read once at base resolution without `out_shape`,
boundless reads, or overview selection. Requested values are retained and the
block array is released before the next block.

The sample-grid ceilings are:

- at most 127 × 127 = 16,129 transformed positions;
- at most 16,129 unique native-block reads; and
- at most 9,663,676,416 cumulative decoded band-one and validity bytes.

The 9 GiB value bounds cumulative decode work; it is not a simultaneous memory
allocation. It accommodates 16,129 common 256 × 256 float64 blocks at nine
bytes per source value while still rejecting larger work. A request that
exceeds any fixed ceiling fails before pixel I/O instead of changing its grid.

A 200 ms move-end debounce collapses rapid interaction. A new viewport intent
aborts its prior browser request, while session and exact-bounds identities
prevent stale results from replacing current state. The HTTP boundary releases
the service waiter on disconnect. Identical work remains coalesced, so one
disconnect cannot cancel a read another waiter needs. When the final waiter
leaves, a thread-safe token stops work between native-block reads. GDAL is
allowed to finish the current block so the dataset can close normally.

During initial and refinement reads, the map shows a gray processing veil and
spinner. If obsolete work still occupies capacity, only the latest stable view
retries the specific busy conflict. Other failures remain visible and are not
retried.

## Colors, histograms, and pixel probes

The first numeric representation can initialize the shared color range. Later
views reuse the current range so equal values keep equal colors. Palette and
threshold changes recolor the numeric images in the browser without source I/O
or GeoServer publication.

Histograms are not derived from the displayed preview and do not use the
detail-preview service. One rendering-independent catalog analysis endpoint
supports whole-raster, 1–300 km rectangle, and ready temporary-AOI selections
for WMS, adaptive, and analysis-only sessions with no map raster renderer. It
uses an exact bounded native window when safe and otherwise a fixed
127-longest-edge center grid, then summarizes finite values into 64 bins. Its
label reports exact versus approximate provenance. Nodata and non-finite values
are excluded; an all-nodata area reports an actionable error. Hiding the AOI
overlay does not change the selected analysis area.

Pointer probing is independent of map rendering. It uses the shared
`/api/raster-analysis/pixels` contract with Collection and Item IDs plus one WGS
84 position. Its catalog-source authorizer does not depend on preview state,
GeoServer health, or WMS publication. One masked band-one cell is requested and
nodata remains nodata.

The complete authorization, work-bound, lifecycle, and cache contract is in
[Rendering-independent raster analysis](raster-analysis.md).

## Cache identity and source changes

Completed reads use a process-local LRU and identical in-flight work is
coalesced. Distinct admitted work is capped by configured Rasterio concurrency.
Cache identity includes Collection and Item, source signature, raster extent,
policy v8, effective view bounds, the 127-center sampling parameters, sampled
and exact block/byte ceilings, exact dimension, transform densification, and
window padding. A changed source is neither returned nor cached.

## Why this is not normal full visualization

GeoServer output buffers and request concurrency constrain output/control flow,
not GDAL source reads. EOLab therefore does not weaken its overview policy or
send full-extent WMS requests to overview-limited rasters. Broad views contain
only the documented center observations. Close views contain only one source
window whose complete read was proven to fit independent server-owned bounds.
