# Raster pixels and histograms

The pixel picker reads the raster value at a point. Histograms describe a
distribution over the selected area. Both read original raster data, independently
of map colors or whether GeoServer can draw the raster. Transparent valid pixels
still count as data.

## Catalog rasters and private run files

The analysis API can read a catalog raster or an immutable GeoTIFF from a model
run through the same pixel and distribution services. It reads the original
file, never the map preview's 512-pixel display grid. The browser's model-output
controls are unchanged; shared map controls and using outputs as model inputs
are separate follow-ups.

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
datatype, CRS, six-coefficient affine `transform`, NoData and
`capabilities.pixels` / `capabilities.statistics`.
Each capability has `supported` and `reason`. A non-finite NoData marker is
represented as `null`; numerical readers still use the original file metadata.
Capability descriptions report format support, not permission to bypass later
authorization or a guarantee that every requested area fits work limits.
Internal validity masks work for pixel reads but remain unsupported by the
distribution readers; the capability response states that limitation.

Private requests require the owning Processing session cookie, same-origin
checks and `X-EOLab-Processing: 1`. The application composition injects that
session authority; analysis and its source readers do not import Processing
storage, workers, GeoServer or preview services. Requests cannot supply a path,
download URL or owner identity. Responses use `Cache-Control: private, no-store`.

The common private-file access scope acquires the existing renewable transfer
lease, verifies the published checksum, then rechecks ownership, availability
and file identity before delivering derived data. It renews every 10 seconds
and retains the file until native work stops, including cancellation and lease
loss. The owning transfer limits still apply. Checksum verification admits two
concurrent checks per API process with a 30-second deadline and no waiting queue;
it reads the full file on each request, including statistical cache hits.
Private numerical reads use the existing native readers in supervised processes
with a 30-second deadline and a Linux 2 GiB address-space ceiling. Catalog
numerical reads retain their existing thread scheduling and immutable catalog
source policy.

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
  COG overview. Without one, reading is limited to 16,129 native blocks and 9 GiB
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

NoData and non-finite values are excluded, not treated as zero. Units are shown
only when provided by the raster's band metadata. Very large or small values may
use scientific notation or a labeled axis offset. Suggested style ranges use
the sampled 5th, 50th and 95th percentiles; styling does not alter source values.

The distribution reader requires a supported single numeric band, valid CRS and
affine georeferencing, and native blocks decoding to at most 64 MiB each.
Georeferencing, nodata and overviews must be embedded in the GeoTIFF. External
masks/overviews/auxiliary files, alpha masks and per-dataset input masks are not
accepted. Prepare a self-contained source upstream if those checks fail.
Pixel reads use the first numeric band and support embedded validity masks;
they enforce the same signed-dependency, georeferencing and 64 MiB block limits.

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
