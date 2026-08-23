# Bounded sampled-raster visualization

EOLab keeps normal full visualization and bounded sampled visualization as
separate contracts. Normal visualization publishes an eligible raster to
GeoServer and permits authorized WMS tiles. A sampled raster is a synthetic,
approximate grid built by Rasterio in EOLab from a fixed number of observed
source pixels. It is not a whole-raster read, an overview pyramid, or permission
for arbitrary WMS requests.

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

For the first two modes the user chooses one closed density profile. These are
ceilings, not browser-controlled dimensions:

| Density | Maximum target-grid edge |
| --- | ---: |
| Coarse | 31 cells |
| Medium | 63 cells |
| Fine | 127 cells |

The widget reports the actual base and current-view grid dimensions returned by
the server. Aspect ratio and safety coarsening can make an actual grid smaller
than its profile ceiling.

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

The first grid in the session that contains finite observations establishes one
immutable color range. Usually that is the base grid; when the base is entirely
nodata, the first finite current-view grid establishes it instead. Later grids
reuse that range, so an equal numeric value keeps the same color across
base/detail seams. Nodata remains alpha-transparent.

## Source-read proof and output bounds

Policy `bounded-sampled-raster-v3` constructs its target grid directly in
EPSG:3857. For each cell it transforms only the fixed center or five
representative positions into the raster CRS, applies the inverse source affine
transform (including rotated or skewed grids), and discards positions outside
the source. It never reads the potentially enormous source-pixel envelope of a
view.

Valid source positions are deduplicated and grouped by their native TIFF block.
Each required band-one block is read exactly once at base resolution with no
`out_shape`, resampling, or boundless read. A candidate grid is deterministically
reduced until both ceilings hold:

- at most 1,024 unique native-block reads; and
- at most 64 MiB of conservatively estimated decoded band-one values plus
  their in-memory validity bytes.

One attempted fine representative grid transforms at most 127 × 127 × 5 =
80,645 positions before deduplication. If that grid exceeds a source-read
ceiling, deterministic safety coarsening may try each of the 64 odd edge sizes
from 127 through 1. The request-level ceiling is therefore 1,747,520 transformed
positions across all attempts, while peak transformation memory is one attempted
grid. Transformation is bounded CPU/memory work and cannot cause an unbounded
GDAL source read. The already map-aligned numeric grid is returned at no more
than its selected 31, 63, or 127 edge. Patch candidates use the same block/byte
ceilings and an output edge of at most 128.

## Caching and source changes

Reads share the configured bounded Rasterio concurrency and process-local LRU.
Identical work is coalesced. The number of admitted distinct in-flight cache
identities is capped at the same configured concurrency; excess distinct work
receives an actionable busy conflict instead of accumulating a viewport-request
backlog. Cache identity includes Collection and Item, assessed source signature,
cataloged raster extent, policy v3, preview mode, density, exact effective view
bounds, transformed-position, native-block, and byte ceilings, fixed probe
offsets, and patch selection parameters. The source signature is checked before
and after pixel work; changed files are neither returned nor cached.

## Why this is not normal full-raster visualization

GeoServer output buffers and request concurrency bound output/control flow, not
GDAL source reads. EOLab therefore does not weaken the overview policy, publish
the overview-limited raster, or authorize it through the WMS proxy. The map
contains only fixed, bounded observations and remains visibly pixelated and
labeled approximate. Building proper internal overviews remains the path to
normal full-raster visualization.
