# Single-raster calculations

Tracking: parent [#335](https://github.com/springinnovate/eolab/issues/335), backend
[#336](https://github.com/springinnovate/eolab/issues/336), interface
[#337](https://github.com/springinnovate/eolab/issues/337).

Processing supports `raster.aggregate.v1`: one catalog raster, an explicit area,
and up to five labeled scalar calculations. Results are a small table, CSV, and
JSON provenance. A final calculation reads **native pixels**, independently of
histogram samples, styling, rendering, and GeoServer. COG overviews do not preserve
arbitrary predicates or sums and are never substituted for native values.

This first step exposes the API. The calculation editor and result presentation
belong to #337. Existing clip Downloads shows only `raster.clip.v1` jobs so a CSV
cannot be mislabeled as a COG. Owned calculation jobs remain available through the
shared API history and direct result URLs.

## API review and execution

Use HTTPS, retain the same owner cookie, and establish it with
`GET /api/processing/jobs` before concurrent requests. Mutations require
`X-EOLab-Processing: 1` and the same browser origin. The existing 16 KiB request
body limit, owner isolation, plan/admission limits, and download leases apply.
See [clip lifecycle and storage](raster-clips.md) for the shared transport contract.

1. `POST /api/processing/raster-calculations/plan` validates syntax, resolves the
   catalog source and immutable area, and reviews metadata without reading band
   values. Replace the example Item ID with an actual mounted catalog raster.

   ```json
   {
     "sources": {
       "a": {
         "collectionId": "eolab-mounted-geotiffs",
         "itemId": "geotiff-0123456789abcdef01234567"
       }
     },
     "selectedBounds": {"west": 77.9, "south": 22.4, "east": 78.1, "north": 22.6},
     "calculations": [
       {"label": "Pixels above 10", "expression": "count(a > 10)"},
       {"label": "Sum above 10", "expression": "sum(a, where=a > 10)"},
       {"label": "Mean value", "expression": "mean(a)"},
       {"label": "Percent above 10", "expression": "100 * count(a > 10) / count(a)"}
     ]
   }
   ```

   Exactly one selection is required. Replace `selectedBounds` with
   `"temporaryAoiId": "<ready uploaded AOI id>"` or `"wholeRaster": true`.
   Missing selection never means the whole raster. A nonoverlapping box/AOI is a
   planning error. Whole-source requests are subject to the same native work
   budgets; global rasters commonly require a smaller selected area.

   Review `planId`, `expiresAt`, `grid`, and `limits`. The grid reports native CRS,
   affine, window, dimensions, datatype, nodata, native block count, decoded bytes,
   estimated expression memory, stored scale/offset, and stored band unit. The
   response explicitly says `resolution: native`, `valueDomain: stored`, and
   `inclusion: cell_center`.
2. `POST /api/processing/raster-calculations` with
   `{"planId":"...","requestId":"<unique 16–80 character key>"}` explicitly
   accepts the reviewed calculation. It returns 202 and an owned job. Retry an
   uncertain submission using the **same** plan and key, even after plan expiry.
   A key for another plan or a plan submitted to the wrong operation returns 409.
3. Poll `GET /api/processing/jobs/{jobId}`. `GET /api/processing/jobs` recovers
   both supported operation types. Branch on `operation` before interpreting
   operation-specific fields. Calculate progress reports `calculating` with
   measured `completedBlocks`/`totalBlocks`, then `writing_results`.
4. A ready job's `result.rows` contains at most five results. Navigate to
   `result.url` for the CSV (`text/csv`) and `result.provenanceUrl` for JSON. The
   same cookie authorizes downloads, HEAD, single byte ranges, cancellation,
   deletion, and recovery after reload. Paths and cookies never appear in results.

The [FastAPI documentation](/docs#/processing) can exercise these endpoints before
the editor exists. Keep the owner session; job identifiers alone grant no access.
Accepted work is immutable and continues if the browser closes. Removing the AOI
invalidates an unsubmitted plan, but accepted jobs retain their own geometry.

## Language and numerical meaning

Aliases start with a letter, contain letters/digits/underscores, and have at most
32 characters. One binding is allowed. Function names and keywords are reserved.
Labels must be unique and at most 80 characters. Expressions together have a
4 KiB UTF-8 limit and 256 syntax nodes, with nesting/tree depth limited to 20.

The tokenizer and typed parser allow only finite numeric literals, the bound
raster alias, parentheses, unary `+`/`-`, arithmetic `+ - * /`, comparisons
`< <= > >= == !=`, and boolean `! && ||`. Precedence is unary, multiplication and
division, addition and subtraction, ordered comparisons, equality, AND, then OR.
Arithmetic/comparisons require numbers; boolean operators require conditions.
Strings, paths, URLs, property access, indexing, assignment, arbitrary function
calls, and executable Python are unsupported. Nothing is passed to `eval`.

Every calculation must yield a numeric scalar and reference its raster. Pixel
expressions go inside an aggregate; aggregates cannot nest. Arithmetic between
aggregate results is allowed, for example `max(a) - min(a)`.

| Expression | Meaning |
| --- | --- |
| `count(a)` | Count valid selected native cells, including zero |
| `count(a > 10)` or `sum(a > 10)` | Count cells satisfying the condition |
| `sum(a, where=a > 10)` | Sum original values of the matching cells |
| `mean(a * 2, where=a >= 0)` | Pixel-weighted mean of the transformed matching values |
| `min(a)` / `max(a)` | Smallest / largest selected valid value |

`where` takes a boolean pixel expression. `mean`, `min`, and `max` take numbers;
`sum` and `count` also accept a condition. Scalar literals within a pixel aggregate
broadcast over valid source cells. Scale/offset metadata is recorded but **not
automatically applied**: calculations use the stored values, matching the current
analysis value domain. Users can explicitly write `a * 2 - 1`. No expression-unit
inference is claimed; the grid's unit is source metadata, not a computed result unit.

Each source block is decoded once, then evaluated in tiles of at most 256 × 256
cells. Integers are converted exactly from the supported native integer types to
float64 for pixel arithmetic. Numeric sums use float64 block sums with compensated
combination across blocks; means use scaled block means and weighted combination.
Floating results are not arbitrary-precision decimal arithmetic. Count reductions
remain integer accumulators. All returned values are decimal **strings** with
`valueType: integer | float`, preserving integer counts across JSON/JavaScript.

The AOI/box uses the shared bounded geometry transformation and a center-cell
mask (`all_touched=False`). Holes are respected; overlapping polygons are unioned
and pixels counted once. No fractional boundary weighting is performed. This
differs deliberately from clipping's all-touched export mask. `areaha` and physical
area weighting are deferred to #338; EPSG:3857 cell dimensions are not hectares.

Source nodata, nonfinite values, and cells outside the selected area are missing,
never zero. Arithmetic/domain errors invalidate the affected cell in that
aggregate. All operands must be valid, including both operands of boolean OR;
there is no short-circuit recovery from missing data. Partially valid calculations
still produce a result and report excluded arithmetic cells. Each row includes
per-aggregate `validPixels` (source-valid selected cells), `matchedPixels` (included
cells after expression validity/condition), and `invalidArithmeticPixels`.

| State | Result |
| --- | --- |
| `ok` | Finite result; coverage diagnostics may report excluded arithmetic cells |
| `no_matches` | Valid data exists but nothing matches: count/sum is zero, mean/min/max is null |
| `no_valid_data` | No valid source cell in the area: null, including count |
| `invalid_arithmetic` | All eligible source cells have invalid expression arithmetic, or final scalar arithmetic is undefined: null |
| `overflow` | A numeric accumulation or final scalar result overflows: null |

Missing aggregate operands propagate to the final scalar result. Nonempty scalar
combinations keep `ok`; `no_matches` propagates when every aggregate reports it.
A job can finish `ready` with null-valued rows: the result explains what happened.
CSV stores label, expression, value, value_type, and state; potentially executable
spreadsheet text is escaped. Provenance retains original expressions, area
geometry, source signature, native grid, value/inclusion policies, typed rows,
coverage, creation time, and the CSV checksum.

## Ownership, resources, and deployment

Processing owns validation, plans, execution, and result semantics. Thin routes
are used by HTTP clients; service and worker composition depend on catalog
authorization, the neutral immutable sampling-area reader, native source/window
mechanisms, and Processing-owned storage. The expression module knows no HTTP,
catalog, AOI, or renderer services. Job storage treats operation data as opaque.

New modules: `aggregate_models` for this operation's schemas/policy,
`raster_expression` for grammar/reducers, and `raster_aggregate` for native planning
and reduction. `raster_input` extracts source fencing, supported input checks,
bounded area projection, and native-work estimation that are now genuinely shared
by clipping and calculations. Kernel progress uses the existing artifact adapter.
The worker explicitly dispatches two supported operations; it is not a registry
for user code. The internal worker/artifact port names now describe both operations.

No histogram, renderer, GeoServer, temporary-AOI implementation, or pgSTAC dependency
was added. Shared source and area contracts remain the intentional coupling.
The API and worker continue using one deployment policy, queue, global execution
fence, source mount, and private artifact volume. No new service or data mount is
needed. Initial calculation-specific ceilings are:

| Resource | Limit |
| --- | --- |
| Native decoded source work | 4 GiB, at most 65,536 blocks, with conservative preallocation guard |
| Estimated native/expression working memory | 512 MiB within the existing 2 GiB worker |
| AOI snapshot / projected coordinates | 8 MiB / 500,000 |
| Working/result reservation | 12 MiB per calculation job |
| Planning / execution | Existing 15-second / 10-minute supervised deadlines |
| Result lifetime | Existing 24-hour lifetime and transfer leases |

There is no full-raster intermediate file. Work-budget failure asks for a smaller
area; it never silently switches resolution. Source signatures are rechecked at
submission, execution, after native reads, and before publication. The supervisor
terminates and joins work on cancellation/deadline/shutdown before releasing the
global slot or cleaning private output. Disk reservations, physical headroom,
atomic publication, owner leases, restart recovery, and expiry remain shared with
clips. A filesystem-full failure cannot publish a partial CSV.

Migration 2 adds an opaque operation discriminator and minimum worker claim
protocol to jobs. New workers declare protocol 2 transaction-locally and select
compatible work. A database trigger rejects a legacy worker's queued-to-running
transition for a calculation job **before it starts native work**. Legacy clip
rows retain protocol 1 and old TIFF/download defaults. The trigger is preserved
when a legacy worker reapplies its older migration. During mixed-worker rollout,
a legacy worker encountering a calculation may back off until a new worker claims
it. The shared advisory-lock key and execution fence are unchanged. Retired job
summaries retain their operation even after source/area snapshots are cleaned.

Deploy the updated application and worker together. Rolling back the application
also removes its ability to interpret calculation history; drain/remove calculation
jobs before a full rollback to clip-only code. Do not drop the compatibility trigger
while any queued calculation might be seen by a legacy worker.

## Tests

Run the ordinary Python suite and the real PostgreSQL boundary tests. The latter
require an explicitly disposable UTF-8 database named `eolab_processing_test*`:

```sh
python -m pytest --processing-dsn=postgresql://USER@localhost/eolab_processing_test --disable-warnings
cd frontend
node --test
node node_modules/vite/bin/vite.js build
```

Tests compare known native results with overview-equipped TIFFs, projected/rotated
AOIs and holes, bounds-edge inclusion, NoData and zero, grammar/type/size limits,
scalar arithmetic, overflow, metadata-only planning, and native-work refusal.
Real HTTP/PostgreSQL tests exercise owner isolation, idempotency, mixed clip and
calculation jobs, wrong-operation submissions, CSV/range/provenance delivery,
reload, AOI removal, source changes, cancellation/shutdown/deadline, transfer/expiry
cleanup, repeated migrations, and rejection of legacy claim SQL. Existing import
guards protect sibling independence; a Downloads regression protects clip-only
presentation while the editor is implemented separately.
