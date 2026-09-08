# Raster calculator interface

The Raster calculator operates on one Catalog raster, bound to `a`.
Open it from Raster calculator in Map layers, a 1D histogram, or the map
toolbar, or Calculator · X/Y under a 2D histogram. X/Y entries select just that
axis's raster. The dock tab and panel both use Raster calculator.

Choose the current histogram box, a ready uploaded AOI, or explicitly Whole raster.
Enter up to five labeled formulas, or add an example. After 400 ms without typing,
formula validation uses the same backend grammar as planning; validation itself
does not open sources, reserve a native reader, or enqueue work. When the active
calculator has a valid source and area, it also automatically obtains a bounded
metadata estimate. The estimate shows native dimensions, blocks, decoded work,
CRS and stored-value semantics. Feedback progresses from **Checking formula…** to
**Checking calculation size…** and **Ready to calculate**, or a specific error.
There is no separate Review button. Checks alone never submit native calculations.

**Calculate** submits the current intent, transparently refreshing an expired
estimate. The button becomes **Recalculate** for unchanged completed settings.
**Calculation settings** collapses when a job is accepted, including after a map
click, leaving room for inline values, exact values and cell coverage. Subsequent
progress does not override the user's disclosure choice.
CSV/provenance downloads are optional. Ground hectares are available through
`areaha(condition)`; volume functions and multiple rasters remain separate work
under #335.

**Functions & examples** lists **sum, areaha, count, mean, min, and max** separately, with
their purpose and an example for each. Separate operator/combination examples
cover thresholds, classes, boolean conditions, and percentages. The example menu
also offers **Area above a threshold (ha)** and **Area in a class (ha)**; users can
edit the inserted formulas before calculating.

Area review and results show the WGS84 ellipsoid method, fractional boundary
inclusion, edge-refinement tolerance, and geometry work estimate. Direct area
results display `ha` beside both their formatted and exact values, and CSV adds
a unit column. Numeric aggregates still select pixel centers; area includes
intersected portions of matching cells, so their coverage cell counts can differ.
The help explains this distinction and links the result to its selected area.
See [ground-area methods and limits](ground-area-calculations.md) for the supported
CRS policy, approximation tolerance, and bounded geometry costs.

## Interactive sampling

While Raster calculator is the active, expanded panel, a completed map click
calculates the current valid formulas for the selected box after 650 ms. No
initial Run or opt-in checkbox is required. The hint says **Click the map to
calculate for a new sampling area.** Repeated clicks at the same location request
a new calculation too. A click while formula validation is pending waits for its
outcome; invalid formulas never submit a job. Hover, typing, resizing a box,
opening/reactivating the tool, or merely changing area context only update checks.
Uploaded AOIs and whole rasters always require Calculate, even when supplied as
the histogram's current area, and show a corresponding explicit-action hint.

Switching to another dock tab, minimizing or closing the calculator, changing
formulas, or leaving raster coverage invalidates queued automatic work and
cancels accepted map-triggered work. Returning to the panel enables future map
clicks without submitting anything on its own. Accepted manual Calculate jobs
continue in history when the panel is hidden. A Cancel action cancels the current
request; a later map click is a new explicit request while the panel stays active.

Only one calculation workflow from this editor is admitted at a time. A new box
aborts obsolete planning, retains only the latest requested area, and requests
cancellation of an accepted predecessor. Replacement admission waits for terminal
cancellation; `cancelling` still owns the server's worker capacity. The previous
result remains visible in grey cards, labeled with its original source/area and
marked previous until the new result arrives. A prominent **Calculating new
result…** banner and spinner appear immediately, including during debounce,
planning, and cancellation of superseded work. Rerunning unchanged settings also
mutes the saved values. Metadata checks alone, stopped requests, and errors awaiting
recovery do not claim a new result is being calculated. Late or superseded
completions cannot replace the saved result.
Native resource-limit or connection errors remain visible without automatic
retries. Calculate or a new map click can retry a refused request; uncertain
accepted submissions require Recover / retry using the same durable identity.
Work-limit errors retain the backend's requested amount, configured limit, and
reduction guidance in the panel. Native block admission reports a conservative
estimate; decoded work and the serialized AOI geometry report their byte counts.
The AOI limit concerns its processing geometry snapshot, not the uploaded file size.

