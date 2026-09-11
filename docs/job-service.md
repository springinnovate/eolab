# Standalone Job service

The `jobs` Compose service executes the installed `diagnostic.v1` operation.
This first execution lifecycle does not migrate EOLab's existing raster, vector
or Processing workloads. Open `/api/jobs/docs` on the app to try it.

## Configure a caller

Generate a unique token per trusted caller with
`python -c "import secrets; print(secrets.token_urlsafe(32))"`.
Set **`EOLAB_JOBS_CALLERS`** in the Compose/Coolify deployment environment to a
JSON object mapping stable caller names to their tokens:

```json
{"reviewer":"REPLACE_WITH_A_GENERATED_RANDOM_TOKEN"}
```

Compose supplies this as `JOBS_CALLERS` inside the service. For standalone Docker
or Python, set `JOBS_CALLERS` directly. Tokens must be unique 32–256-character
URL-safe strings; at most 32 named callers are supported. Empty configuration
leaves docs/health/discovery available but disables job access. Invalid
configuration fails startup without printing submitted secrets.

In Swagger, click **Authorize** and paste just the token. Each caller owns only
its own jobs. Sharing a token means sharing ownership: this is not yet integrated
with browser sessions. Do not put an administrator token in frontend code. Use
HTTPS remotely. The service authenticates configured callers; it never accepts
an arbitrary owner field/header. It trusts those callers to select priorities.

## Try the diagnostic

Use **POST `/api/jobs`** with a fresh `Idempotency-Key` header for each new job,
such as `review-normal-1`:

```json
{
  "operation": "diagnostic.v1",
  "inputs": {"mode": "normal", "value": {"message": "hello", "number": 42}}
}
```

The **202** response contains a `jobId` and status `Location`. Poll
GET `/api/jobs/{job_id}` until `succeeded`, then GET
`/api/jobs/{job_id}/result`. Its `value` contains
`{"value":{"message":"hello","number":42}}`: the outer result field is generic;
the inner `value` is the diagnostic echo field. JSON objects, arrays, strings,
numbers, booleans and null are supported, capped at 8 KiB after serialization.

For a delay, use a new key and:

```json
{
  "operation": "diagnostic.v1",
  "inputs": {"mode": "delay", "seconds": 20, "value": "finished waiting"},
  "executionTimeoutSeconds": 30,
  "queueTimeoutSeconds": 60,
  "priority": 0
}
```

- Submit another normal job; it remains `queued` until the worker is free.
- POST `/{job_id}/cancel` on the delay. It reports `cancelling`, then `cancelled`
  after its child is stopped and reaped. The waiting job then runs.
- Use `executionTimeoutSeconds: 1` with the delay to observe `timed_out`.
- Keep a delay running and submit another job with `queueTimeoutSeconds: 1`.
  That queued job becomes `expired` without executing.
- Queue several jobs and PATCH one with `{"priority":10}`. Higher priority starts
  first; ties retain arrival order. Priority never interrupts running work.

For failure, submit with another new key:

```json
{"operation":"diagnostic.v1","inputs":{"mode":"exception"}}
```

This raises in the child; the job becomes `failed` with a safe error. Subsequent
jobs still run. No traceback, credentials or input values are returned in errors.
`seconds` must be positive and at most 300 in delay mode, and zero/omitted in other
modes. The default mode is `normal`.

## Lifecycle and limits

- One running job, **32 waiting**, **128 retained records** across all callers.
  Retained records include active jobs.
- Queue/execution deadlines separately default to **60 seconds**; clients may
  request 1–300 seconds. Execution includes process startup and result transfer.
  Queue expiry reconciliation has up to 100 ms granularity. Cleanup can finish
  after a deadline; capacity is never released before the child exits.
- Terminal records/results/idempotency keys expire together **one hour after
  completion**. DELETE removes terminal state earlier. Full capacity returns
  **503 / Retry-After: 1**; that is retry advice, not a capacity guarantee.
- State is **in memory per service process**. Restart loses all jobs, results and
  idempotency keys. There is no replay or automatic retry after restart. Run one
  service replica and one Uvicorn worker; the image explicitly sets `--workers 1`.
  Persistence and horizontal scaling are future work.
- Same caller, key and request return the retained job; changed inputs/settings
  return **409**. JSON object-key order is ignored. Delete, expiry or restart
  permits key reuse.
- Cancellation is immediate for queued work. Running cancellation publishes its
  final state only after process cleanup. Cancellation processed before completion
  publication wins; terminal jobs stay terminal.
