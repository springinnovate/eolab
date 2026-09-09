# Summary statistic interface

The **Summarize** workspace contains up to five editable summary statistic cards.
Each card keeps its name, Catalog raster (`a`), formula, validation/progress, and
value together. **Explore** and **Summarize** share the committed sampling area.
Opening the workspace, returning to a tab, expanding the dock, renaming a statistic,
or opening value details does not submit a calculation.

The area is shown once above the cards. **Change** opens the existing Explore area
controls. The scope menu supports the current map selection, a ready uploaded AOI,
or Whole raster. Each statistic can choose its own raster, but each expression
still operates on one raster bound to `a`; cross-raster expressions are separate
work under #335. New cards inherit the preceding card's raster.

**Add statistic** offers editable Mean, Sum, Count, Area, Percent, Range, and Custom
presets. Custom cards can be named freely; an empty name uses `Summary statistic N`
for submission. The compact accessible **×** removes a card, with one-step Undo.
Removing an earlier card does not move another statistic's result or typing focus
to a different formula. There is no separate settings/result mode or automatic
collapse while a user edits.

## Updates and feedback

**Update statistics automatically** is enabled by default and lives in the dock's
**More** menu. Formula, raster, and area changes wait for a 700 ms pause before
validating against the backend grammar. Validation is I/O-free and opens no raster.
Each card validates separately, so an incomplete or invalid formula cannot prevent
a valid peer from running. No expression is evaluated in browser JavaScript.

Valid changed statistics request a native size plan and then update automatically
when the area is a selected map box and the plan is within all these conservative
browser thresholds:

- At most 128 native blocks.
- At most 64 MiB of decoded source values/masks.
- At most 25,000 estimated geometry cells for ground-area calculations.

These thresholds do not change backend resource limits. Larger plans, uploaded
AOIs, and whole rasters stop at **Ready to calculate** and show the native work
estimate beside a **Calculate** action. The same action updates a changed card in
manual mode. There is no Recalculate button for an unchanged completed statistic.
Turning automatic updates on affects future edits/clicks; it does not immediately
run every existing card.

Map clicks update the shared committed area while Summarize is active. Rapid edits
and clicks coalesce. Unchanged completed expressions can reuse their current value;
changing a name never causes a native scan. Each card shows checking, queued,
calculating, failure, or completion feedback beside its own formula. Its previous
value remains visible and heavily grayed out until a matching
result arrives. Missing-data and undefined-arithmetic results include explanations.

Cards on the same raster and area with distinct names can be combined into one
native scan. Other source groups wait on the existing single calculation workflow.
Duplicate user-facing names are allowed and run as separate groups because the
backend requires unique labels within a submission. Status per card does not imply
an independent simultaneous server job.

Switching tabs, minimizing, or closing pauses queued automatic work and cancels its
accepted job. Returning does not restart it. Accepted manual jobs can continue in
history while the workspace is hidden. Editing a member of an active batch cancels
the obsolete batch; unchanged siblings still awaiting values are retained for the
replacement. Cancelled work holds its slot until the server reaches a terminal
state. Late validation, stale plans, cancelled completions, and responses for removed
cards cannot overwrite the current formula's value.

## Results, exports, and history

**Value details & downloads** is collapsed within each card. It contains the exact
value, immutable source/area/formula context, cell coverage, ground-area method when
applicable, and owned CSV/provenance links. Integer strings are formatted without
losing precision. `areaha(condition)` produces ground hectares, including partial
pixels; numeric functions use pixel centers. Units and arithmetic/null states come
from the typed server result.

Exports preserve the submitted names and formulas even if a card is renamed later.
A combined scan's CSV contains the statistics submitted in that scan. Earlier
results, job cancellation/deletion, and raster clips stay under **More → History &
exports**. Inspecting history opens a clearly labeled Saved calculation disclosure;
it does not rewrite or relabel the editable cards.

**Formula reference** remains collapsed. It documents sum, areaha, count, mean, min,
max, optional `where` conditions, comparisons, Boolean combinations, percentages,
NoData, native-pixel semantics, and the distinction between fractional area and
cell-center aggregates. See [ground-area methods and limits](ground-area-calculations.md).

## Experimental performance tuning

**Performance tuning (experimental)** is collapsed below Formula reference in
Summarize. **Target pixels per batch** is shared by the cards; it changes execution
size, never raster resolution. Current behavior is the default. Available targets
are 65,536, 262,144, 1,048,576 and 4,194,304 total pixels; native block dimensions may
require a larger read with smaller evaluation tiles.

Changing the target clears obsolete reviews, marks prior values stale, cancels
obsolete active work through the existing workflow, and waits for **Calculate**.
It does not launch a benchmark just by changing the dropdown. Subsequent map clicks
and formula changes retain the setting and normal automatic-admission limits.
Accepted jobs keep immutable settings in their intent, result and history. Reload
recovers an active job's original target without submitting again.

After planning, the tuning disclosure shows requested/effective sizes, native
blocks, combined reads and conservative working-memory estimates for each planned
statistic. A memory refusal explains the 512 MiB ceiling and suggests a smaller
batch. **Value details & downloads → Performance** and saved results show final
read, calculation, result-writing and kernel timings with their measurement
boundaries. Missing metrics on older saved results are explicitly identified.
The details distinguish wall times from queue/startup/browser latency. No new
poller or processing service is introduced.

## Recovery and architecture

Processing owns the card coordinator, DOM view, and existing durable calculation
executor. Browser composition still supplies Catalog identities, neutral selected
areas, active-tool changes, explicit map-click intents, and area-associated activity.
Neither the Processing browser code nor backend imports a map/histogram sibling.
HTTP contracts, expressions, backend limits, storage schema, and shared polling are
unchanged by #354.

`SummaryStatisticsController` holds stable card identities and debounced validation.
Its one `CalculationsController` executor admits batches through the original
planning, release, idempotent submission, cancellation, and recovery lane. It never
creates a controller/job poller per card. The executor's `executeIntent` boundary
accepts validated immutable public intents, and an optional automatic-admission
policy pauses expensive plans before submission. Original single-workflow tests
remain alongside card interaction and asynchronous regression tests.

`ProcessingJobs` owns one poller/history shared with raster downloads. Tracked active
jobs remain polled beyond the latest history page. Per-tab storage persists the
immutable intent/request key before submission, including cancellation intent and
unreleased used-plan identities. Uncertain submissions expose **Recover / retry**
and reuse the original key. Reload recovers manual jobs and cancels recovered
automatic work without submitting a new calculation. Storage failure refuses work.

Metadata requests stay connected until bounded native cleanup completes. Superseded
plans are released before the next batch, preventing planner races and exhaustion of
the five-plan owner quota. Used plans are released after acceptance. Errors do not
silently loop: uncertain accepted work needs recovery, and failed unused-plan release
requires an explicit Calculate attempt before further admission. Page disappearance
still relies on server disconnect handling and bounded expiry.
