# Rendering-independent raster analysis

Raster statistics and pixel probes are catalog analysis operations. They do
not depend on whether the selected raster is published to GeoServer, rendered
through WMS, displayed through adaptive bounded visualization, or not rendered
at all. The browser supplies only the scanner-owned Collection and Item
identity plus an owned sampling-area choice; it never supplies a filesystem
path, source window, CRS, histogram size, or work limit.

`POST /api/raster-analysis/statistics` accepts exactly one of these areas:

- no area field, meaning the whole raster;
- one canonical non-wrapping WGS 84 `selectedBounds` rectangle; or
- one opaque, ready `temporaryAoiId`.

The application resolves the current catalog Asset inside the configured
read-only mount and checks its scanner source signature before and after the
read. Statistics do not consult the published-layer registry, visualization
eligibility, preview state, or GeoServer. Pixel probing is a sibling operation
under `/api/raster-analysis/pixels` and is likewise independent.

## Bounded read policy

Every statistics request first produces one clipped, integral source-pixel
envelope. WGS 84 bounds and temporary AOI polygon edges are densified before
projection into the raster CRS. Temporary AOI polygons, holes, and
MultiPolygons remain polygonal masks rather than being replaced by their
bounding boxes; overlapping components are unioned so a cell cannot count
twice. The response calls the selection an area, not a valid-data footprint.

EOLab then chooses one of two server-owned plans:

- `exactSourceWindow` reads the complete envelope when each edge is at most
  512 source pixels, at most 1,024 native blocks intersect it, and decoded
  band-one values plus validity require at most 64 MiB. The response is marked
  `estimated: false`.
- `sampleGrid` uses exactly one center observation per cell with at most 127
  cells on the envelope's longest edge and an aspect-preserving shorter edge.
  It reads at most 16,129 unique native blocks and at most 9 GiB of cumulative
  decoded source work. The response is marked `estimated: true`.

The sample-grid limits are fixed ceilings, not browser controls. A request that
cannot satisfy them fails before pixel I/O. Each touched native block must
decode to at most 9 MiB of band-one values plus one validity byte per pixel.
This peak limit preserves the former worst case of a 1,024 by 1,024 float64
block while admitting safe long, narrow layouts according to their actual
decoded work. Each admitted native block is read at most once without a broad
`out_shape` read, a boundless read, or an arbitrary full-extent WMS request.
The 9 GiB sample-grid limit measures cumulative decoded work; only one bounded
native block is retained at a time.

Only one non-empty band with a supported scalar datatype is accepted. CRS and
affine georeferencing must be valid, and validity/georeferencing dependencies
must be embedded in the signed GeoTIFF. External GDAL masks, overviews,
auxiliary files, alpha masks, and per-dataset masks are rejected because they
are outside that source signature. Nodata and non-finite values are excluded
rather than converted to zero.

## Distribution and provenance

The service returns 64 fixed histogram bins, the sampled minimum and maximum,
the 5th, 50th, and 95th percentiles, and a strictly ordered suggested color
range. The UI labels a `sampleGrid` result as an approximate sampled
distribution and an `exactSourceWindow` result as an exact bounded
distribution. The histogram and color controls use this provenance instead of
inferring accuracy from the active renderer.

Whole-raster, rectangle, and temporary-AOI selection all use the same frontend
adapter and request lifecycle. Hiding a temporary AOI overlay changes only map
presentation; it does not change or refetch the selected analysis area.
Removing, replacing, or expiring the AOI does invalidate that selection.

## Cache, staleness, and cancellation

Completed results use a process-local LRU and identical in-flight work is
coalesced. Distinct in-flight computations are admitted only up to the
configured statistics-read concurrency; another distinct identity receives a
retryable capacity conflict until one admitted worker finishes. Cache identity
includes Collection and Item, source signature, normalized sampling-area
identity, algorithm version, geometry policy, and every fixed exact/sample-grid
planning parameter. Source and temporary-AOI lifecycle identities are rechecked
around reads and cache-hit returns.

Each browser request has an abort signal and sequence identity, so an obsolete
response cannot replace current viewer state. When the final waiter for one
coalesced request disconnects, a thread-safe cancellation token stops work
between native-block reads. GDAL may finish the current block before the
dataset closes; canceled or stale work is never inserted into the cache.
