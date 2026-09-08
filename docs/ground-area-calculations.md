# Ground-area calculations

Issue [#338](https://github.com/springinnovate/eolab/issues/338), part of
[#335](https://github.com/springinnovate/eolab/issues/335).

`areaha(a > 10)` returns the ground area in hectares where the native raster
condition holds inside the selected box, uploaded AOI, or explicit whole raster.
`areaha(a == 4)` measures one class. `areaha(a == a)` measures all valid selected
ground coverage. NoData and invalid expression arithmetic contribute no area.
Zero matches returns zero; no valid coverage returns null with `no_valid_data`.

Each matching cell contributes its **intersection** with the selection. Fractions
at boundaries and slivers count; holes are excluded and overlapping AOI polygons
are unioned before intersection. The area function does not change numeric
aggregates' existing center-cell inclusion. For example, a narrow box may yield
positive `areaha(a == 4)` and a null `count(a)` because it contains no cell center.

## Measurement method

Only boundaries are transformed. Every value still comes from its original native
pixel, with no warping or COG-overview substitution. Boundaries are intersected in
[PROJ's ellipsoidal cylindrical equal-area projection](https://proj.org/en/stable/operations/projections/cea.html)
on WGS84, with `lat_ts=0` and central meridian 0. Projected polygon area is the
corresponding ellipsoid surface area; square metres are divided by 10,000.
This is surface area on the ellipsoid, not terrain-slope surface area.

The initial supported source policy is geographic or projected **WGS84**, within
a continuous longitude domain from -180 to 180. Other datums, unavailable precise
transformations, invalid topology, and wrapped/undefined footprints fail explicitly.
No approximate datum substitution is attempted: pyproj transformers require
`allow_ballpark=False`, `only_best=True`, conventional x/y order and unwrapped
longitudes. See the [Transformer contract](https://pyproj4.github.io/pyproj/stable/api/transformer.html).
Selections keep the existing WGS84 AOI contract and straight edges in that CRS.

For unrotated EPSG:4326, EPSG:3857 and EPSG:6933 grids, cell edges map to an
equal-area rectangle. Cached column widths and row heights give cell areas, with
exact rectangle clipping for a map box. This handles whole-world geographic grids
without a signed geodesic polygon's half-globe ambiguity. Web Mercator area varies
with latitude; a nominal square kilometre near 60° latitude covers about 25 ha.

Other native cell edges and nonrectangular AOI edges use adaptive densification.
Quarter, midpoint and three-quarter probes must deviate no more than **0.1 m**
from the transformed chord, and a chord must be at most **10 km**. Refinement
stops after 20 subdivision passes or fails its coordinate budget. These are
tested chord-deviation and length targets in the equal-area plane, **not a
certified bound on total hectare error**. Independent densely sampled geodesic
references test geographic, projected and rotated cases. Very thin curved
features near the tolerance scale may need a future stricter area policy.

Projected selection windows are conservatively padded after separate refinement
to 0.01 native pixel chord deviation (maximum chord 64 pixels). Numeric masks
retain their existing transformation contract. Ground-area intersection decides
the contribution of every boundary cell in the admitted window.

## Bounded work and review contract

Plans inspect source metadata and geometry without reading band values. They
retain method, ellipsoid, hectare units, fractional inclusion, refinement settings,
strategy and estimated polygon-cell work in `grid.groundArea`. Execution verifies
the same reviewed grid and measurement settings before reading values. Provenance
also records `functionInclusion`; per-aggregate diagnostic counts remain cell
counts. Direct `areaha(...)` rows carry `unit: ha`. General scalar expressions
have no inferred unit, including `100 * areaha(a > 10) / areaha(a == a)`.

The existing 4 GiB decoded-native-work, 65,536-block, 512 MiB estimated-memory,
15-second planning and 10-minute supervised execution ceilings still apply.
Area jobs include an additional 128 MiB geometry memory allowance in that same
admission estimate, and evaluate bounded 64 × 64 tiles. Rectilinear axes use at
most 500,000 cached coordinates. AOI planning has a cumulative 500,000 transformed
position budget; execution has 4,000,000. Clipped polygon coordinate counts are
also bounded, and only one clipped polygon is retained at a time.

Whole-raster or rectangular selections on optimized grids need no polygon-cell
overlays. Other selections conservatively estimate the **entire selected window**
against a 200,000-cell geometry ceiling. This can reject a large AOI even when
many of its cells are interior; interior-block optimization is a possible follow-up.
Planning estimates do not promise all refinement will fit: execution can still
stop at its cumulative transformation limit or supervised deadline. Failures ask
for a smaller area or simpler AOI; they never return sampled area as exact area.

The existing owner/session, immutable AOI snapshot, Catalog authorization,
source signatures, progress, cancellation, disk reservation and publication
contracts remain in effect. Replacing a followed sampling box uses the same
cancel-before-replacement workflow and visibly marks the previous result.

## Architecture and deployment

Owner: **Processing**.

| Component | Used by | Depends on / coordinates with |
| --- | --- | --- |
| `ground_area` | Native aggregate planner/executor | Processing area/policy models; pyproj, Shapely, NumPy, rasterio windows |
| Expression reducers / aggregate models | Existing validation, plans, worker and responses | Typed grammar, bounded hectare weights, explicit area metadata |
| Aggregate kernel / service | Existing routes and supervised worker | Authorized native source reader, immutable area snapshot, existing job/artifact storage |
| Job store | Existing worker claim | Opaque minimum claim protocol; no geometry knowledge |
| Calculation DOM view / help | Existing browser composition and controller | Public review/results; no histogram, AOI or renderer implementation imports |

New edges are aggregate kernel → Processing-owned `ground_area`, and that module
→ pyproj/Shapely. Existing model and presentation edges carry additive area
metadata. No sibling implementation edges are added, removed, or redirected; no
new service, route, queue, mount, or raster-value alignment mechanism is introduced.
The intentional coupling is the existing immutable source/area contract plus
reviewed method metadata. WGS84-only support and conservative geometry admission
are explicit initial limitations, not hidden fallback calculations.

Updated workers declare claim protocol 3. Area jobs require 3, numeric-only jobs
remain 2 and omit `groundArea`, and clips remain 1. The existing database trigger
blocks older workers from claiming incompatible jobs. Deploy app and worker
together; drain/remove area jobs before rolling back the app to code that cannot
interpret their expressions and metadata. There is no database migration.

## Verification and benchmark

`test_ground_area.py` compares independent `Geod` integrals of densely sampled
edges, the analytic full-ellipsoid surface area, multiple latitudes, rotated and
projected cells, partial cells, slivers, holes, overlaps, NoData, arithmetic errors,
empty matches, budgets, and reviewed-policy changes. HTTP/PostgreSQL/worker tests
cover private CSV/provenance, idempotency, old claim rejection, numeric compatibility,
AOI removal, source changes, cancellation, shutdown and deadline cleanup. Frontend
tests cover templates, review/result units and method descriptions; help examples
are compiled against the actual backend grammar.

Run the reproducible local benchmark with `python tests/benchmark_ground_area.py`.
The fixtures contain classes 0–4 and run all-valid area, threshold area, and pixel
count together. One Windows run with Python 3.12, pyproj 3.8.0 and Shapely 2.1.2:

| Case | Selected native cells | Polygon-cell estimate | Plan | Execute |
| --- | ---: | ---: | ---: | ---: |
| Global 0.25° geographic raster | 1,036,800 | 0 | 0.011 s | 0.245 s |
| Web Mercator partial box | 141,376 | 0 | 0.018 s | 0.118 s |
| Polygon AOI with hole | 53,824 | 53,824 | 0.012 s | 0.190 s |
| Rotated UTM grid | 16,384 | 16,384 | 0.009 s | 2.349 s |

These small synthetic local TIFF timings exclude HTTP, queueing, process startup,
and remote/storage latency. They demonstrate relative geometry cost, not a
production throughput guarantee for large native rasters.