The matching committed rectangle has moving dashes and a pulsing fill during
accepted calculation work. It does not animate for an older cancelled request or
a different rectangle. Reduced motion uses a static dashed outline and status
indicator; the working banner remains visible. Text status and measured native-block
progress are available independently of animation. The calculation panel remains
foreground during its map clicks while other inspection tools retain
their results.

## Recovery and bounded review state

`ProcessingJobs` owns one shared poller/history for clips and calculations. Both
editors share the same API client/session establishment. Downloads uses operation-
appropriate COG/CSV labels and links to inline calculation results. Histories
survive changing or removing map layers; the owner cookie authorizes the results.
Explicitly tracked active calculations remain polled even beyond the latest 50
history entries. An older list response cannot erase newly accepted job state.

The calculation session record persists the immutable intent and request key
before dispatch. It retains cancellation intent across uncertain submission
responses, retries the same key, and cancels recovered superseded work. Reload
recovers one-off jobs and cancels automatic jobs; it never silently submits a new
calculation. Storage failure before submission refuses the run. Connection failures
expose Recover / retry rather than creating another request identity.

Automatic estimates and execution share one controller planning lane. A click
can reuse an in-flight matching estimate, but admission still waits for debounce
and valid formulas. A stale estimate is discarded and cannot execute later.
The UI releases used or replaced estimates through idempotent
`DELETE /api/processing/plans/{plan_id}`. This is needed because five unreleased
reviews exhaust the per-owner plan quota. The route only discards completed owned
plans; it cannot release an active native-planning fence or another owner's plan.
Accepted job input/provenance and same-key submission recovery are independent of
the plan. Failure to release an accepted review is recoverable before more work is
submitted. An unconfirmed obsolete-review release is bounded by the existing plan
expiry. Clip review behavior and native job limits are unchanged.

## Architecture

Owner: Processing. Its controller, DOM view and session record depend on the
Processing API, shared job history/presentation, browser storage/timers, and the
neutral selected-area contract. Neither Processing frontend nor backend imports
histogram, map-layer, AOI, renderer, or GeoServer implementations.

Browser composition supplies Catalog identities and immutable selections, routes
analysis entry points, forwards ready AOI lifecycle references, and connects
calculation activity to the raster viewer's area-associated presentation method.
Raster controls and Map layers emit callbacks, with no Processing imports. The
sample-window controller owns matching/clearing its SVG activity class. The dock
owns tab visibility and keyboard navigation only. Its narrow
`subscribeActiveTool(listener)` presentation contract reports an expanded active
tool or null. Composition forwards that to `calculations.setActive`, and sends a
separate `calculateSelection()` intent through `exploreAt`'s successful-selection
callback. Rejected boxes retain histogram guidance without recalculating an old
box. Background
histogram/feature presentation can retain the active tab through an `activate`
option; it never transiently deactivates/cancels the calculator.

Issue #345 changes the Processing browser controller/view, map dock, browser
composition, raster viewer's committed-selection notification,
layer/histogram/2D entry-point labels, HTML/CSS, documentation and
tests. Existing composition-to-component edges carry the new presentation/click
signals; no sibling implementation dependency is added, removed or redirected.
No subsystem acquires knowledge of a peer. Public additions are limited to these
required browser presentation/intent methods; HTTP and backend contracts remain
unchanged. Remaining coupling is the existing Catalog source/selected-area and
job lifecycle contracts, plus the explicit active-panel signal.

Two backend public contracts support this UI: I/O-free `/raster-calculations/validate`
using `AggregateValidationRequest` (also consumed by planning), and explicit plan
release through the existing Processing service/storage port. Shared presentation
formatters and polling move out of Downloads so neither editor depends on its peer.
Clip pending submissions remain separate because their immutable export lifecycle
has no latest-click cancellation intent. There is no new service, queue, mount,
expression evaluator, resampling policy or cross-subsystem state manager.
