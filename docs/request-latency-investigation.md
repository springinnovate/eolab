# Request-to-result latency investigation (#364)

Keep the batching and timing changes merged in #363. This investigation starts
at `5dfcd785952076f6ac630427ceaefa2a25bc87d4`. Instrumentation was deployed first;
the measured plan-reuse, queue-wakeup and reusable-process changes below follow
that baseline. Historical request-path observations are retained explicitly.

## Reusable planning and execution processes

Processing now prestarts one native process for API planning and a separate one
for the job worker. Each accepts one admitted operation at a time and imports
the fixed clip/calculation targets before reporting readiness. Raster datasets,
AOI inputs and output directories remain request-owned: every operation opens
and closes its own resources, with existing source authorization/signature
checks before and after native work. No raster handles or result cache is added.

The neutral supervisor captures the target's result but acknowledges it only
after the entire target returns, including context cleanup, and request objects
are released. Cancellation, deadline, transport failure or native crash kills
and joins the old process before admission can release; its pipe is discarded.
The next generation prestarts in the background. Shutdown prevents replacement
and reaps startup/active/idle children. Linux operations retain their own hard
alarm, including if the parent disappears; an idle child's pipe receives EOF.

Processes recycle after 100 operations or a Linux peak RSS above 512 MiB.
This is between-operation recycling, not permission to exceed existing
admission or container limits. Libraries/GDAL can retain memory between jobs,
so the tradeoff is additional idle memory and occasional replacement latency.
The two roles remain separate, with unchanged single global planning and
execution admission. Temporary-AOI/vector callers retain their one-shot path.

Optional `timing.process` / `executionTiming.process` metadata divides native
duration into readiness wait, full target execution, and request/reply plus
cleanup/recycling overhead. `reusedProcess` means an earlier operation completed
in the same interpreter; the first operation may already be prewarmed.
Prewarming completed before the request is excluded, never assigned a fake zero
startup measurement. Old results without these fields still render normally.

Owner: Processing. Used by: its planner and job worker, wired by composition.
Depends on: the neutral `execution.reusable_process` mechanism and existing
catalog, AOI, job-store and artifact contracts. Coordinates with: no new sibling
features. Added edges: Processing's service/worker/factory to the neutral
supervisor; composition to the Processing-owned process factory. Neutral
execution imports no application or domain subsystem. No infrastructure adapter
calls a service; no new library, schema migration or concurrency increase.
Only optional diagnostic fields extend public result contracts. The explicit
native completion contract now permits a retained interpreter after all
request work/cleanup finishes; cancellation still requires confirmed exit.

Real-process tests cover reuse, large payloads, full-return acknowledgment,
cancellation, deadline, crash, startup/shutdown, periodic recycling, and Linux
RSS recycling. Real raster tests reopen changed sources, preserve nodata and
aggregate results, reject changed source signatures, and verify a warm clip's
COG and exact pixels. RSS recycling is platform-skipped on Windows.

Run the same synthetic benchmark with and without `--warm`. Windows observations
from this change (seconds, sequential samples, OS caches not flushed):

| Mode | Pass | Plan round trip | Execution round trip | Kernel |
| --- | ---: | ---: | ---: | ---: |
| One-shot | 1 | 1.168 | 1.208 | 0.034 |
| One-shot | 2 | 1.189 | 1.233 | 0.030 |
| One-shot | 3 | 1.176 | 1.252 | 0.032 |
| Warm | 1 | 1.040 | 0.052 | 0.026 |
| Warm | 2 | 0.030 | 0.037 | 0.012 |
| Warm | 3 | 0.024 | 0.051 | 0.013 |

The warm planner's first request waited 1.005 s for startup; the executor had
already prewarmed during that wait. Later requests reused both processes.
The one-shot sample also overlapped test activity; these small observations
establish the mechanism's effect, not a controlled production speedup. Native
library caches can improve the kernel too. Live measurements must include the
unchanged HTTP, database and browser polling path.

## Reviewed-plan reuse and idle-worker wakeup

Two sequential production runs at `9afcc93` used `mean(a)`, Human Footprint 2023,
Countries filtered to Peru, and default batching. They returned the same mean
4.748740795296266, with 841,871 valid pixels, 12 reads and 35 calculation tiles.
Total request-to-display was 5.557 / 5.569 s; repeated planning took 1.283 / 1.303 s;
queue wait was 1.665 / 1.550 s. Calculation native-process time was 2.336 / 2.399 s,
including 0.951 / 0.983 s of kernel work. These are sequential observations, not
controlled cold-cache benchmarks. Nested stages overlap browser durations.

Summary-card confirmation now retains the existing reviewed plan only for an
identical complete intent: source, area reference/bounds, formula batch, labels
and execution budget. Expired plans still get released and replaced. Server
submission still checks plan ownership/expiry, current source signatures, AOI
lifecycle and resource admission. Nothing caches or reuses accepted results.

