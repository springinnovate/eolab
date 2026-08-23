# Bounded sampled-raster visualization

EOLab keeps normal full visualization and bounded sampled visualization as
separate contracts. Normal visualization publishes an eligible raster to
GeoServer and permits authorized WMS tiles across its extent. A sampled raster
is instead a low-resolution, synthetic proxy: every displayed cell represents
a much larger source region using only the explicitly selected observations.
It covers the raster extent, but it is not a full-resolution rendering or an
overview pyramid.

## Applicability and authorization

The fallback is offered only when the current `raster-v3` assessment rejects
normal visualization for one of these overview/scale reasons:

- `internal_overviews_required`
- `incomplete_overview_pyramid`
- `coarsest_overview_dimension_exceeded`
- `coarsest_overview_decoded_size_exceeded`

The deployed GeoServer/GeoTools reader must still accept the raster and its CRS
under the current reader contract, and the structural assessment must report
bounded native blocks. Reader/CRS incompatibility, unsafe blocks, unsupported
band counts or pixel types, stale sources, invalid extents, and publication
failures retain their actionable failures. This mode is not a publication
recovery path.

The browser sends only the scanner-owned Collection ID, Item ID, and one fixed
sampling mode to `POST /api/rendering/detail-previews`. EOLab reloads the
authoritative Item, resolves its data Asset inside the configured read-only scan
mount, and compares the current filesystem source signature with the
assessment. Browser-supplied paths, source windows, dimensions, work budgets,
CRS values, styles, and arbitrary GeoServer layer names are not accepted.
Because the established source signature owns only the GeoTIFF, sampled
previews also require georeferencing and validity metadata to be embedded in
that signed file. External GDAL masks, overviews, and auxiliary metadata are
rejected rather than silently entering source reads or cache identity. Alpha
and per-dataset validity masks are unsupported by this bounded band-one path.

## Preview choices

All responses identify themselves as approximate and include the cataloged
**raster extent**. The dashed map outline is the raster extent, not a measured
valid-data footprint.

| Choice | Meaning |
| --- | --- |
| Center sample in each proxy cell | The full source grid is partitioned into a small aspect-preserving grid. Each proxy cell uses the source pixel at the center of its larger source region. A nodata center remains transparent; it is never converted to zero. |
| Representative samples in each proxy cell | Every proxy cell examines the center plus four fixed quadrant-center positions. Duplicate positions are removed. The displayed value is the lower median observed finite source value, with value/row/column ordering as a deterministic tie-break. An all-nodata cell remains transparent. |
| Representative bounded detail patch | At most nine 128 × 128 source windows are ranked by valid finite-pixel coverage, then population standard deviation, then top-left row-major order. The selected already-read window is displayed at its actual spatial location. |

The first two choices are synthetic full-extent rasters, not point markers. A
displayed cell does not contain an average or exhaustive statistic for its
source region; unsampled source pixels remain unknown. The third choice remains
a local detail view and cannot promise that the best data lies within its nine
candidate locations.

## Source-read and output bounds

The `bounded-sampled-raster-v2` policy initially considers an odd grid no larger
than 127 × 127 cells, then deterministically reduces it until both native-source
limits hold:

- at most 1,024 unique band-one native-block reads; and
- at most 64 MiB of conservatively estimated decoded band-one values plus
  their validity-mask bytes.

The center policy uses one position per cell. The representative policy uses at
most five positions per cell. Positions are grouped by their native TIFF block;
each required block is read exactly once at base resolution with no `out_shape`.
Consequently, a logical 1 × 1 observation cannot conceal an unbounded tile or
strip decode. Rasters with more expensive blocks receive a coarser proxy.

Only the resulting bounded in-memory numeric grid and validity mask are warped,
using nearest-neighbor resampling, into a Web-Mercator-aligned image no larger
than 127 × 127. Patch candidates are admitted only while their union of native
blocks remains within the same 1,024-block and 64 MiB ceilings. Each admitted
block is read once; the selected candidate is reconstructed from those bounded
reads and its output edge is at most 128. GDAL never receives a full-source
downsampling request for these previews.

Zooming the map scales this same cached proxy; it does not request a denser
sample grid or unlock ordinary WMS detail tiles. Building internal overviews is
still required for scale-dependent refinement and normal visualization.

The browser colors finite numeric cells with the same default three-stop raster
ramp used by normal visualization. Approximate fifth, median, and ninety-fifth
percentiles from the bounded values provide the numeric thresholds. Nodata is
alpha-transparent. Coloring happens locally and cannot trigger another source
read.

## Concurrency, caching, and stale state

Preview reads share the configured bounded Rasterio read concurrency and a
bounded process-local LRU capacity. In-flight identical work is coalesced.
Cache identity includes Collection and Item identity, assessed source signature,
cataloged raster extent, `bounded-sampled-raster-v2`, preview mode, native-block
and decoded-byte ceilings, maximum dimensions, fixed per-cell offsets, patch
candidate locations, and deterministic selection policy. The source signature
is checked before and after pixel work; changed files are neither returned nor
cached.

The frontend aborts superseded requests and also compares a monotonic intent
generation after completion. A stale response cannot replace current map state
even when network cancellation loses a race. Replacement is atomic: a failed
request or image construction leaves the existing preview visible.

## Why this is not normal full-raster visualization

GeoServer response buffers and concurrent-request limits bound output and
control flow, not GDAL source reads. EOLab therefore does not weaken the normal
overview policy, publish the overview-limited raster, or authorize it through
the WMS proxy. The sampled image deliberately contains only bounded observations
and remains visibly pixelated and labeled approximate. Building proper internal
overviews is still the path to normal full-raster visualization.
