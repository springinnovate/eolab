# Run a model

Open **Tools → Models** in the map's right-hand Analysis area. Search the
library by name or purpose, then choose **Set up model**. **Raster summary**
calculates one summary formula for a raster and area. **Raster clip** produces
a downloadable GeoTIFF of a raster within the chosen area.

## Choose inputs

Choose one raster from **Map layers**. Hidden layers remain available. To use
another raster or vector, add it to Map layers first. Model setup has no separate
catalog search. Removing an input layer clears that choice for a new run;
accepted runs keep their original inputs. Duplicating a run whose original
layers are absent requires adding them to the map or choosing replacements.

Choose **Visible map area**, **Sampling area**, or **Vector layer**. Raster
summary also supports **Entire raster** and selected map polygons. Raster clip
requires a box or catalog vector selection. Visible map area follows the window on screen as you pan,
zoom or resize the map. Sampling area is the same sampling box used
by **Raster distributions**: click the map to move it, or change its size in the
Raster distributions controls. Setup follows those changes automatically; no
Update button or coordinate entry is needed. Blank margins outside the map's
single world are excluded.

Selected map polygons also follow the current polygon selection. **Run model**
fixes the displayed area and other inputs for that run. Later map changes do
not affect it. A duplicated run keeps its fixed **Area from original run**
until you choose another area mode.

Choose a **Vector layer**, then **Edit filter** to set field/comparison/value
conditions inside model setup. The editor is available immediately, even while
**Checking selected features…** is displayed. **Apply filter** checks the
matching features and applies the same conditions to the map layer. Review the
highlighted selected-feature count and condition, then choose **Run model**.
Clearing the conditions includes all features. Closing the editor without
applying leaves the selection unchanged; cancelling a check preserves the last
successful selection.

Checking features reads and validates the original polygons on the server;
feature count alone does not describe the amount of geometry to process. The
map display is not used as the analysis source. If applying the display filter
fails, setup reports that separately and the checked model selection remains
usable. Later map filter edits do not change an already reviewed model selection
or an accepted run.

Raster clip has no formula to enter. It preserves the source resolution, grid,
coordinate system, datatype, scale, offset and units. The GeoTIFF contains the
source pixels covering the chosen area; pixels outside selected polygons are
masked. A pixel touching a selected polygon is included. Clipping does not
resample, reproject or change the stored values.

For Raster summary, `a` in the formula is the selected raster. Examples include `sum(a)`,
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
measured progress, saved inputs, results and downloads. Progress counts
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

Completed summaries offer **Download CSV**. Completed clips show the raster
dimensions, valid-pixel count and file size, with **Download GeoTIFF**. Both
offer **Download provenance**. Downloads require the session that owns the run.
A clip remains a temporary run result; it is not added to the catalog or map.
Map previews and permanent saved results are not yet available.
Under **Recipe & downloads**, **View Model YAML** shows the reusable recipe as
text; **Download Model YAML** saves it. An accepted run also offers **Download
Run YAML**, containing its captured recipe, inputs, effective parameters and
execution details. YAML import and permanent Save controls are not available.

The JSON API at `GET /api/processing/jobs/{jobId}/invocation` exposes the same
saved setup used by **Duplicate with changes**. It requires the owning browser
session and follows the same deletion and metadata-expiry rules as YAML export.
