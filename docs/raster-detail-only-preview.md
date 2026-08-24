# Adaptive bounded raster visualization

EOLab keeps normal full visualization and adaptive bounded visualization as
separate contracts. Normal visualization publishes an eligible raster to
GeoServer and permits authorized WMS tiles. At broad scales, adaptive detail is
a synthetic, approximate grid built by Rasterio in EOLab from an exact
user-selected longest-edge resolution and a fixed number of observed source
pixels per cell. At a close enough scale it becomes a complete, exact read of
one strictly bounded native source window. Neither representation is a
whole-raster read, an overview pyramid, or permission for arbitrary WMS
requests.

## Applicability and authorization

This fallback is offered only when the current `raster-v3` assessment rejects
normal visualization for an overview/scale reason:

- `internal_overviews_required`
- `incomplete_overview_pyramid`
- `coarsest_overview_dimension_exceeded`
- `coarsest_overview_decoded_size_exceeded`

The deployed GeoServer/GeoTools reader must still accept the raster and its CRS,
and the structural assessment must report bounded native blocks. Reader or CRS
incompatibility, unsafe blocks, unsupported band counts or pixel types, stale
sources, invalid extents, and publication failures retain their actionable
failures. This mode is not a publication recovery path.

The browser sends scanner-owned Collection and Item IDs, one fixed preview mode,
and, for sampled grids, a server-owned density name. A refinement may also send
one canonical non-wrapping WGS 84 map rectangle. EOLab reloads the authoritative
Item, resolves its Asset inside the configured read-only scan mount, and checks
the current source signature. Browser-supplied paths, source windows, numeric
dimensions, work budgets, CRS values, styles, and GeoServer layer names are not
accepted.

The authorized signature owns only the GeoTIFF, so georeferencing and validity
metadata must be embedded in that signed file. External GDAL masks, overviews,
and auxiliary metadata are rejected. Alpha and per-dataset masks are also
unsupported by this bounded band-one path.

## Preview choices and density

Every response is labeled approximate and includes the cataloged **raster
extent**. The orange dashed outline is the raster extent, not a measured
valid-data footprint. Every displayed image must remain inside that extent;
backend and browser validators allow only `1e-9` degree of projection
roundoff. Raster/detail outlines use a noninteractive pane above the opaque
sampled images, while the temporary-AOI pane remains above both.

While the mode is active, a prominent noninteractive notice is displayed over
the map. It explains that the raster cannot be shown safely at full extent
because it lacks a usable overview pyramid, distinguishes sampled proxies from
exact bounded source detail, and reports the dimensions of the representation
currently laid over the map. The notice is removed with the adaptive raster.

| Choice | Meaning |
| --- | --- |
| Center sample in each proxy cell | Each map-aligned grid cell displays its center source pixel. A nodata center remains transparent; it is never converted to zero. |
| Representative samples in each proxy cell | Each cell examines the center plus four fixed quadrant-center positions. Duplicate source positions are removed. The lower median observed finite value is displayed with value/row/column deterministic ordering. An all-nodata cell remains transparent. |
| Representative bounded detail patch | At most nine 128 × 128 source windows are ranked by finite valid-pixel coverage, then population standard deviation, then top-left row-major order. The selected already-read window is displayed at its true spatial location. |

For the first two modes the user chooses one closed, exact longest-edge
profile. The browser selects only these server-owned profiles; it cannot supply
arbitrary numeric dimensions:

| Density | Cells on the longest projected edge |
| --- | ---: |
| Coarse | 31 |
| Medium | 63 |
| Fine | 127 |

The shorter edge is calculated from the EPSG:3857 display rectangle's width to
height ratio, rounded to the nearest cell with a minimum of one. Thus a 2:1
landscape rectangle at Fine is 127 × 64, while the corresponding portrait
rectangle is 64 × 127. The selected count is always used on the longer edge;
EOLab never silently substitutes a coarser grid. The widget reports the actual
base and current-view dimensions returned by the server. EOLab preflights that
exact grid and returns an actionable conflict before pixel I/O if it would
exceed a fixed source-read limit.

## Zoom-adaptive detail

