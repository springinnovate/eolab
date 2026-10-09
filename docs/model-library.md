# Run a model

Open **Tools → Models** in the map's right-hand Analysis area. Search the
library by name or purpose, then choose **Set up model**. The installed
**Raster summary** model calculates one summary formula for a raster and area.

## Choose inputs

Setup explains any suggested raster. If several inputs could fit, choose one.
Hidden map layers remain available, and **Search catalog** finds sources that
have not been added to the map. Use **More matches** to retrieve later search
pages. A source does not need a rendered map layer to be analyzed.

Choose **Entire raster**, **Visible map area**, or **Vector layer**. Visible
map area uses the geographic window currently shown on screen; no map click is
required. A sampling box or drawn polygon area already selected on the map is
named **Map sampling box** or **Polygons selected on map**. These are distinct
from the visible window. Duplicating a run with a fixed area labels it **Area
from original run**. No coordinate entry is needed.

Panning or zooming does not change a draft automatically. Choose **Update from
map** to use the new visible window, or **Update sampling box** to use
the box around a new map click. Blank margins outside the map's single world are
excluded. The chosen area is shown before Run.

Choose a **Vector layer**, then **Edit filter** to set field/comparison/value
conditions using the existing filter editor. **Use filter** checks the matching
features and returns to model setup. Review the predicate and matching feature
count, then choose **Run model**. Clearing the conditions includes all features.
An initial suggestion can copy a layer's map filter; edits here belong only to
this model draft and do not change the layer's display filter. Closing the
filter editor without applying leaves the model's selection unchanged.

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
