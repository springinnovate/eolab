# Run a model

Open **Tools → Models** in the map's right-hand Analysis area. Search the
library by name or purpose, then choose **Set up model**. The installed
**Raster summary** model calculates one summary formula for a raster and area.

## Choose inputs

Setup explains any suggested raster. If several inputs could fit, choose one.
Hidden map layers remain available, and **Search catalog** finds sources that
have not been added to the map. Use **More matches** to retrieve later search
pages. A source does not need a rendered map layer to be analyzed.

Choose the whole raster, **Use visible map extent**, **Copy selected analysis
area**, enter a bounding box, or select catalog vector features. Visible map
extent copies the geographic rectangle currently shown on screen; no map click
is required. Selected analysis area copies an existing sampling box around a
map click or selected polygons. It is unavailable until an area is selected.
The captured bounds are shown before Run. Panning or zooming does not change a
draft automatically; choose **Update from map** to copy the new extent or
selection. Blank margins outside the map's single world are excluded.

Vector choices copy the layer's applied
filter when the draft is created; catalog-only vectors initially select all
features. Setup shows the predicate and matching feature count before Run.
To use a different map filter, apply it to the layer and create a fresh setup.
Later map edits do not change an existing draft's selected inputs.

In the summary formula, `a` is the selected raster. Examples include `sum(a)`,
`mean(a)`, `stdev(a)`, `count(a)`, `areaha(a > 10)` and
`sum(a, where=a > 10)`. Point-only `pixelValue(a)` has no point input in this
model and is rejected. Formulas are checked by the server when submitted.

**Run model** captures the input choices and parameters. A failed or lost HTTP
response may leave the outcome uncertain; **Recover submission** reuses the
original request ID and inputs to recover the same job. Keep session storage
enabled so this retry is also available after reloading the tab.

## Follow a run

Open **Runs** or **Tools → Model runs** to see this browser session's history.
Use **Load older runs** for earlier pages. Select a run to see its stage,
measured progress, saved inputs, summary values and downloads. Progress counts
apply to the current stage; they are not an estimated percentage for the entire
model.

Closing Models, switching tools or maps, and reloading the page leave accepted
work running. **Cancel run** explicitly requests cancellation. Queued, running,
cancelling, ready, failed, cancelled, interrupted and expired states are shown
separately. Failed or interrupted runs can be copied to a new setup using
**Duplicate with changes**. Duplication does not execute anything or modify the
original run. Its exact model version must still be installed.

Results are temporary and private to the browser's Processing session. The run
shows separate expiry dates for result files and saved setup metadata. Clearing
that session's cookies loses access; these are not permanent account records.

## Inspect or download

Completed summaries offer **Download CSV** and **Download provenance**.
Under **Recipe & downloads**, **View Model YAML** shows the reusable recipe as
text; **Download Model YAML** saves it. An accepted run also offers **Download
Run YAML**, containing its captured recipe, inputs, effective parameters and
execution details. YAML import and permanent Save controls are not available.

The JSON API at `GET /api/processing/jobs/{jobId}/invocation` exposes the same
saved setup used by **Duplicate with changes**. It requires the owning browser
session and follows the same deletion and metadata-expiry rules as YAML export.