The initial sampled grid covers the displayable raster extent. Once the map is
at least one zoom level closer than that fitted extent, EOLab places another
grid with the same selected longest-edge density over only the visible
map/raster intersection. At the next zoom level that rectangle is smaller, so
the same longest-edge cell count samples finer-spaced source positions. Panning
requests the same bounded policy over the new intersection.

Before planning that sampled overlay, the server conservatively maps the view
into source pixels and asks whether the entire intersecting native source
window can be read safely. Exact detail is admitted only when both source-window
edges are at most 512 pixels, no more than 1,024 native blocks intersect it, and
the conservative decoded band-plus-validity work is at most 64 MiB. If all
three conditions hold, every source pixel in that one window is read and the
georeferenced result replaces the sampled overlay. Otherwise the selected
31/63/127 longest-edge sampling policy remains in effect. This handoff is
automatic and enforced by EOLab's server; it is not a browser assertion or a
GeoServer request.

Only one teal-outlined current-view detail layer is retained. The Catalog
inspector identifies it as a sampled proxy, exact bounded detail, or a
representative patch and reports its WGS 84 map rectangle, returned dimensions,
native-block count, decoded work, and native source window when one exists. A
200 ms move-end debounce collapses rapid interaction; a new intent aborts the
previous browser
request, and monotonic session plus exact bounds identities prevent stale
responses from replacing current state even when cancellation loses a race.
The HTTP boundary observes that disconnect and releases its service waiter.
Identical cache identities remain coalesced, so one disconnect cannot cancel a
read another waiter still needs. When the last waiter leaves, a thread-safe
cancellation token stops proxy, patch, or exact work before or immediately
after the next native-block read. Python cannot safely terminate a running GDAL
thread in the middle of one block; that block is allowed to return, after which
the dataset closes normally and the worker capacity is released.
If an older bounded read is still occupying the fixed server capacity after
the browser has moved on, the latest stable viewport retries that one transient
busy conflict once per second. Other conflicts remain visible and are not
retried. The compact provenance status includes the actual failure reason while
retaining the prior overlay.
The new overlay is attached before the prior one is removed. Zooming back to
the fitted scale removes only the detail overlay and retains the base grid.
The representative patch remains explicit and does not auto-refine.

The first representation in the session that contains finite observations
initializes the shared color range from that bounded sample's approximate
minimum, median, and maximum. Usually that is the base grid; when the base is
entirely nodata, the first finite current-view representation establishes it
instead. Repeated or constant values receive only the minimum padding needed by
the strictly ordered color contract. Later grids reuse the current range, so an
equal numeric value keeps the same color across base/detail seams. Nodata
remains alpha-transparent.

## Appearance controls and clicked histograms

Sampled rasters use the same palette, numeric threshold, legend, histogram,
and percentile controls as WMS rasters. A palette or threshold change recolors
the bounded numeric images in the browser and atomically replaces both the base
and current-view presentations. It does not publish the raster, send a style to
GeoServer, or read the source again. Reset restores the initial approximate
minimum/median/maximum range.

There is deliberately no whole-raster histogram for an overview-limited
raster. A 1–300 km map window follows the pointer without source I/O. A click,
tap, or **Sample map center** action submits only that canonical WGS 84 window.
The server then reuses the authorized adaptive detail-preview service with the
fixed Fine center policy. A broad window uses exactly 127 spatially placed
point-sample cells on its longest projected edge and an aspect-preserving
shorter edge. A close window uses complete source detail only if the exact
source-window limits are satisfied. Finite displayed values are summarized into
64 bins; nodata and non-finite values are excluded rather than converted to
zero. An all-nodata window reports an actionable error and leaves manual
appearance controls available.

This selected-window endpoint does not accept a missing window, a temporary
AOI, a filesystem path, source dimensions, a source window, or a caller-owned
sampling policy. Changing the clicked window aborts prior browser work, and the
shared statistics controller prevents a late response from replacing the
current selection even if cancellation loses a race. The underlying preview
cache identity already includes source signature, center-sample mode, fine
density, exact window, and policy/resource-bound versions.

