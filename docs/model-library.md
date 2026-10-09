# Run a model

Open **Tools → Models** in the map's right-hand Analysis area. Search the
library by name or purpose, then choose **Set up model**. The installed
**Raster summary** model calculates one summary formula for a raster and area.

## Choose inputs

Choose one raster from **Map layers**. Hidden layers remain available. To use
another raster or vector, add it to Map layers first. Model setup has no separate
catalog search. Removing an input layer clears that choice for a new run;
accepted runs keep their original inputs. Duplicating a run whose original
layers are absent requires adding them to the map or choosing replacements.

Choose **Entire raster**, **Visible map area**, **Box around map location**, or
**Vector layer**. Visible map area follows the window on screen as you pan,
zoom or resize the map. Box around map location is the same sampling box used
by **Raster distributions**: click the map to move it, or change its size in the
Raster distributions controls. Setup follows those changes automatically; no
Update button or coordinate entry is needed. Blank margins outside the map's
single world are excluded.

Selected map polygons also follow the current polygon selection. **Run model**
fixes the displayed area and other inputs for that run. Later map changes do
not affect it. A duplicated run keeps its fixed **Area from original run**
until you choose another area mode.

Choose a **Vector layer**. While its features are being checked, **Loading
features…** explains why the filter is not yet available. Once ready, choose
**Edit filter** to set field/comparison/value
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
