# Request-to-result latency investigation (#364)

Keep the batching and timing changes merged in #363. This investigation starts
at `5dfcd785952076f6ac630427ceaefa2a25bc87d4`. The follow-up instrumentation
described below adds measurements without changing scheduling or native work.

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

## Current evidence

One WWF Connectivity observation on that revision, Human Footprint 2023 mean
over filtered Peru, showed **5.524 s total wait** and **1.090 s kernel elapsed**.
The 4.434 s difference cannot yet be assigned to one stage.

The actual request path contains these independently relevant stages:

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

## Next measurements before selecting an optimization

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
