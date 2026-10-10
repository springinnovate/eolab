# Raster pixels and histograms

The pixel picker reads the raster value at a point. Histograms describe a
distribution over the selected area. Both read original raster data, independently
of map colors or whether GeoServer can draw the raster. Transparent valid pixels
still count as data.

## Catalog rasters and private run files

The analysis API can read a catalog raster or an immutable GeoTIFF from a model
run through the same pixel and distribution services. It reads the original
file, never a rendered display grid. After **Show on map**, raster outputs use
the same style, pixel, distribution, Statistics and Raster stack controls as
catalog rasters. Models can also select completed raster files without displaying
them. Removing a display does not delete its original file or accepted jobs.

Existing flat catalog requests remain supported. An explicit `source` can also
identify a catalog item:

```json
{"source":{"collectionId":"eolab-mounted-geotiffs","itemId":"geotiff-0123456789abcdef01234567"},"longitude":0,"latitude":0}
```

A private source uses the run and file IDs returned by the run's file inventory:

```json
{"source":{"kind":"runArtifact","jobId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","artifactId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"longitude":0,"latitude":0}
```

Send either form to `POST /api/raster-analysis/pixels`. For `/statistics`, replace
the coordinates with the existing optional `selectedBounds`, `catalogSelection`
or `categoryValues` fields. `/paired-statistics` accepts either source reference
in `xRaster` and `yRaster`, including a mixed catalog/private pair. Existing
sampling, grid alignment, NoData, category and resource policies still apply.
These distribution APIs are distinct from Processing's native raster formulas.

`POST /api/raster-analysis/sources` takes `{"source": ...}` and returns its
path-free reference, immutable `version`, original width/height, band count,
datatype, CRS, six-coefficient affine `transform`, WGS84 `bounds`, NoData and
`capabilities.pixels` / `capabilities.statistics`.
Each capability has `supported` and `reason`. A non-finite NoData marker is
represented as `null`; numerical readers still use the original file metadata.
Capability descriptions report format support, not permission to bypass later
authorization or a guarantee that every requested area fits work limits.
Embedded per-dataset validity masks work for pixels and distributions. The
capability response includes the data and mask block memory checks.

Private requests require the owning Processing session cookie, same-origin
checks and `X-EOLab-Processing: 1`. The application composition injects that
session authority; analysis and its source readers do not import Processing
storage, workers, GeoServer or preview services. Requests cannot supply a path,
download URL or owner identity. Responses use `Cache-Control: private, no-store`.

Pixel picking resolves the owner and expiry once, then uses the same
`read_raster_pixel` reader and bounded thread scheduling as catalog sources.
It does not create a transfer lease, read the whole file for a checksum, or start
a subprocess. Published files are immutable and mounted read-only in the API.
A file removed between authorization and reading produces the ordinary source
error. Cancellation discards the response but retains the concurrency slot until
the native read finishes.

Longer private statistics and metadata operations retain the existing renewable
transfer lease, checksum verification, availability recheck and supervised native
reader. They keep their transfer limits, 30-second native deadline and Linux
2 GiB address-space ceiling; this change does not weaken queued model input
retention or download integrity checks.

Private statistics use the existing bounded cache and request coalescing, keyed
by owner, run, file, checksum and byte count as well as area and numerical policy.
Every requester authorizes before cache lookup and rechecks availability before
delivery. Deletion or expiry therefore prevents reuse of a cached value. This
does not publish a catalog item, save a result permanently, or retain an output
for a later queued model run.

The right dock groups **Distributions**, **Statistics**, and **Raster stack** under
**Raster analysis**. Distributions show the spread of values over an area;
result details identify exact or sampled reads. Statistics calculate native-pixel
formulas for the raster chosen in each card. Raster stack applies the same formulas
across selected rasters. Switching views retains their independent source and
area context; opening a destination alone does not calculate statistics.

One map click can return both vector features and raster information.
**Features at clicked point** is a separate navigation group, visible alongside
raster analysis when point inspection participates. Switching tools or receiving
new results keeps both groups visible; **Minimize** collapses the whole dock.
Its updating, unavailable, and new-result feedback refers only to point features.
Raster distribution feedback
stays with raster analysis.
Automatic 1D histograms use up to the top 16 visible rasters; 2D comparisons use only the
top two. Histogram results describe the sampling
area, not just the clicked pixel or the features returned by feature inspection.

## Categorical raster values

Choose **Categorical** in a raster's **Style** panel to define exact integer codes,
labels, colors, and opacities. The settings belong to that map layer and travel
with saved maps. The layer-list and on-map legends show the categories in table
order, followed by the configured Unmapped appearance. See the
[categorical appearance contract](categorical-raster-contract.md) for editing and
persistence details and CSV import.

