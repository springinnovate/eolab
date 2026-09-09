# Sampling with a filtered vector layer

In **Explore → Sampling area → Vector layer**, choose a mounted Shapefile or
GeoPackage polygon layer. **Edit filter** opens the existing filter panel. Apply
the filter (for example, `iso3 equals "PER"`), return to Sampling area, and choose
**Use these features**. All matching features contribute, regardless of the
viewport or which features were clicked. Overlaps count once and holes remain
excluded. No matches is an error, never a whole-layer or bounding-box fallback.

The selected geometry drives 1D and 2D histogram masks, summary statistics and
clip downloads through the existing temporary-AOI reference. Histogram samples
are bounded approximations; the two histogram modes retain their existing grid
policies and may report different sample counts. Exact summaries retain their
native-resolution processing limits. Their first Calculate action reviews the
planned source blocks and decoded bytes; the next confirms submission.

An unfiltered selection of multiple features or an envelope over 5 million km²
requires review with an **Edit filter** action. An envelope over 100 million km²
requires a second explicit near-global confirmation. These are conservative
envelope checks, not estimates of polygon area or runtime. Confirmation does not
override geometry or processing limits. Filter/source changes, layer removal,
expiry and clearing invalidate the snapshot and obsolete pending work. A fresh
selection requires **Use these features** again. The uploaded AOI remains
separately available.

## Ownership and dependencies

- `vector/sampling.py` owns Catalog authorization, typed filtering, source
  identity checks and bounded extraction admission. It uses `vector/geometry.py`
  in the existing supervised native-process executor. It does not depend on
  publication, WFS, WMS, GeoServer or the raster implementation.
- `bounded_geometry.py` owns neutral bounded CRS conversion and geometry
  validation, used by both uploads and vector selection. Vector selection
  additionally requires valid polygon topology. No geometry is silently repaired,
  simplified or replaced by its envelope.
- The backend composition root injects the AOI service's `retain_geometry`
  capability. AOI storage owns opaque identity, immutable polygon snapshots,
  expiry and removal, without learning Catalog or vector filtering semantics.
  Raster statistics and processing continue to consume the shared AOI read port.
- The browser vector controller owns source/filter selection, review and stale
  responses. The browser composition root connects it to the existing AOI API
  and overlay adapter, raster selection commands and summary cancellation.
  Vector, raster and AOI browser components do not import each other's
  implementations. The shared map-layer controller gains no feature logic.
- The paired raster API gains an exclusive `temporaryAoiId` alternative to
  `selectedBounds`. AOI lifecycle identity joins its existing source/policy cache
  key and is checked before and after native reads and cached responses.

No new queue, storage mount, database migration or geometry upload endpoint is
introduced. Completed jobs already persist their independent geometry snapshot
in provenance. Vector AOIs remain temporary and are not restored by shared map
links or page reloads; abandoned references expire through the AOI lifecycle.

## Limits

`POST /api/vector-sampling/areas` accepts Catalog `collectionId`, `itemId`, and
the existing typed `filter` contract. It never accepts a source path, arbitrary
SQL or browser-supplied geometry. The response contains bounded display geometry,
the exact matched/total count, applied filter and opaque AOI identity.

- Two concurrent native selection reads per application process; busy requests
  are rejected rather than queued without a bound.
- 15-second supervised deadline, including child startup and cleanup;
  cancellation reclaims the child before releasing its slot.
- Linux native child address space: 2 GiB. Windows development relies on the
  remaining geometry, row and supervised time limits.
- At most 1 million scanned rows, 10,000 matching features, 100,000 coordinate
  positions, 32 nesting levels and 2 MiB serialized geometry. Results must be
  complete; exceeding a limit rejects the selection.
- New vector retention is rejected when 64 temporary area records are retained.
  The existing configured AOI TTL (30 minutes by default) applies.

The first version supports the same native mounted Shapefile/GeoPackage sources
as filtered field reads. Additional vector containers should extend the exact
source reader with their own bounded container handling.
