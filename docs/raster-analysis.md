# Rendering-independent raster analysis

Raster statistics and exact point samples are catalog analysis operations. They
do not depend on whether the selected raster is published to GeoServer, rendered
through WMS, displayed through adaptive bounded visualization, or not rendered
at all. The browser supplies only the scanner-owned Collection and Item
identity plus an owned sampling-area choice or canonical WGS 84 point; it never
supplies a filesystem path, source window, CRS, histogram size, or work limit.

`POST /api/raster-analysis/statistics` accepts exactly one of these areas:

- no area field, meaning the whole raster;
- one canonical non-wrapping WGS 84 `selectedBounds` rectangle; or
- one opaque, ready `temporaryAoiId`.

The application resolves the current catalog Asset inside the configured
read-only mount and checks its scanner source signature before and after the
read. Statistics do not consult the published-layer registry, visualization
eligibility, preview state, or GeoServer. Exact point sampling is a sibling
operation under `/api/raster-analysis/pixels` and is likewise independent.

One map click supplies the same retained position to raster point sampling,
histogram-area selection, and vector inspection. The raster owner samples at
most the same top-two participants used by automatic histograms, displays each
layer's numeric, no-data, outside-extent, loading, or unavailable state, and
cancels superseded reads. Pointer movement previews the sample window without
requesting point values. In bivariate mode the current X/Y order labels the two
values and updates immediately after an axis swap.

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
cannot satisfy them fails before pixel I/O. Each admitted native block is read
at most once without a broad `out_shape` read, a boundless read, or an arbitrary
full-extent WMS request. The 9 GiB limit measures cumulative decoded work; only
one bounded native block is retained at a time.

Only one non-empty band with a supported scalar datatype and native block edges
no larger than 1,024 pixels is accepted. CRS and affine georeferencing must be
valid, and validity/georeferencing dependencies must be embedded in the signed
GeoTIFF. External GDAL masks, overviews, auxiliary files, alpha masks, and
per-dataset masks are rejected because they are outside that source signature.
Nodata and non-finite values are excluded rather than converted to zero.

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
retryable capacity conflict until one admitted worker finishes. These conflicts
use HTTP 409 with `detail.code = "statistics_capacity_busy"` and a human-readable
`detail.message`; ordinary source/area conflicts retain their string detail.
Cache identity
includes Collection and Item, source signature, normalized sampling-area
identity, algorithm version, geometry policy, and every fixed exact/sample-grid
planning parameter. Source and temporary-AOI lifecycle identities are rechecked
around reads and cache-hit returns.

Each browser request has an abort signal and sequence identity, so an obsolete
response cannot replace current viewer state. When the final waiter for one
coalesced request disconnects, a thread-safe cancellation token stops work
between native-block reads. GDAL may finish the current block before the
dataset closes; canceled or stale work is never inserted into the cache.

One per-viewer frontend queue serializes ordinary and paired histogram reads.
Queued or retrying histograms remain loading. Superseding a sample, changing
mode, hiding/removing a layer, or teardown cancels obsolete work; queued entries
are removed immediately. An active loader retains the queue slot until it
settles. Backend reads may outlive a canceled fetch, and other viewers may
occupy server capacity, so only explicitly classified capacity conflicts are
automatically retried: five delays of 250, 500, 1000, 2000, and 4000 ms.
Cancellation clears the delay timer. If contention persists, the normal error
state offers Retry; deterministic conflicts are not retried. The queue does
not change backend concurrency, cache limits, point sampling, or map rendering.

### Histogram presentation

The 1D chart owns its SVG coordinate mapping and redraws against its measured
container width, keeping all bins visible and axis text at a readable size.
Its x-axis uses the returned histogram edges, including the padded domain for
constant samples; units are shown only when the analyzed data asset explicitly
supplies its first band's `raster:bands` unit. Tiny/large values use scientific
notation, and narrowly spaced large values use a labeled offset.

The y-axis starts at zero and shows each bin's percentage of valid sampled
pixels, excluding nodata. Each chart has its own labeled percentage maximum;
bar height alone is not a shared scale across different charts. Hover details
retain exact counts and bin bounds. Resize observers are disconnected whenever
a chart is replaced, cleared, or its controls are destroyed. These are display
changes only: sampling, bin counts, and percentile calculations are unchanged.