For a styled categorical layer, the pixel picker and raster values at a click
show labels with their exact codes, such as **Forest (41)**. Copying picker values
uses the same presentation. An undefined valid value appears as **Unmapped (42)**;
**No data** remains a missing source value. Matching is exact, so fractional
samples are not rounded into a category. Transparent categories still report their
labels and values. Committed label edits update retained results without reading
the pixel again.

Categorical distributions show **label and code → horizontal bar → percentage →
hectares**, sorted by estimated area. Bars use the category color and opacity over
a hatched background; transparent categories still count as data. The first 12
rows include an aggregated remainder, with a button to expand all categories.
Unmapped valid values, including fractional values, enter the percentage
denominator. NoData and non-finite samples are excluded and reported separately.

Each bounded native sample represents a source-grid cell. Ground areas use an
ellipsoidal equal-area transformation of that cell, with a fixed 4 × 4 subdivision
to estimate partial selection coverage. This accounts for latitude, projection,
rotation, polygon holes and overlapping polygons. Areas and percentages are
explicitly estimates: thin or rare features may be missed. Categorical reads
bypass embedded overviews so averaged codes cannot become categories. Native
work limits still apply; unsupported CRS transformations or longitude wrap
domains fail explicitly.

Label, color, opacity and row-order edits reuse the current numeric result;
category-code or mode changes cancel obsolete requests and refresh statistics.

In **Style → Distribution**, a retained sample is labeled **Previous distribution**
with its own scope while a replacement is loading or unavailable. The status names
the current map or vector selection, so a no-overlap error cannot be mistaken for
a failure of the retained whole-raster distribution. A successful replacement
shows its current scope and clears the earlier feedback.
Saved maps retain the layer-specific category table through the existing
appearance contract. Percentile stretches and 2D comparisons require continuous
layers. Processing continues to use unchanged source values and its native
calculation contracts. Catalog analysis without a styled map-layer context keeps
its ordinary numeric presentation.

## Plot values across raster layers

