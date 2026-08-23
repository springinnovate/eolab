# Bounded sampled-raster visualization

EOLab keeps normal full visualization and bounded sampled visualization as
separate contracts. Normal visualization publishes an eligible raster to
GeoServer and permits authorized WMS tiles. A sampled raster is a synthetic,
approximate grid built by Rasterio in EOLab from an exact user-selected number
of map cells and a fixed number of observed source pixels per cell. It is not a
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

| Choice | Meaning |
| --- | --- |
| Center sample in each proxy cell | Each map-aligned grid cell displays its center source pixel. A nodata center remains transparent; it is never converted to zero. |
| Representative samples in each proxy cell | Each cell examines the center plus four fixed quadrant-center positions. Duplicate source positions are removed. The lower median observed finite value is displayed with value/row/column deterministic ordering. An all-nodata cell remains transparent. |
| Representative bounded detail patch | At most nine 128 × 128 source windows are ranked by finite valid-pixel coverage, then population standard deviation, then top-left row-major order. The selected already-read window is displayed at its true spatial location. |

For the first two modes the user chooses one closed, exact square-grid profile.
The browser selects only these server-owned profiles; it cannot supply arbitrary
numeric dimensions:

| Density | Exact target grid |
| --- | ---: |
| Coarse | 31 × 31 cells |
| Medium | 63 × 63 cells |
| Fine | 127 × 127 cells |

The widget reports the base and current-view grid dimensions returned by the
server. A sampled response always matches the selected profile exactly. EOLab
preflights the exact grid and returns an actionable conflict before pixel I/O if
it would exceed a fixed source-read limit; it never substitutes a coarser grid.

## Zoom-adaptive detail

The initial grid covers the displayable raster extent. Once the map is at least
one zoom level closer than that fitted extent, EOLab places another grid with
the same selected density over only the visible map/raster intersection. At the
next zoom level that rectangle is smaller, so approximately the same number of
displayed cells samples finer-spaced source positions. Panning requests the same
bounded grid over the new intersection.

Only one teal-outlined current-view detail layer is retained. A 200 ms move-end
debounce collapses rapid interaction; a new intent aborts the previous browser
request, and monotonic session plus exact bounds identities prevent stale
responses from replacing current state even when cancellation loses a race.
The new overlay is attached before the prior one is removed. Zooming back to
the fitted scale removes only the detail overlay and retains the base grid.
The representative patch remains explicit and does not auto-refine.

The first grid in the session that contains finite observations initializes the
shared color range from that bounded sample's approximate minimum, median, and
maximum. Usually that is the base grid; when the base is entirely nodata, the
first finite current-view grid establishes it instead. Repeated or constant
values receive only the minimum padding needed by the strictly ordered color
contract. Later grids reuse the current range, so an equal numeric value keeps
the same color across base/detail seams. Nodata remains alpha-transparent.

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
The server then reuses the authorized detail-preview service with the fixed
fine center-sample policy: exactly 127 × 127 spatially placed point samples,
subject to the same native-block and decoded-work preflight. Finite points are
summarized into 64 bins; nodata and non-finite points are excluded rather than
converted to zero. An all-nodata window reports an actionable error and leaves
manual appearance controls available.

This selected-window endpoint does not accept a missing window, a temporary
AOI, a filesystem path, source dimensions, a source window, or a caller-owned
sampling policy. The published-raster pixel probe is also disabled because a
sampled raster was never admitted to that authorization registry. Changing the
clicked window aborts prior browser work, and the shared statistics controller
prevents a late response from replacing the current selection even if
cancellation loses a race. The underlying preview cache identity already
includes source signature, center-sample mode, fine density, exact window, and
policy/resource-bound versions.

## Source-read proof and output bounds

Policy `bounded-sampled-raster-v5` constructs its exact square target grid
directly in EPSG:3857. For each cell it transforms only the fixed center or five
representative positions into the raster CRS, applies the inverse source affine
transform (including rotated or skewed grids), and discards positions outside
the source. It never reads the potentially enormous source-pixel envelope of a
view.

Valid source positions are deduplicated and grouped by their native TIFF block.
The exact grid is admitted only when it needs at most 16,129 unique native
blocks: one distinct block for every cell in the largest center-sample grid.
Each required band-one block is then read exactly once at base
resolution with no `out_shape`, resampling, or boundless read. Only requested
values are retained; the block array is discarded before the next block is
read. If the exact grid exceeds the block ceiling, the response fails rather
than changing resolution.

The exact fixed bounds are:

- at most 127 × 127 × 5 = 80,645 transformed positions;
- at most 16,129 unique native-block reads; and
- at most 9,663,676,416 cumulative decoded band-one and validity bytes. This
  independent 9 GiB ceiling accommodates 16,129 common 256 × 256 float64
  blocks at nine bytes per source value while still rejecting larger-block or
  multi-probe work that exceeds the fixed total. It bounds total decode work;
  the blocks are streamed and are not retained together.

The representative patch retains its smaller 64 MiB cumulative decoded-work
ceiling because it reconstructs full candidate windows. Patch output remains at
most 128 × 128.

## Caching and source changes

Reads share the configured bounded Rasterio concurrency and process-local LRU.
Identical work is coalesced. The number of admitted distinct in-flight cache
identities is capped at the same configured concurrency; excess distinct work
receives an actionable busy conflict instead of accumulating a viewport-request
backlog. Cache identity includes Collection and Item, assessed source signature,
cataloged raster extent, policy v5, preview mode, density, exact effective view
bounds, transformed-position, native-block, and mode-specific byte ceilings,
fixed probe offsets, and patch selection parameters. The source signature is
checked before and after pixel work; changed files are neither returned nor
cached.

## Why this is not normal full-raster visualization

GeoServer output buffers and request concurrency bound output/control flow, not
GDAL source reads. EOLab therefore does not weaken the overview policy, publish
the overview-limited raster, or authorize it through the WMS proxy. The map
contains only fixed, bounded observations and remains visibly pixelated and
labeled approximate. Building proper internal overviews remains the path to
normal full-raster visualization.
