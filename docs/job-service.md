# Job service API preview

The `jobs` Compose service is an independently runnable HTTP contract preview.
It does **not** execute jobs. Health, operation discovery and interactive docs
work; all job actions return `501 Not Implemented` after structural validation.
There are no installed operations, jobs, queue, database, workers or source mounts.
Existing histogram, vector-selection and Processing paths remain unchanged.

## Try it

After deploying this branch with the normal EOLab Compose stack, open
`/api/jobs/docs` on your EOLab instance. Swagger UI's JavaScript/CSS use the
standard FastAPI CDN. `/api/jobs/openapi.json` works without that CDN.

- `/api/jobs/health` reports `ready: true`, `mode: "stub"`, `acceptsJobs: false`.
- `/api/jobs/operations` returns `{"operations": []}`.

Standalone Docker demo, from the repository root:

```sh
docker build --platform linux/amd64 -f services/jobs/Dockerfile -t eolab-jobs .
docker run --rm --name eolab-jobs-demo --read-only --cap-drop ALL \
  --security-opt no-new-privileges --cpus 1 --memory 256m \
  -p 127.0.0.1:8082:8080 eolab-jobs
```

Open `http://127.0.0.1:8082/api/jobs/docs`. This needs no EOLab configuration,
database, GeoServer, catalog or source mount. Normal Compose exposes the same
service through the app, with no new host port.

Alternatively, in a Python environment with FastAPI/Pydantic/Uvicorn installed:

```sh
python -m uvicorn job_service.app:create_app --factory --app-dir services/jobs --host 127.0.0.1 --port 8082
```

Submit through Swagger, or save this as `job.json`:

```json
{
  "operation": "demo.sum.v1",
  "inputs": {"values": [10, 20, 30]},
  "priority": 10,
  "executionTimeoutSeconds": 60,
  "queueTimeoutSeconds": 30
}
```

```sh
curl -i -H "Content-Type: application/json" -H "Idempotency-Key: demo-1" --data-binary @job.json http://127.0.0.1:8082/api/jobs
```

The expected current response is **501**:

```json
{
  "error": {
    "code": "not_implemented",
    "message": "Job execution is not implemented; no job was created or changed."
  }
}
```

`demo.sum.v1` is illustrative, not an installed operation. No job ID is returned.
Use any valid UUID to explore ID-based stubs, such as
`00000000-0000-4000-8000-000000000001`. The response does not claim that this job
exists or that the caller owns it. Repeated submissions still return 501;
idempotency is a proposed contract, not implemented behavior.

## API contract

Both the standalone container and public app use `/api/jobs`.

| Method | Suffix | Current behavior / future purpose |
|---|---|---|
| GET | `/health` | 200; HTTP readiness and explicit stub mode |
| GET | `/operations` | 200; empty installed-operation inventory |
| POST | (none) | 501; future submission |
| GET | (none) | 501; future owned jobs with status/limit/cursor |
| GET | `/{job_id}` | 501; future status/progress/timestamps/errors |
| PATCH | `/{job_id}` | 501; future queued-priority update |
| POST | `/{job_id}/cancel` | 501; future cancellation |
| GET | `/{job_id}/result` | 501; future inline JSON and artifact metadata |
| GET | `/{job_id}/artifacts/{artifact_id}` | JSON 501; no file access |
| GET | `/{job_id}/events` | JSON 501; no SSE connection or replay |
| DELETE | `/{job_id}` | 501; future terminal-job/result cleanup |
| GET | `/docs` | Interactive API preview |
| GET | `/openapi.json` | OpenAPI schema, API version 0.1.0 |

OpenAPI includes proposed successful JSON models alongside actual 501 responses.
The 202/200 job responses are not implemented. Job/artifact IDs are UUIDs, not
authorization; future downloads address artifacts by ID, never a filesystem path.

