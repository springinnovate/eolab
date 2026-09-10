# Processing live job updates

Processing calculations and clip downloads share one browser job store. While
it has active or explicitly tracked jobs, it opens one same-origin EventSource
connection to `GET /api/processing/events`. A `changed` event with the fixed
payload `{}` asks that store to refresh through the existing authorized job API.
There are no job results, IDs, owner hashes, paths or operation inputs in SSE.
Idle pages close the stream. Missing/unsupported/disconnected streams retain
the existing two-second active-job polling safety net (30 seconds when idle).
Even a connected stream keeps that safety refresh, so lost hints cannot strand
a job. No faster polling interval is introduced.

## Commit and reconnect semantics

An idempotent Processing schema migration adds a trigger for job insertion and
changes to `status` or `progress`. Lease renewals with unchanged progress do not
notify. PostgreSQL delivers hints only after commit, never after rollback. The
internal notification contains only the existing owner's SHA-256 session hash;
it is not the HttpOnly session capability. A separate change channel avoids
waking the execution worker for progress/ready events.

One listener per API process routes each hint to that owner's subscribers. Each
subscription holds one coalescing bit; bursts do not accumulate payloads or an
unbounded event history. This reuses the same bounded PostgreSQL transport as
the existing execution-worker wakeup. The worker's durable admission, attempt
fencing and cancellation rules are unchanged. Storage never calls a service.

The SSE route uses the existing session-cookie ownership boundary and rejects
cross-origin requests. It subscribes before sending the initial `changed`
frame. This requests a snapshot on every connection/reconnection, covering a
job that finished before the browser connected. Database reconnects also prompt
fresh snapshots. If a hint arrives during an HTTP status read, the browser
coalesces it into one additional read after that request finishes, so the ready
transition cannot be lost behind an older snapshot. Existing accepted-job
revision protection remains in place.

## Limits and lifecycle

- One additional PostgreSQL connection per API process, not per browser.
- At most 128 streams per API process and four per session on that process.
  At capacity the endpoint returns 503; ordinary job polling remains available.
- Fixed-size heartbeat comments every 15 idle seconds. Browser reconnect delay
  is two seconds. Streams end after five minutes, including time blocked on a
  slow client; final response closure has at most one extra second to flush.
- `private, no-store, no-transform` and `X-Accel-Buffering: no` prevent caching
  and request unbuffered proxy delivery. Deployment still needs live verification
  through the actual reverse proxy.
- Disconnect, response failure, expiry and application shutdown release stream
  capacity. Closing the notification connection never cancels a processing job.
- PostgreSQL reconnect attempts are bounded and spaced by at least five seconds.
  No replay log is required: notifications are hints; owned snapshots are truth.

The tradeoff is retained HTTP streams, one extra database connection per API
process, and notification-triggered status reads. The bounded listener and
subscriptions do not introduce a second scheduler or increase native concurrency.

## Architecture impact

Owner: Processing. Used by: the shared browser job store for calculation/clip
panels, existing HTTP routes and application composition. Depends on: existing
job persistence, session ownership, PostgreSQL notification transport and ASGI
streaming. Coordinates with: no new sibling features.

Changed components: Processing schema, notification adapter, new bounded fanout
adapter, `JobChanges`/`JobSubscription` ports, service composition, HTTP events
response, browser API/job store, timing wording, tests and documentation.

Added edges: service to Processing's `JobChanges` port; composition to its
`PostgresJobEvents` adapter; that adapter and existing worker wakeup to the
same Processing-owned `PostgresNotifications` transport; events response to the
existing neutral HTTP disconnect helper and subscription port; browser job
store to its API client's event subscription. The worker wakeup's connection
mechanism is redirected through the shared transport, preserving its contract.
No subsystem acquires sibling implementation knowledge. No new top-level
service/coordinator, library or cross-subsystem dependency is introduced. The
new public events endpoint is required for SSE; existing result contracts and
execution claim versions are unchanged. Migration version 3 adds only the owned
trigger/function, without changing job columns or catalog tables.

## Other polling candidates

| Path | Current behavior | SSE assessment |
| --- | --- | --- |
| Clip downloads | Same two-second processing job poller | Included automatically in this change. |
| Catalog scan progress/completion | Checks `/api/scans/current` every 750 ms during a scan | Best separate follow-up: publish scan progress and completion, then refresh catalog results immediately. Keep this owned by scanning/catalog. |
| Rendering diagnostics | Five seconds while expanded; 60 seconds while collapsed; stopped when page hidden | Lower priority. Pushing samples could reduce duplicate browser checks, but upstream metrics still need collection. Keep the existing diagnostics boundary. |
| Uploaded AOI preparation | One request with estimated progress stages, not a completion poll | Real progress events could improve feedback, but require an AOI-owned progress contract rather than replacing a polling delay. |
| Histograms, pixel picking, formula/style edits | Direct requests, cancellation, debounces and bounded retries | No slow job-status polling to replace. |

These other features are assessed only, not modified or coupled to Processing.

## Verification

Tests cover session-isolated fanout/caps, burst coalescing, shutdown before reader
startup, same-origin enforcement, ASGI 2.0/2.4 streaming and disconnects, immediate
snapshot frames, heartbeats, bounded slow clients and response lifetime. Browser
tests cover a shared clip/calculation stream, fixed event validation, stale-read
races, unsupported/missing SSE, retained two-second polling, and shutdown.

The real PostgreSQL test migrates twice, then verifies rollback silence, commit
delivery, idempotent submission silence, claim/progress/failure/deletion changes,
unchanged heartbeat silence and stale-finish silence. It requires an explicitly
disposable `eolab_processing_test*` database via `--processing-dsn`; it must never
target production.

Executed locally: **151 passed, 28 skipped** with the following Python command.
Twenty-seven skips need the disposable PostgreSQL fixture; one is Linux-only
RSS recycling on this Windows host. No local PostgreSQL/Docker test service is
available. The full frontend suite passed **695 tests**, and the Vite production
build passed with its existing bundle-size advisory. Black on changed Python
modules/tests and `git diff --check` passed.

```text
python -m pytest tests/test_processing_events.py tests/test_processing_events_postgres.py tests/test_reusable_process.py tests/test_processing_warm.py tests/test_processing_timings.py tests/test_processing_models.py tests/test_processing_architecture.py tests/test_processing_jobs.py tests/test_processing_calculations.py tests/test_processing_http.py tests/test_processing_wakeup.py tests/test_raster_clips.py tests/test_raster_aggregates.py tests/test_app.py tests/test_application_boundaries.py tests/test_compose_configuration.py -ra --tb=short --disable-warnings
```

From `frontend`: `node --test --test-reporter=dot` and
`node node_modules/vite/bin/vite.js build`.

See [request latency investigation](request-latency-investigation.md) for earlier
measurements and the unchanged total/browser/server timing boundaries.