Queue admission now sends an empty `eolab_processing_jobs` PostgreSQL NOTIFY in
the same transaction as the inserted job. A rollback produces neither job nor
notification. A dedicated autocommit listener commits LISTEN before the worker
checks the queue. Hints coalesce into one event and are drained even during
execution. An arrival between the empty claim and idle wait is retained; a hint
never grants permission to execute. The existing locked claim, attempt fencing,
single execution slot and cancellation acknowledgment remain authoritative.

Missing notifications fall back to the existing two-second idle interval.
Listener connection/setup is bounded by three seconds, failed reconnects are
spaced by at least five seconds, and shutdown joins the reader and closes its
connection, including cancellation during startup. This adds one database
connection per worker, not another worker or processing lane. Psycopg async
connections require a selector event loop; unsupported Windows loops fall back
to polling. The Linux Compose deployment supports this listener.

Owner: Processing. Used by: the summary panel and the existing worker composition
entry point. Depends on: the existing Processing API/job store, PostgreSQL and
asyncio. Coordinates with: no additional peers. Changed components: calculation
controller, job-store adapter, worker loop, composition, tests and this report.
Added edges: worker to the Processing-owned `JobWakeup` port; composition to
`PostgresJobWakeup`; job-store adapter to that adapter module's channel constant.
No cross-subsystem edge, new library, schema migration or public HTTP contract
is introduced. No subsystem acquires sibling implementation knowledge. The
fallback interval and dedicated connection are explicit operational tradeoffs.
At this intermediate revision, native-process startup, kernel algorithms and
browser polling were unchanged.