Submission requires an `Idempotency-Key` header of 1–128 ASCII letters, digits,
period, underscore, colon or hyphen, an operation name (up to 128 lowercase
identifier characters, starting with a letter), and an `inputs` JSON object.
Priority is a strict integer from -1000 to 1000, default 0. Optional queue and
execution timeouts are distinct positive integer seconds, at most 86400. These
are preview schema bounds; future operation/service limits govern admission.
Unknown body fields are rejected. PATCH accepts only `priority`.

Listing accepts an optional `status`, `limit` (1–100, default 20) and opaque
`cursor` (up to 512 characters). No fabricated empty history is returned.

Requests are bounded to 64 KiB before JSON decoding, including chunked requests.
The app preview proxy buffers at most 1 MiB of response data with a 10-second
client timeout. Real SSE and large artifact streaming require a later change.
Errors use `{"error":{"code":"...","message":"..."}}`: 413 for oversized
requests, 422 for invalid input, 404 for unknown service paths, 405 for unsupported
methods, and 502 for unavailable/invalid upstream responses at the proxy.

## Lifecycle reserved for later implementation

States: queued, running, cancelling, cancelled, succeeded, failed, timed_out
(execution deadline), expired (queue deadline). Higher queued priorities start
first; ties use arrival order. Priority does not preempt running work. Cancellation
must stop execution before releasing capacity; races return authoritative state.
DELETE requires a terminal job. A full waiting queue will return 503/Retry-After
without admitting work. None of this scheduling, persistence or deletion exists yet.

SSE is reserved, not implemented or benchmarked here. Before enabling it, specify
measured update needs, authoritative status snapshots, subscription races,
reconnect/loss/replay behavior, owner isolation, connection/backpressure bounds,
shutdown and proxy streaming. Notifications should prompt authoritative refresh;
status lookup remains the recovery path.

## Architecture and deployment

**Owner:** `services/jobs/job_service` owns the independent schemas and preview
handlers. **Used by:** manual clients through EOLab's HTTP boundary. **Depends on:**
Python, FastAPI/Pydantic/Starlette and Uvicorn only. **Coordinates with:** existing
app composition, its dedicated HTTP client and `routes/jobs_proxy.py`.

The sole added application dependency is app proxy → Job service over HTTP. No
service code imports EOLab features. Source identity, existing Processing storage,
workers, authorization, cancellation and rendering/analysis boundaries are untouched.

The trusted internal endpoint is `http://jobs:8080`. Compose runs the HTTP-only
preview as a non-root user with a read-only filesystem, one CPU, 256 MiB RAM and
32 process IDs. These are not production calculation capacity settings. There
are no credentials or data mounts. The app does not wait for Jobs at startup;
its absence returns 502 only for Jobs requests.

**Authentication is deliberately absent from this stateless preview.** The proxy
forwards only Accept, Content-Type, Idempotency-Key and Last-Event-ID; it does not
forward cookies or Authorization. Before accepting actual work or returning jobs,
implement authenticated callers, owner-scoped reads/listing/cancel/results,
idempotency and trusted priorities. EOLab public source references must remain
catalog identities. Any future internal file reference requires authorization
and a confined mount resolver. Do not enable execution by simply replacing the
stub function.

The image uses the reviewed Python base and a hash-verified web-only subset of
`deployment/application-runtime-requirements.txt`. When updating that resolution,
review `services/jobs/requirements.txt`, rebuild on Linux amd64 and run pip check
and API tests. It installs no application wheel, GIS or database packages.

## Verification

```sh
python -m pytest tests/test_job_service.py
python -m pytest tests/test_compose_configuration.py tests/test_application_boundaries.py
```

Tests exercise every hook directly and across the real service/proxy ASGI boundary,
validation, body/response bounds, header isolation and Jobs outage behavior. An
import regression protects service independence. The complete backend suite must
remain green. The existing application build workflow also builds and starts the
standalone image and checks health/OpenAPI/501. Container tests require Docker;
ASGI tests alone do not prove deployed-container startup.
