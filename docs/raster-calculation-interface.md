# Raster calculation interface

The Calculations tool operates on one Catalog raster, bound to `a`. Open it from
Calculate in Map layers, a 1D histogram, Calculate X/Y under a 2D histogram, or
Calculations on the map toolbar. X/Y entries select just that axis's raster.

Choose the current histogram box, a ready uploaded AOI, or explicitly Whole raster.
Enter up to five labeled expressions, or add an example. Debounced expression
validation uses the same backend grammar as planning; it does not open sources,
reserve a native reader, or enqueue work. Review shows native dimensions, blocks,
decoded work, CRS and stored-value semantics. Run submits the reviewed intent.
Settings collapse after Run to leave room for inline values, exact values and cell
coverage. Run again recalculates unchanged settings with a fresh native plan.
CSV/provenance downloads are optional. Area/volume functions and multiple
rasters remain separate work under #335.

## Interactive sampling

Select **Follow sampling box after Run**, review, and Run to start. Committed box
changes (including resize) then trigger a calculation after 650 ms without another
Run click. Hover, typing, and an unchecked follow option never submit work.
The raster binding and expressions stay fixed. AOI and whole-source calculations
are explicit one-off runs. Editing settings, unchecking follow, closing the tool,
leaving raster coverage, or reloading pauses follow mode.

Only one calculation workflow from this editor is admitted at a time. A new box
aborts obsolete planning, retains only the latest requested area, and requests
cancellation of an accepted predecessor. Replacement admission waits for terminal
cancellation; `cancelling` still owns the server's worker capacity. The previous
result remains visible, labeled with its original source/area and marked previous
until the new result arrives. Late or superseded completions cannot replace it.
Native resource-limit or connection errors pause follow and remain visible.

The matching committed rectangle pulses during accepted calculation work. It
does not pulse for an older cancelled request or a different rectangle. Reduced
motion uses a static dashed outline. Text status and measured native-block
progress are available independently of animation. The calculation panel remains
foreground during follow-mode map clicks while other inspection tools retain
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
recovers one-off jobs and cancels automatic jobs; it never silently restarts follow
mode. Storage failure before submission refuses the run. Connection failures
expose Recover / retry rather than creating another request identity.

The UI releases used or replaced reviews through idempotent
`DELETE /api/processing/plans/{plan_id}`. This is needed because five unreleased
reviews exhaust the per-owner plan quota. The route only discards completed owned
plans; it cannot release an active native-planning fence or another owner's plan.
Accepted job input/provenance and same-key submission recovery are independent of
the plan. Failure to release an accepted review is recoverable before more work is
submitted. An unconfirmed obsolete-review release is bounded by the existing plan
expiry. Clip review behavior and native job limits are unchanged.

## Architecture

Owner: Processing. Its new controller, DOM view and session record depend on the
Processing API, shared job history/presentation, browser storage/timers, and the
neutral selected-area contract. Neither Processing frontend nor backend imports
histogram, map-layer, AOI, renderer, or GeoServer implementations.

Browser composition supplies Catalog identities and immutable selections, routes
Calculate entry points, forwards ready AOI lifecycle references, and connects
calculation activity to the raster viewer's area-associated presentation method.
Raster controls and Map layers emit callbacks, with no Processing imports. The
sample-window controller owns matching/clearing its SVG activity class. The dock
owns tab visibility and keyboard navigation only.

Two backend public contracts support this UI: I/O-free `/raster-calculations/validate`
using `AggregateValidationRequest` (also consumed by planning), and explicit plan
release through the existing Processing service/storage port. Shared presentation
formatters and polling move out of Downloads so neither editor depends on its peer.
Clip pending submissions remain separate because their immutable export lifecycle
has no latest-click cancellation intent. There is no new service, queue, mount,
expression evaluator, resampling policy or cross-subsystem state manager.
