# Raster clip jobs and downloads

Tracking: parent [#328](https://github.com/springinnovate/eolab/issues/328), backend
[#329](https://github.com/springinnovate/eolab/issues/329), UI integration
[#330](https://github.com/springinnovate/eolab/issues/330).

The Processing component exports one catalog-authorized, single-band numeric
GeoTIFF at its **native resolution, CRS, affine grid, and datatype**. An explicit
histogram rectangle or a ready temporary AOI is required. There is no implicit
whole-raster export, user-supplied source path, arbitrary URL, GDAL command, or
reprojection option. Map styling, histogram sampling resolution, WMS publication,
GeoServer availability, and the viewer are not prerequisites.

## Browser workflow

Use **Download clip** on a raster in Map layers or an individual 1D histogram.
The 2D histogram has separate **Download X clip** and **Download Y clip** actions.
The **Downloads** toolbar/dock button stays accessible while other tools are open.

Downloads captures the explicit selected histogram area when opened. The 1D and
2D selections remain distinct; whole-raster and whole-overlap sampling do not
become export areas. Choose a box in Sampling area, or explicitly select a ready
uploaded AOI in Downloads. **Choose box or upload AOI** opens the existing area
controls. Reopen Downloads to capture a changed histogram selection. Histogram
results need not be ready or successful before reviewing a clip.

**Review clip** reads metadata and presents the source, geographic area, native
CRS/pixel size, dimensions, datatype, and estimated uncompressed size.
**Create clip** accepts this fixed intent. Later map changes or AOI removal do
not change accepted work. Job cards show measured block progress and named file
preparation phases, plus cancel, download, provenance, delete, size, and expiry.
Downloads go directly through the browser, without a JavaScript Blob buffer.

Owned jobs recover through the session cookie after reload. The per-tab session
storage contains only an unconfirmed plan ID, idempotency key, and display label;
it is saved before dispatch. Reload or **Recover submission** retries that same
request. No cookie, geometry, result file, or processing job is placed in a shared
map link. Disabled session storage prevents submission with a clear explanation.
The existing `/docs#/processing` API page also remains available.

## API workflow

All endpoints are below `/api/processing`. POST and DELETE requests require
`X-EOLab-Processing: 1`. Browser mutations must originate from the same host;
normal browser CORS rules and the custom header prevent cross-origin submission.
JSON request bodies are limited to 16 KiB before parsing.

The first request establishes a random `__Host-eolab-processing` cookie with
Secure, HttpOnly, Path=/, and SameSite=Lax. **Use HTTPS and retain this cookie**:
it is the download/session capability, not an account login. Only its hash is
stored in PostgreSQL. Job IDs alone are insufficient to inspect, cancel, delete,
or download a result. Sharing a map does not share processing jobs.

1. `GET /jobs` establishes the session and lists up to 50 owned recent jobs.
2. `POST /raster-clips/plan` validates a source and explicit selection and returns
   a five-minute `planId`, native grid, estimated uncompressed bytes including
   validity, resource limits, and expiration. Planning reads metadata and geometry;
   it does not sample the data band or start a clip.

   ```json
   {
     "collectionId": "eolab-mounted-geotiffs",
     "itemId": "geotiff-0123456789abcdef01234567",
     "selectedBounds": {
       "west": 77.9, "south": 22.4, "east": 78.1, "north": 22.6
     }
   }
   ```

   For an AOI, replace `selectedBounds` with `"temporaryAoiId": "<ready AOI id>"`.
   Reuse the existing `/api/temporary-aois` upload/selection API. No additional
   upload service is needed. Bounds and AOI are mutually exclusive.
3. `POST /raster-clips` with `{"planId":"...","requestId":"..."}` rechecks the
   current Catalog identity and the ready AOI, then returns HTTP 202 and `jobId`.
   Generate a 16–80 character client request key using letters, digits, `_`, or
   `-`. **Retry an uncertain submission with the same plan and request ID.** It
   returns the same job even after the original plan expires. Reusing a request
   ID for another plan produces 409. Tombstones retain idempotency for seven days.
4. Poll `GET /jobs/{jobId}`. Status is `queued`, `running`, `cancelling`, `ready`,
   `failed`, `cancelled`, `interrupted`, `expired`, or `deleted`. Running progress
   reports block counts while clipping and named phases during COG creation,
   validation, and checksumming. It does not invent a finalization percentage.
5. A ready result supplies `result.url`, `provenanceUrl`, filename, byte length,
   SHA-256, and valid-pixel count. Navigate directly to the result URL to let the
   browser download it without buffering the whole TIFF in JavaScript.
   `GET` and `HEAD /jobs/{jobId}/result` provide an attachment, Content-Length,
   checksum ETag, and single byte-range/If-Range support for resume. Multi-range
   requests are rejected. The provenance endpoint returns an owned JSON attachment.
6. `POST /jobs/{jobId}/cancel` cancels queued work immediately or requests native
   process termination. `cancelling` retains the execution slot until the child
   exits. `DELETE /jobs/{jobId}` revokes a terminal result and schedules cleanup;
   cancel active jobs and wait before deleting them.

Errors include a stable code and actionable detail. Admission/planning capacity
uses 429, unavailable processing storage uses 503, a changed source/AOI uses 409,
and oversized clips use 413. `no_overlap` fails planning; `no_valid_data` fails
the job without publishing a file. A closed browser connection cancels planning,
but **does not cancel an already accepted job**. Recover accepted jobs with
`GET /jobs` using the same cookie.

For command-line review, save the above JSON as `plan.json` and keep a cookie jar:

```sh
curl -c clip-cookies.txt https://wwf-connectivity.ecoshard.org/api/processing/jobs
curl -b clip-cookies.txt -c clip-cookies.txt -H 'X-EOLab-Processing: 1' \
  --json @plan.json https://wwf-connectivity.ecoshard.org/api/processing/raster-clips/plan
```

Use a real catalog Item ID. Submit the returned `planId` in a separate JSON file,
poll the job, then download the result with `curl -b clip-cookies.txt -o clip.tif
<result URL>`. Cookie jars are private session capabilities and should not be
committed, pasted into an issue, or shared with another user.

## Raster correctness

The worker reauthorizes the Catalog Item at execution and checks the full scanner
signature (inode, size, mtime, ctime) around native reads and before publication.
Existing signed-source restrictions remain: one supported numeric band, bounded
native blocks, embedded georeferencing and nodata, and no unsigned sidecars,
alpha, or input dataset masks. Supported datatypes are uint8, uint16, int16,
int32, float32, and float64, matching the neutral reader contract.

Bounds edges and AOI polygon edges are densified and transformed to the source
CRS using the shared bounded-window mechanisms. The output is an integer native
window with the existing conservative one-pixel envelope padding. Each intersecting
native source block is decoded once, intersected with the window, masked, and
written. Polygon components are unioned; holes are preserved unless another
component covers them. The all-touched inclusion rule matches area sampling.
The export does not use histogram overviews, percentiles, or approximate grids.

The output preserves valid zero, signed nodata, scale, offset, units, band
description, and supported descriptive metadata. Non-finite data and cells
outside the selected geometry are invalid. An internal mask represents validity
without inventing a nodata value or promoting the datatype. Full-source statistics
are not copied. A lossless DEFLATE COG with nearest-neighbor overviews is reopened
to verify COG layout, native grid/type/CRS/nodata, overviews, and validity count;
then it is checksummed. TIFF tags and the separate JSON document record operation,
Catalog source/signature, geometry, grid, inclusion rule, and result provenance.
No private source or artifact paths are included.

Exported internal-mask COGs are downloads, not automatically published Catalog
assets. Future re-ingestion of those files needs an explicit input-mask policy;
this feature does not weaken the existing source reader to enable that path.

## Storage, deployment, and limits

`processing-worker` uses the application image with the separate
`python -m eolab_app.main processing-worker` command. Validated configuration and
dependency wiring stay in the existing settings/composition boundary; the worker
workflow reads no environment variables and creates no unrelated feature services.
It has two CPUs, a 2 GiB memory/swap ceiling, and at most two GDAL threads. Source
data remains mounted read-only. `processing-data` is a dedicated named volume,
writable only by the worker and mounted read-only by the HTTP app; GeoServer and
the Catalog scanner do not mount it. Set `EOLAB_PROCESSING_DATA_VOLUME_NAME` to an
instance-specific name when multiple EOLab stacks share a Docker host. Keep this
volume outside the source directory and preserve it across deployments.

The worker applies `processing/schema.sql` idempotently before consuming jobs,
using its own advisory lock and schema in the existing PostgreSQL database. It
does not use or migrate pgSTAC tables. No new Redis or queue product is required.
The HTTP app does not depend on processing startup for `/healthz`, catalog,
histograms, or rendering. Processing requests return an actionable 503 until its
schema/database is available.

Initial fixed policy, shared by API and worker:

| Resource | Limit |
| --- | --- |
| Active native clip jobs | 1 globally, including overlapping worker deployments |
| Waiting jobs | 10 globally; 2 unfinished per browser session |
| Metadata planning | 1 child globally; 15-second inclusive deadline |
| Retained plans | 5 per session, 50 globally, 5-minute lifetime |
| Native output estimate, including validity | 1 GiB |
| Decoded native source work | 4 GiB; at most 65,536 blocks; existing 64 MiB per-block ceiling |
| AOI snapshot / transformed coordinates | 8 MiB / 500,000 |
| Clip execution and finalization | 10 minutes |
| Temporary result/scratch reservations | 20 GiB globally |
| Physical free-space floor | 2 GiB, checked again before execution |
| Result lifetime | 24 hours after completion |
| Transfers | 4 per result, 64 globally; renewable 120-second leases; 1-hour response ceiling |

Disk admission reserves four times uncompressed output-plus-validity plus 32 MiB
for staging, COG/overviews, and finalization. Completed jobs retain the actual TIFF
size plus a conservative provenance allowance. Reservations remain until failed,
cancelled, deleted, or expired files are successfully removed. Actual free disk
and existing artifact bytes are checked before native work. Download leases keep
cleanup away from in-flight transfers; disconnect/completion releases them, and
an abandoned API instance's lease expires. New downloads cannot begin after TTL.

PostgreSQL transactions arbitrate the global queue and execution slot. Each
attempt receives a fresh fencing token, renewable heartbeat lease, and immutable
hard deadline. Normal worker shutdown stops and joins its native child and marks
the job interrupted. After an abrupt worker/database failure, takeover waits until
the previous hard deadline plus exit grace before starting another clip. This can
delay the queue by up to about ten minutes, deliberately avoiding duplicate native
work. Linux children also carry their own wall-clock alarm. Interrupted jobs are
explicitly retryable by creating a new plan/job; partial TIFFs are never resumed.

Processing owns `PROCESSING_ADVISORY_LOCK_ID = 7_610_329` in PostgreSQL's
single-bigint advisory-lock namespace for this database. This is an assigned lock
identifier, not a resource limit. Schema migration and shared admission, job-state,
storage, and transfer decisions acquire it only for their short transactions;
commit or rollback releases it. Native processing does not hold this lock. Keep
the value stable across releases and operation types that share these budgets,
including overlapping deployments. Other components in this database must use a
different key. A future change to the key or key format requires a coordinated
migration so old and new workers do not accidentally use independent locks.

An attempt writes into private storage and closes/validates all output before an
atomic same-volume directory rename. A still-current database fence is required
to advertise it as ready. Cancellation or a stale worker cannot expose a partial
file. Startup/periodic cleanup removes old orphan attempts and terminal job files
after transfer leases end. It clears job-owned AOI snapshots and expired plans,
then retains only bounded-time idempotency tombstones. Accepted AOI snapshots
have their own job lifecycle: deleting or expiring the original temporary upload
does not invalidate accepted work or restore any uploaded attributes/files.

## Architecture and extension boundary

The browser **Downloads** component (`frontend/src/processing`) owns review,
submission recovery, polling, and job actions. **Used by:** the browser composition
root, which connects the existing dock and source/area entry points.
**Depends on:** its Processing API client, per-tab pending-submission storage,
and the neutral immutable selected-area values. **Coordinates with:** Map layers,
histogram controls, and temporary AOIs through root callbacks and lifecycle
snapshots. None of those peers imports Downloads or vice versa.

The existing bounds validation and sampling-area normalization move into
`frontend/src/selected-area.js`; raster geometry/statistics retain their existing
exports. Sampling and clipping now share the same frozen box/AOI values instead
of duplicating validation. Backend services, APIs, queue/storage limits, AOI
lifecycle, and rendering dependencies are unchanged. The dock adds only a tool
descriptor and presentation methods. Remaining coupling is the intentional
shared geographic selection contract and existing browser composition wiring.

**Owner:** Processing (`models`, `service`, `worker`, `raster_clip`, storage ports
and adapters). **Used by:** thin processing HTTP routes and the Downloads UI
through that public API. **Depends on:** existing Catalog source-authorization
port, neutral sampling-area reader, source identity/structure/native-block/grid
mechanisms, bounded native process execution, and processing-owned PostgreSQL and
artifact adapters. **Coordinates with:** temporary AOIs only through immutable
geometry from the neutral reader; no AOI service/storage implementation import.

Changes to existing components are limited to composition, deployment/settings,
and two justified mechanism extractions. Statistics delegates its polygon
projection/window calculation to `raster/bounded_window` with its original
transformation budget and injectable transformer. Temporary AOIs delegate process
supervision to `execution/bounded_process`, retaining their validation dispatch,
error mapping, and time policy. The clip kernel shares those two real mechanisms.
Storage adapters and the supervisor do not import or invoke application services.
Histogram, rendering, AOI lifecycle, and Catalog implementations do not acquire
knowledge of Processing or one another.

Job persistence consumes a `PreparedJobPlan`: operation-owned serialized input,
a bounded public summary, and a storage reservation. The clip owner derives these
from its validated source, area, and grid; the `JobStore` contract and PostgreSQL
adapter do not parse raster fields or construct AOI summaries. Admission, leases,
cancellation, and expiration are shared job responsibilities. The HTTP API still
accepts only the explicitly supported raster-clip operation.

`processing/models.py` owns reusable submission, job status/timestamps, progress,
failure, download metadata, listing, storage values, and scheduling-limit models.
`processing/clip_models.py` contains the native grid, area, source-fenced clip
specification, clip request/plan, and raster-specific result details. Clip response
models extend the shared job and download models; the list uses the same generic
envelope. Future operations define their own validated inputs and result details
and reuse the common lifecycle instead of duplicating it. No arbitrary operation
payload or executable command is accepted by the public API. Existing clip JSON
fields and persisted job specifications retain their shape.

`ProcessingService` exposes shared job lifecycle methods and explicit
`plan_raster_clip` / `submit_raster_clip` commands. HTTP routes use job terminology
for listing, cancellation, status, and downloads; only the operation commands and
their raster-specific schemas refer to clips. `LeasedJobResponse` takes its media
type from the owned artifact descriptor, preserving resumable delivery for other
file formats. Retained results written before media types were recorded keep
their TIFF content type. This does not add another executable operation or a
generic operation-submission endpoint.

Future operations can reuse job ownership, durable admission, execution fencing,
and artifact delivery, but should introduce their own validated specifications,
resource estimates, algorithms, and result contracts when a second operation is
approved. This version deliberately has no user-defined code, arbitrary GDAL
options, plugin registry, workflow graph, multiband/reprojection UI, or automatic
publication. The remaining operational coupling is shared PostgreSQL, source
storage, and host I/O; separate worker limits do not eliminate disk contention.

## Verification

Native GeoTIFF tests verify exact values, zeros/nodata, polygons and holes, rotated
and projected grids, metadata, COGs/overviews/checksums, size/work refusal, and hard
native cancellation. Real PostgreSQL boundary tests cover idempotent concurrent
admission, source and AOI lifecycle revalidation, global worker fencing, lease-loss
recovery, queued/running/finalization cancellation, worker shutdown, owned session
access, complete/range/HEAD downloads, expiration and transfer-safe cleanup.
Import/deployment tests guard the architectural boundaries and read-only mounts.

Run against a disposable database whose name begins `eolab_processing_test`:

```sh
python -m pytest --processing-dsn=postgresql://USER@localhost:5432/eolab_processing_test
```

Without that option, PostgreSQL-specific tests are skipped; native raster,
route/composition, architecture, and existing feature tests still run. The database
tests truncate only the Processing tables in the explicitly named test database.
