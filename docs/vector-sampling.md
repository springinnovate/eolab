# Sampling with a filtered vector layer

In **Summarize → Area → Vector layer**, choose a mounted Shapefile or
GeoPackage polygon layer directly below the Area selector. **Edit filter** opens
the existing filter panel with **Use filtered features & calculate**. This action
commits the complete predicate (for example, `iso3 equals "PER"`), selects the
authoritative polygon AOI, returns to Summarize, and runs configured valid
statistics. No subsequent **Use these features** or second **Calculate** is needed.
Draft edits and closing the panel do not submit analysis. Cancel is available
during selection and calculation. If all statistic cards have been removed, the
action opens the statistic editor without inventing a calculation.

The analysis predicate is independent of the map's rendering filter and is shown
beside the selected sampling layer. Ordinary map filtering retains its existing
debounce and **Apply filter** action, without implicitly starting analysis.
All matching features contribute, regardless of the
viewport or which features were clicked. Overlaps count once and holes remain
excluded. No matches is an error, never a whole-layer or bounding-box fallback.
The same controls remain available in **Explore → Sampling area → Vector layer**.
Both placements share the retained sampling selection and its applied predicate.
Choosing Vector layer in Summarize clears the calculation area until polygons
are explicitly selected; reopening the panel does not silently restore the old
map box. Applying the selection from Summarize keeps that panel active.

The selected geometry drives 1D and 2D histogram masks, summary statistics and
clip downloads through the existing temporary-AOI reference. Histogram samples
are bounded approximations; the two histogram modes retain their existing grid
policies and may report different sample counts. Exact summaries retain their
native-resolution processing limits. An explicit Calculate action plans and
submits once; the redundant vector-specific review conversion has been removed.

In Explore, an unfiltered selection of multiple features or an envelope over 5 million km²
requires review with an **Edit filter** action. An envelope over 100 million km²
requires a second explicit near-global confirmation. These are conservative
envelope checks, not estimates of polygon area or runtime. Confirmation does not
override geometry or processing limits. Filter/source changes, layer removal,
expiry and clearing invalidate the snapshot and obsolete pending work. A fresh
selection uses the explicit filter action in Summarize or **Use these features**
in Explore. Summarize's explicit action skips envelope confirmations while keeping
all server limits. Superseded bounded extraction stays connected until it returns
an opaque identity, which is removed before the next extraction. Failed removal
retains the identity for retry. Obsolete Processing plans and jobs drain through
the existing release, idempotent-submission and cancellation lane. Previous values
remain greyed out; late responses never become the current result. The uploaded AOI remains
separately available.

## Ownership and dependencies

- `vector/sampling.py` owns Catalog authorization, typed filtering, source
  identity checks and bounded extraction admission. It uses `vector/geometry.py`
  in the existing supervised native-process executor. It does not depend on
  publication, WFS, WMS, GeoServer or the raster implementation.
- `bounded_geometry.py` owns neutral bounded CRS conversion and geometry
  validation, used by both uploads and vector selection. Vector selection
  additionally requires valid polygon topology. Analysis geometry is never
  repaired, simplified or replaced by its envelope. `vector/display_geometry.py`
  creates a separate approximate browser outline inside the same bounded child.
- The backend composition root injects the AOI service's `retain_geometry`
  capability. AOI storage owns opaque identity, immutable polygon snapshots,
  expiry and removal, without learning Catalog or vector filtering semantics.
  Raster statistics and processing continue to consume the shared AOI read port.
- The browser vector controller owns source/filter selection, review and stale
  responses. Its existing view is mounted in Explore and Summarize; the summary
  controller owns the Area choice and the visibility of its inline container.
  The browser composition root connects it to the existing AOI API
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
the exact matched/total count, applied filter and opaque AOI identity. Its
`geometry` field is **display-only**, while `bbox` is computed from every exact
coordinate. Numeric consumers must resolve the opaque ID through AOI retention;
the API does not accept the returned outline as a calculation area.

- Two concurrent native selection reads per application process; busy requests
  are rejected rather than queued without a bound.
- 15-second supervised deadline, including child startup and cleanup;
  cancellation reclaims the child before releasing its slot.
- Linux native child address space: 2 GiB. Windows development relies on the
  remaining geometry, row and supervised time limits.
- At most 1 million scanned rows, 10,000 matching features, 500,000 exact
  coordinate positions, 32 nesting levels and 7 MiB of exact serialized geometry
  (default spaced JSON). The 7 MiB ceiling leaves headroom beneath Processing's
  unchanged 8 MiB snapshot budget; the coordinate ceiling matches the existing
  500,000-position histogram/Processing projection capacity. Exact selections
  must be complete; exceeding a server limit rejects the selection.
- Browser outlines are capped independently at 256 KiB compact GeoJSON and
  10,000 positions. Topology-preserving simplification normally keeps holes and
  separate islands. If the full-detail attempts cannot meet the display budget,
  only simplified exteriors of the largest 500 polygon components are shown.
  Small islands and holes may therefore be absent from the approximate outline,
  but remain in every analysis. Explicit east/west dateline components are kept
  separate without longitude wrapping or union. Zoom uses the exact `bbox`.
- Display simplification uses documented module-level policy constants in
  `vector/display_geometry.py`: initial tolerance is envelope span / 16,384
  (about 0.006% of span), with a 1e-9-degree positive span floor. Tolerance
  doubles after each unsuccessful attempt. Nine full-detail attempts cover
  span / 16,384 through span / 64; the tenth switches to the largest exteriors
  at span / 32. Eighteen attempts total reach 8 times span. These are bounded
  quality/work heuristics, not measured optimal values or proof that omitted
  topology could never fit. Geometric growth explores fine through coarse
  outlines, returning immediately when both display caps are met. Each attempt
  simplifies the original polygons (or their original exteriors), so errors
  do not accumulate from repeatedly simplifying the previous result. Exhaustion
  fails explicitly; the supervised deadline remains the wall-clock bound.
- New vector retention is rejected when 64 temporary area records are retained.
  Trusted retained snapshots also share a 32 MiB serialized-geometry budget;
  Python geometry objects use more memory than their serialized size. Removal
  and expiry reclaim that budget. The configured TTL (30 minutes by default)
  applies. Upload size, archive, geometry and replacement policies are unchanged.

Raster block, decoded-byte, transformed-coordinate, memory and runtime limits
remain independent and enforced. Blockwise raster reads bound pixel memory;
they do not make geometry projection or repeated mask construction unlimited.
The mask still uses the complete projected exact selection, and no new
block-local geometry algorithm is introduced for this display-limit fix.

The first version supports the same native mounted Shapefile/GeoPackage sources
as filtered field reads. Additional vector containers should extend the exact
source reader with their own bounded container handling.