Choose **Raster analysis → Raster stack**, **Plot raster stack** beneath a histogram,
or the stack action in **Tools** on the map or dock.
**Raster stack** runs the same formulas across your selected rasters using
[raster calculations](raster-calculations.md#plotting-statistics-across-rasters).
Visible raster layers start selected; expand **Rasters** to choose a different
set, including layers hidden on the map. Use **Pixel value** (`pixelValue(a)`)
alongside area formulas such as `mean(a)`, with shared plots, cancellation,
progress and CSV export. Missing values leave gaps and are never replaced with zero.

## Choose an area

Use **Sampling area** to choose a map box or a filtered
[Catalog vector](vector-sampling.md). Use **Whole raster** for a global 1D
distribution or **Whole overlap** for a [2D comparison](bivariate-raster.md).
Polygon masks preserve holes and count overlapping features once.

The map box defaults to 200 km. Its slider and integer-kilometer input allow up
to 14,152 km. This is a geometry limit: position-specific pole and date-line
checks still apply. An unsupported selection leaves the previous box intact.
Resizing retains the selected center.

## Exact versus sampled results

A large sampling area does not mean every source pixel is read. EOLab reports
which of these methods produced the histogram:

- **Exact bounded distribution:** reads the selected source envelope when its
  edges are at most 512 pixels, it intersects at most 1,024 native blocks, and
  decoded values plus validity need at most 64 MiB.
- **Approximate sampled distribution:** uses one center observation per grid cell,
  with at most 127 cells along the longest edge. It prefers a suitable embedded
  COG overview for sources without an embedded mask. Masked sources use original
  cells, so coarse or stale overview masks cannot restore excluded cells.
  Native sampling is limited to 16,129 data-plus-mask block reads and 9 GiB
  cumulative decoded source work; only a bounded block is retained at a time.

These limits are fixed. A request that cannot fit them fails instead of starting
an unrestricted read. Histogram polygon masks use all-touched inclusion on the
chosen grid. A sampled distribution may miss small or rare features and its
extremes need not be the full raster's extremes. Use native
[raster calculations](raster-calculations.md) for counts, sums and ground area.

## Reading the chart

The 1D histogram has 64 bins. The x-axis shows raster values; the y-axis shows
each bin's percentage of **valid sampled pixels**. Hover details give bin bounds
and counts. Each chart has its own percentage scale, so equal bar heights on
different charts do not necessarily represent equal percentages.

Embedded mask exclusions, band NoData and non-finite values are combined: a cell
must pass all three checks. An embedded mask cannot make a NoData value valid.
Zero is valid unless it is declared NoData or excluded by the mask. This policy,
`finite-unmasked-non-nodata-v1`, is shared by pixel reads, distributions,
Processing and preview validity. Pixel reads previously let an internal mask
override finite band NoData; they now agree with the other consumers.
Units are shown
only when provided by the raster's band metadata. Very large or small values may
use scientific notation or a labeled axis offset. Suggested style ranges use
the sampled 5th, 50th and 95th percentiles; styling does not alter source values.

The distribution reader requires a supported single numeric band, valid CRS and
affine georeferencing, and native blocks decoding to at most 64 MiB each.
Georeferencing, NoData, masks and overviews must be embedded in the GeoTIFF.
External masks/overviews/auxiliary files and alpha masks are not accepted.
Prepare a self-contained source upstream if those checks fail.
Pixel reads use the first numeric band and support embedded validity masks;
they enforce the same signed-dependency, georeferencing and 64 MiB block limits.

Mask blocks may differ from data blocks. Before reading values, the shared
contract inspects their native dimensions with the already-required GDAL Python
bindings. A data block plus its boolean validity buffer and the larger of the
returned byte-mask window or one decoded mask block must fit the 64 MiB limit.
Work admission counts every mask block
intersecting each data read, including repeated mask reads across windows;
it does not assume cache hits. Masked sources charge full decoded blocks at
raster edges. Sources without masks retain their existing numerical and work
policies. Display projection and sampling remain separate from analysis grids.

## Busy or unavailable results

Moving or changing a selection cancels obsolete requests. An already-running
native read may finish its current block before stopping. Capacity conflicts
retry briefly; a persistent error offers **Retry**. Cataloged rasters are immutable;
analysis does not poll file metadata for changes. Failure to draw the optional vector outline does
not invalidate its analysis area.

### Reusing raster summary results

Completed raster-calculator values are cached in PostgreSQL for up to 24 hours,
shared by viewers connected to the same EOLab database. The UI identifies these
as **Reused cached result**. A reused value gets its own job and CSV download
with the current statistic title and formula; it does not inherit another
session's download permissions.

The match includes the immutable catalog raster, source metadata, exact area
or vector filter, parsed formula, requested batch size and calculation-policy
version. Titles and formula
whitespace do not affect matching. Different filters with the same bounding
box remain different areas. Algebraically equivalent formulas and reordered
filter rules are not automatically considered identical.

Source authorization, queue admission and cancellation still apply. The cache
lookup runs when the worker claims the job, before polygon-envelope reads and raster size estimation. A hit skips
those preparation steps, raster reads and
polygon-mask creation. The small cached values are copied into the prepared job,
so cache expiry during execution cannot unexpectedly start a full calculation.
An uncached request prepares and calculates within the same job. When a request groups several formulas, all must be cached; otherwise
the normal combined calculation runs. Separate deployments with separate
databases do not share values.

The Processing limits `calculation_cache_capacity` (default 1,000) and
`calculation_cache_ttl_seconds` (default 86,400) configure this cache in Python,
like the other Processing limits. A zero capacity disables reads and writes.
Payloads are limited to 32 KiB each; expired entries and oldest entries beyond
capacity are removed when results are added. Deleting an owned job removes its
download, not the independently cached numerical values. Cache entries contain
no user titles, raster pixels, polygon geometry, source paths or download links.

## Temporary raster map delivery

`POST /api/rendering/layers` also accepts `{source: {kind: "runArtifact", jobId,
artifactId}}`. The same publisher registers the original GeoTIFF under a stable
opaque `model_<run>_<file>` coverage-store name and returns the ordinary
`{layerName, bbox}` response. No client path is accepted or returned. The browser
uses the same WMS factory, composite plans, tile recovery, styles and legends as
catalog rasters. There is no private viewport renderer or raster-window endpoint.

Application composition supplies current-session checks to publication, WMS and
composite delivery. Every private request checks owner, expiry and file presence,
including requests served from the existing bounded composite tile cache. Private
HTTP responses use `Cache-Control: private, no-store`. Temporary layers are
unadvertised in GeoServer and filtered from public WMS capabilities. GeoServer
remains internal; the public proxy is the access boundary.

The GeoServer service needs the existing `processing-data` volume mounted at
`/processing-data:ro`, matching the API mount. Deploy the updated Compose
configuration and rerun the existing GeoServer initializer to extend its file
allowlist to published result TIFFs. Deploy the application image too. Processing workers do not need
GeoServer credentials and can compute, retain inputs and delete files while
GeoServer is unavailable.

The API lifespan reconciles temporary GeoServer stores every 30 seconds against
Processing's authoritative result lifetime. Unavailable runs are removed from
GeoWebCache (including disk tiles), then their GeoServer store and process-local
publication registry. Failed cleanup retries; discovery includes stores left by
an earlier API process. Original-file deletion stays with Processing and respects
accepted dependent jobs. Unpublication is eventual and may follow file deletion;
per-request access checks reject expired/deleted outputs immediately even while
cleanup is pending. The bounded in-memory composite cache may retain inaccessible
bytes until normal eviction, but cannot deliver them without a fresh access check.

The historical run-file `/preview` endpoint remains for existing clients; ordinary
raster display no longer calls it. Existing vector previews are unchanged.
Rendering availability does not authorize or gate any numerical operation.
