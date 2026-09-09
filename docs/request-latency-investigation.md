# Request-to-result latency investigation (#364)

Keep the batching and timing changes from #363. This investigation starts at
`5dfcd785952076f6ac630427ceaefa2a25bc87d4`; it does not change runtime behavior.

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

## Architecture and validation

Only diagnostic test tooling and this report are added. Used by: developers
investigating Processing. Depends on: existing Processing models/dispatch and
the neutral bounded-process supervisor. Coordinates with: no application peers.
No runtime imports, contracts or subsystem dependency relationships change.

Validation: the benchmark command above completed all three real plan/execution
pairs with correct results. Formatting is checked with
`python -m black --check --target-version py312 tests/benchmark_request_latency.py`;
`git diff --check` checks whitespace. No production optimization or deployment
is claimed by this investigation commit.
