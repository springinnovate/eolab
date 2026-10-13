# Run a model

Open **Tools → Models** in the map's right-hand Analysis area. Search the
library by name or purpose, then select a model's card to open setup. **Raster summary**
calculates one summary formula for a raster and area. **Raster clip** produces
a downloadable GeoTIFF of a raster within the chosen area. **Downstream ecosystem
beneficiaries** traces flow from a starting mask and summarizes values in the
downstream area.

## Set up downstream analysis

Select the **Downstream ecosystem beneficiaries** card. Its elevation raster,
watershed network and connection fields are configured in the model YAML.
You do not need to add those layers to the map or select a prepared dataset.
The model opens its configured sources when it runs; if a source is missing or
unreadable, the run reports that error. There is no separate hydrology
registration or source check to complete before running.

For **Starting mask**, choose a vector layer and edit its filter in the same
panel, or choose **Raster cells greater than zero** and a starting raster from
Map layers. Raster seeds include only positive, valid cells; the comparison is
fixed by this model. All selected features or starting cells form one combined
mask and one overall result. The watershed network limits the downstream search;
it does not add starting cells outside that mask.

Choose **Values to summarize** from Map layers or a completed run. Choose both
the starting mask and values explicitly; setup leaves these choices blank.
Hidden map inputs can be chosen too.

Set **Buffer radius (m)**, an optional **Maximum straight-line distance (m)**,
and **Summary formula**, which defaults to `sum(a)`. Leave the distance cutoff
blank for no cutoff. These are distances from reached cells and original
starting cells respectively; there is no attenuation or distance decay.
Choose **Run model** to capture the displayed inputs. Later clicks, layer
visibility changes and filter edits do not change an accepted run.

The same Runs view shows mask preparation, downstream routing, buffering and
summary progress, with cancellation and downloads. Coverage and the starting
mask use the ordinary **Show on map** actions under that run. **Duplicate with
changes** copies the starting mask, values and parameters when the same model
version remains installed. Its configured elevation and watershed sources come
from that model, without a separate dataset selection or registration check.

## Choose inputs

Choose one raster from **Map layers** or **Completed runs** in the Raster menu.
Completed runs lists this browser session's available raster results and retained
scientific raster intermediates. They can be used directly without **Show on map**.
Choose one explicitly; setup never guesses which previous result you intended.
**Refresh results** checks recent runs, and **Load older results** loads another
page when available. An expired or deleted selected result is marked unavailable
and must be replaced before running.

Hidden map layers remain available. To use
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

Every model uses the same naming convention. **Run name** starts with the model's
name and can be edited before running. The accepted run adds its creation time
in `YYYY_MM_DD_HH_MM_SS` format, for example
`Cuba biomass · 2026_10_12_14_35_22`. The time is fixed when the run is accepted,
using the browser's UTC offset then. Older runs and API submissions without an
offset use UTC.

Choose the **Rename run** pencil beside its name to change it, including while the
model is running. This updates its generated output names and future download
filenames. It does not change the creation time, calculation or files. Duplicating
a run creates a new timestamp when the new run is accepted.

Open **Runs** or **Tools → Model runs** to see this browser session's history.
Use **Load older runs** for earlier pages. Select a run's card to see its stage,
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

Once a new job is accepted, its input files remain available to that job while
it waits and runs, even if the original result expires. Deleting the original
run immediately removes access for new jobs and downloads. Already accepted jobs
continue; the server keeps the original files until those jobs finish or are
cancelled. Cancel dependent jobs explicitly if you also want to stop their work.
Retained files count toward the server's existing storage limit until cleanup.
If inputs being used by other jobs leave too little room, the new run reports a
storage-limit error. Retry after those jobs finish or choose a smaller area.

## Inspect or download

New model runs keep their completed files and run details for at least seven
days. The run shows the actual expiry date. Choose **Keep for another 7 days**
before expiry to keep them until seven days from that click; a later existing
expiry is preserved. Viewing the map or polling progress does not extend file
retention. This remains private to the same browser session: clearing cookies
or losing that session loses access. Download files if you need your own copy.