The pointer pixel probe remains available in this mode through the same
`/api/raster-analysis/pixels` contract used by normally rendered rasters. The
browser supplies only Collection and Item IDs plus one WGS 84 coordinate. A
dedicated catalog-source authorizer resolves the mounted Asset and checks its
scanner-recorded source identity without inspecting visualization eligibility,
publication state, preview mode, or GeoServer health. The independent pixel
service opens the source once and requests one masked band-one source cell;
nodata is returned as nodata, never zero. The existing 100 ms throttle,
cancellation, and request-sequence rules prevent superseded hover responses
from updating the tooltip. The parent raster viewer coordinates only the
active Item and pointer position. Neither the pixel controller nor its backend
service depends on the WMS or adaptive-preview component.

## Source-read proofs and output bounds

Policy `bounded-adaptive-raster-v6` constructs each sampled target grid directly
in EPSG:3857. Its longest edge is the exact selected density and its shorter
edge follows the target aspect ratio. For each cell it transforms only the fixed
center or five representative positions into the raster CRS, applies the
inverse source affine transform (including rotated or skewed grids), and
discards positions outside the source. It never reads the potentially enormous
source-pixel envelope of a broad view.

Valid source positions are deduplicated and grouped by their native TIFF block.
The exact grid is admitted only when it needs at most 16,129 unique native
blocks: one distinct block for every cell in the largest center-sample grid.
Each required band-one block is then read exactly once at base
resolution with no `out_shape`, resampling, or boundless read. Only requested
values are retained; the block array is discarded before the next block is
read. If the exact grid exceeds the block ceiling, the response fails rather
than changing resolution.

The sampled-proxy fixed bounds are:

- at most 127 × 127 × 5 = 80,645 transformed positions;
- at most 16,129 unique native-block reads; and
- at most 9,663,676,416 cumulative decoded band-one and validity bytes. This
  independent 9 GiB ceiling accommodates 16,129 common 256 × 256 float64
  blocks at nine bytes per source value while still rejecting larger-block or
  multi-probe work that exceeds the fixed total. It bounds total decode work;
  the blocks are streamed and are not retained together.

Each independent pointer probe is bounded to one source open and one 1 × 1
band-one Rasterio window; the underlying native data and validity blocks are
therefore limited to those needed for that cell. The scanner-recorded primary
source signature is checked at authorization and around the read.

The representative patch retains its smaller 64 MiB cumulative decoded-work
ceiling because it reconstructs full candidate windows. Patch output remains at
most 128 × 128.

The exact current-view planner first transforms the EPSG:3857 rectangle into
the source CRS with 21 edge-densification points, encloses the transformed
positions, applies the complete inverse source affine, adds one conservative
source-pixel pad for numeric roundoff, and clips the result to the raster. That
envelope may include pixels outside the visible polygon, but it cannot authorize
reads outside the explicit window. Admission requires all of these independent
bounds:

- source width and height at most 512 pixels each;
- at most 1,024 intersecting native band-one blocks; and
- at most 67,108,864 cumulative decoded band-one and validity bytes.

After admission, each intersecting native block is read once at base resolution
without `out_shape`, boundless reads, or implicit overview selection. Only the
intersecting portion is copied into the complete native window, which is then
nearest-neighbor reprojected from its correct window transform into the map
rectangle. If any exact limit is exceeded, no exact source read occurs and the
request uses the already-selected bounded sampled policy instead.

## Caching and source changes

Reads share the configured bounded Rasterio concurrency and process-local LRU.
Identical work is coalesced. The number of admitted distinct in-flight cache
identities is capped at the same configured concurrency; excess distinct work
receives an actionable busy conflict instead of accumulating a viewport-request
backlog. Cache identity includes Collection and Item, assessed source signature,
cataloged raster extent, policy v6, preview mode, density, exact effective view
bounds, transformed-position, sampled and exact native-block/byte ceilings,
exact dimension, transform-densification and padding values, fixed probe
offsets, and patch selection parameters. The response representation and
source-window provenance follow deterministically from that identity. The
source signature is checked before and after pixel work; changed files are
neither returned nor cached.

## Why this is not normal full-raster visualization

GeoServer output buffers and request concurrency bound output/control flow, not
GDAL source reads. EOLab therefore does not weaken the overview policy, publish
the overview-limited raster, or authorize it through the WMS proxy. The map
contains only fixed, bounded observations or one proven-bounded current-view
source window. It remains visibly pixelated and labeled detail-only; even an
exact current-view window says that it is not a whole-raster rendering.
Building proper internal overviews remains the path to normal full-raster
visualization.