Verification covers exact intent/expiry/rejection at the browser owner, listener
registration and races, coalescing, reconnect, missing-hint fallback and shutdown.
A real PostgreSQL test checks rollback versus committed admission, delivery to
two listeners, idempotency and one successful claim. It requires the existing
disposable `--processing-dsn` fixture; it must never target the application DB.
The LISTEN-before-check ordering follows the [PostgreSQL LISTEN contract](https://www.postgresql.org/docs/current/sql-listen.html).

## Deployed instrumentation contract

Statistic-card Performance details retain total wait and kernel measurements,
and now show additive browser stages: before planning (including debounce,
validation and waiting for previous work), planning round trip, the interval
before submission, submission round trip, and submission-response to result DOM
update. These use the same monotonic clock as total wait. A reused review is
labelled; its previous server planning time is not shown as part of the current
request. Incomplete traces after reload or uncertain submission/retry are
omitted rather than inferred. Total wait remains available when its original
start is still known. Each successful card keeps its own immutable trace.

`AggregatePlanResponse.timing` optionally reports server admission/reservation,
source/AOI preparation, the bounded native-process call (including bootstrap
and transfer), and source recheck/plan finalization. These are monotonic durations
within the service method; HTTP parsing/serialization and network time are
outside them. Plan timings are local to that response, not part of the immutable
calculation specification or persisted results.

`AggregateResultResponse.executionTiming` optionally reports queue wait, worker
source/scratch preparation, the bounded native-process call and source recheck/
file publication. The worker stores this small path-free metadata through the
existing artifact JSON storage. Old artifacts/workers return null. Queue wait
uses the database's claim `updated_at` minus `created_at` from the immutable
claimed row, captured before any heartbeat replaces `updated_at` in storage.
The other worker stages use its monotonic clock. No DB schema change is needed.

`AggregateResultResponse.queuedToReadySeconds` uses the database's ready
`updated_at` minus `created_at`, only when a ready artifact is exposed. Both
timestamps are from the same database clock. PostgreSQL transaction timestamps
refer to transaction start, so commit/lock wait boundaries can affect small
residuals. Expired/cancelled/failed jobs do not expose a ready result. Negative
database intervals after a clock adjustment are clamped to zero.

The UI labels the native-process minus kernel difference explicitly: it includes
startup, IPC, provenance/final checks and process exit, not startup alone. It
also shows nonnegative estimated remainders for other server scheduling/
completion time and submission-admission plus delivery. The latter subtracts
queued-to-ready duration from submission-dispatch to display duration; it
includes API work before queue insertion, commit/response transfer and polling,
and is **not** a network-only measurement. Browser/server timestamps are never
subtracted. Nested server stages overlap browser stages and must not be added
to the total again. This does not yet separate process import time from IPC or
polling wait from network transfer.

Timing fields are optional and finite/nonnegative at API boundaries. Existing
kernel/provenance metrics remain unchanged; post-kernel worker metrics are
stored in job metadata, not retroactively written into the provenance file.
Processing owns all additions: operation response/artifact models, service and
worker, browser API validation, controllers and performance views. Existing
job-store and execution interfaces are unchanged. No new cross-subsystem
dependencies, services, polling loops or worker claim versions are introduced.

## Initial evidence before optimizations

One WWF Connectivity observation on that revision, Human Footprint 2023 mean
over filtered Peru, showed **5.524 s total wait** and **1.090 s kernel elapsed**.
The 4.434 s difference cannot yet be assigned to one stage.

The initial request path contained these independently relevant stages:

1. Summary cards debounce validation by 700 ms for automatic edits/map requests.
   Manual Calculate on an already valid card does not add that delay.
2. The calculation controller serializes old-plan release, cancellation and new
   planning. It waits for cancellation acknowledgment before admitting new work.
3. `ProcessingService.plan_raster_calculation` reserves a plan, authorizes the
   source/resolves the AOI, runs a **fresh bounded plan child**, rechecks the
   source, and persists the plan.
4. Submission persists a queued job. `worker.serve` checks cleanup and admission
   and sleeps two seconds after finding no claimable work. That sleep can add
   nearly two seconds even on an otherwise idle worker; cleanup/storage time is
   additional. A busy worker introduces a different, potentially longer wait.
5. `ProcessingWorker._execute` authorizes, prepares scratch, starts a **fresh
   calculation child**, rechecks the source and publishes the artifacts. Finishing
   the job persists the ready state. The kernel timer excludes most of this.
6. `ProcessingJobs` schedules the next active-job refresh two seconds after the
   previous refresh completes, then the controller/view receive the result.
   Network time is additional. `accept()` resets that timer, so concurrent job
   mutations can postpone a pending poll; this is not evidence of starvation
   during a normal single calculation.

The worker's `asyncio.wait((task,), timeout=2)` is **not** an unconditional
two-second completion delay: it wakes when the execution task finishes. It does
bound the frequency of checking cancellation while work is still running.

## Reproducible local process measurement

Run:

```text
python tests/benchmark_request_latency.py --scratch .tmp-latency --repeats 3
```

The benchmark creates a synthetic 256 x 256, one-block, compressed uint16 TIFF
and evaluates `mean(a)`, checking that every result equals 7. It invokes the
real native dispatch through the existing bounded-process supervisor for both
planning and execution. A test-only wrapper measures child dispatch time; the
parent separately measures the whole bounded call. The difference includes
interpreter/import startup, IPC/serialization and process cleanup. It is not a
pure measurement of startup alone.

Observed on Windows with the workspace Python 3.12 environment, seconds:

| Pass | Plan round trip | Plan operation | Plan outside operation | Execution round trip | Execution operation | Execution outside operation | Kernel |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1.1302 | 0.0386 | 1.0916 | 1.0558 | 0.0551 | 1.0007 | 0.0539 |
| 2 | 1.0553 | 0.0309 | 1.0244 | 1.0923 | 0.0572 | 1.0351 | 0.0561 |
| 3 | 1.0617 | 0.0329 | 1.0288 | 0.9243 | 0.0233 | 0.9010 | 0.0223 |

Each call starts a new process. Repeats reuse filesystem caches; none is labeled
a guaranteed cold-cache run. The benchmark imports its own entry module on
spawn, which is not the production application entry module. It omits HTTP,
catalog authorization, AOI resolution, DB admission/publication, queue wait and
browser polling. Therefore these results establish a local process cost, not
the breakdown of the production 5.524 s observation. No production data or
credentials are accessed. Temporary fixture children are confined to the
explicit scratch root and removed afterward.

## Original measurement plan

- Measure production planning round trip, submission round trip and first ready
  response with browser monotonic time. Keep confirmation pauses separate.
- Measure worker preparation and bounded-call elapsed with server monotonic
  time. Compare with kernel time; do not subtract browser/server clock readings.
- Record queue admission-to-claim and ready publication with one server clock;
  `updated_at` alone is insufficient because heartbeats overwrite it.
- Compare repeated small selections and replacement clicks, including time to
  acknowledge cancellation. Verify polling delays rather than labeling all
  residual time as UI overhead.

Potential changes include quicker bounded active-job polling, a worker wakeup
mechanism, or reducing process bootstrap work. Select based on production
measurements and account for DB/request load. Do not remove process isolation,
reuse unchecked plans, weaken cancellation acknowledgment or increase native
concurrency merely to reduce latency.

## Initial benchmark architecture and validation

The initial investigation added only diagnostic tooling and this report. Used by: developers
investigating Processing. Depends on: existing Processing models/dispatch and
the neutral bounded-process supervisor. Coordinates with: no application peers.
That benchmark introduced no runtime imports, contracts or subsystem dependency changes.

Validation: the benchmark command above completed all three real plan/execution
pairs with correct results. Formatting is checked with
`python -m black --check --target-version py312 tests/benchmark_request_latency.py`;
`git diff --check` checks whitespace. No production optimization or deployment
is claimed by this investigation commit.