Choose **Delete run and results** in the run view, or beside its group name in
Map layers, to review a confirmation naming the run. Deleting removes all its
outputs from the map and makes them unavailable for new downloads or analyses.
The run disappears from the list immediately. An **Undo** notice remains for
30 seconds; **Dismiss** ends that offer sooner. Undo restores the run and the
output layers removed with it, including their display settings. Reloading this
tab can recover an unexpired Undo offer, but its previous map display settings
are no longer available; open the restored run to show its outputs again.
Undo does not extend the original expiry date or recover files that expired
during those 30 seconds.
The layer's ordinary remove control only removes it from the map and can be
undone. Cancel an active run before deleting it.
Existing downloads and accepted calculations finish using their protected inputs
before the server removes those files; other runs are not deleted automatically.

Completed summaries show their values. Completed clips show the raster dimensions,
valid-pixel count and file size. **Files from this run** lists individual downloads
for results, retained intermediates and **Calculation details**. Downloads require
the browser session that owns the run.

Output names include their run name and creation time, with no hash. For example,
`Downstream coverage · Cuba biomass · 2026_10_12_14_35_22` has a matching readable
download filename. Saved Run and Model YAML downloads also carry that run context.
The installed library's reusable Model YAML keeps its recipe name.

The Runs list, run heading and output cards show complete names, including
the timestamp. Long names and filenames wrap onto additional lines. Each output
has a separate **Download** action beneath its name and file details.

Choose **Show on map** beside a GeoTIFF or supported GeoJSON output to inspect it.
Nothing is added automatically. Its button changes to **On map**, and Map layers
groups the chosen outputs under their run names. Use the usual visibility,
opacity, Style, legend, zoom and remove controls. The layer's information action
reopens its run. Removing a layer leaves its file available to download or show
again; Undo checks the original file again before restoring its style and display.

The normal map-layer **Rename** action can give an output its own map label.
Renaming its run then preserves that custom label. **Use source name** restores
the generated output name. Removing a layer and undoing that removal also keeps
its custom label.

Raster outputs use the same **Style** controls as catalog rasters, including
continuous palettes, percentile ranges, manual categories, uploaded CSV tables
and legends. They also participate in pixel picking, **Distributions**,
**Statistics**, **Raster stack**, raster clips and model input selection.
These tools read the original GeoTIFF; changing colors or making a category
transparent does not change its numeric values or exclude it from calculations.

The map uses the same GeoServer tiles as catalog rasters, including detail as
you zoom, style changes and tile retry controls. Pixel picking reads the original
file directly through the ordinary raster reader. Download the GeoTIFF to keep
the full-resolution file. Small WGS84 GeoJSON outputs still
use solid point, line or polygon previews. Up to eight result layers can be on
the map at once, grouped by the run that produced each file.

Result layers remain private and temporary. Expiry removes their display;
deletion and loss of access are checked at least every 30 seconds, even with
Models closed. At expiry the browser checks for renewal before removing the
layer. If availability cannot be confirmed, the layer is removed and
can be reopened from its run. They are omitted from saved maps, published maps
and remembered browser views. Reopen them from **Models → Runs** in the browser
that owns them. Removing or hiding a layer does not stop an accepted calculation
or prevent selecting its original file under **Completed runs**. Permanent saving
and cross-user sharing are not yet available.

Under **Recipe & downloads**, **View Model YAML** shows the reusable recipe as
text; **Download Model YAML** saves it. An accepted run also offers **Download
Run YAML**, containing its captured recipe, inputs, effective parameters and
execution details. YAML import and permanent Save controls are not available.

The JSON API at `GET /api/processing/jobs/{jobId}/invocation` exposes the same
saved setup used by **Duplicate with changes**. It requires the owning browser
session and follows the same deletion and metadata-expiry rules as YAML export.

To define another model using an existing operation, see [Add a model recipe](model-authoring.md).