- HTTP disconnect does not cancel an admitted job. Retry uncertain submission
  with the same idempotency key; cancel explicitly by job ID.
- Priorities trust configured callers; fairness is not promised. This is not an
  anonymous execution endpoint.
- Shutdown stops admission, cancels queued/running work and waits for cleanup.
  Hard container termination discards all ephemeral state.

## API

Job-specific endpoints require bearer authentication. Wrong-owner IDs return the
same **404** as missing jobs. Responses use `Cache-Control: no-store`.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/jobs/health` | Public readiness, ephemeral mode, acceptsJobs |
| GET | `/api/jobs/operations` | Public installed-operation schemas |
| POST | `/api/jobs` | Submit/idempotent retry; 202 and status Location |
| GET | `/api/jobs` | Owned listing; status filter, limit 1–100, cursor |
| GET | `/api/jobs/{job_id}` | Authoritative current status |
| PATCH | `/api/jobs/{job_id}` | Change queued priority |
| POST | `/api/jobs/{job_id}/cancel` | Request cancellation |
| GET | `/api/jobs/{job_id}/result` | Successful inline JSON; 409 otherwise |
| DELETE | `/api/jobs/{job_id}` | Delete terminal state/result/key; 204 |
| GET | `/api/jobs/{job_id}/events` | Owned-job check then 501; no SSE yet |
| GET | `/api/jobs/{job_id}/artifacts/{artifact_id}` | Owned-job check then 501 |
| GET | `/api/jobs/docs` | Public Swagger UI |
| GET | `/api/jobs/openapi.json` | Public OpenAPI 0.2.0 |

Listing is admission-ordered. Cursors refer to the last retained owned record and
become invalid after it is deleted/expires. Pages reflect current state, not a
frozen snapshot. No artifact files exist yet. Polling is sufficient for this
diagnostic phase; notification delivery will be designed separately.

Requests are bounded to 64 KiB before decoding; subprocess messages to 64 KiB.
The proxy retains its 1 MiB response bound and 10-second timeout: requests return
state without holding HTTP connections through execution. Errors use the existing
`{"error":{"code":"...","message":"..."}}` envelope.

## Ownership and architecture

**Owner:** `services/jobs/job_service`. `app.py` owns HTTP/authentication;
`manager.py` owns ephemeral state/admission/priority/lifecycle; `execution.py`
owns subprocess cleanup and transport; `operations.py` registers the diagnostic
and its input/result models. `runner.py` is a private child entry point, not an
API accepting module names or paths.

**Used by:** REST/Swagger through EOLab's proxy. **Depends on:** the existing web
stack and Python standard-library processes. **Coordinates with:** Compose and
the existing proxy. That HTTP edge now carries Authorization to the fixed
`http://jobs:8080` endpoint. Cookies/arbitrary identity headers are not forwarded.
No new subsystem edge, application imports, source mounts, GIS dependencies or
database are added. Existing Processing, raster/vector, catalog and rendering
boundaries remain unchanged.

The first version uses a fresh child per job for isolation/hard stopping; it does
not prewarm native processes. Only installed code runs. Child environments omit
caller credentials and other service secrets. The diagnostic spawns no descendants;
process-tree handling, source authorization/mount resolution and workload-specific
memory admission must precede installing more capable operations. Docker remains
non-root, read-only, capability-dropped, one CPU and 256 MiB, without source mounts.

## Local verification

Set `JOBS_CALLERS`, then run:

```sh
python -m uvicorn job_service.app:create_app --factory --app-dir services/jobs --host 127.0.0.1 --port 8082 --workers 1
```

Or, with Docker and the same environment variable:

```sh
docker build --platform linux/amd64 -f services/jobs/Dockerfile -t eolab-jobs:diagnostic .
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges --cpus 1 --memory 256m --env JOBS_CALLERS -p 127.0.0.1:8082:8080 eolab-jobs:diagnostic
```

Open http://127.0.0.1:8082/api/jobs/docs and authorize. To smoke-test HTTP, set
`JOBS_SMOKE_TOKEN` to one configured token and run
`python services/jobs/smoke.py http://127.0.0.1:8082`.

```sh
python -m pytest tests/test_job_service.py tests/test_job_lifecycle.py
python -m pytest tests/test_compose_configuration.py tests/test_application_boundaries.py
```

Tests cover real subprocesses, API/proxy composition, ownership, priority/FIFO,
cancellation, deadlines, failure recovery and retention. The existing build
workflow smoke-tests the container with temporary credentials. No new workflow
or production deployment is introduced.
