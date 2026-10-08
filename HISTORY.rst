History
*******

Unreleased
----------

0.9.0 (2026-10-08)
------------------

* Style categorical rasters with exact integer codes, labels, colors and per-category opacity. Preview and import CSV category tables, edit them in place, and retain appearances through saved maps, style copy/paste and legends.
* Show categorical labels and codes in pixel picking and copied values, keeping Unmapped values distinct from source NoData. Display categorical distributions as colored bars with estimated percentages and ground area in hectares, excluding averaged overviews from category reads.
* Import CSV category tables for vector attributes with typed values, editable legend labels, colors and opacity. Keep unmatched and missing-value features visible and clickable when feature labels are enabled.
* Group identical categorical on-map legends into shared sections while retaining each layer's inclusion control and respecting appearance and opacity differences.
* Show distributions for up to the top 16 visible rasters, retain the top-two limit for 2D comparisons, and use all participating raster bounds when choosing the map sample.
* Add population standard deviation with ``stdev(a)`` and optional ``where`` conditions to raster calculations and stack plots, including exports and formula guidance.
* Unify Raster stack around one formula workflow. Combine exact clicked-cell ``pixelValue(a)`` with area statistics in the same per-raster job, preserving independent native grids and point-versus-area semantics.
* Prepare and execute raster calculations and clips in one queued job with one cancellation handle. Share identical queued or running work while keeping subscriber ownership and cancellation independent, and allow configurable concurrent native jobs within memory and disk budgets.
* Batch raster-stack submissions and owned job-status reads, reuse validated inputs and source preparation, and reduce repeated admission, database and native-worker startup work. Accept finished results while other jobs are still being submitted.
* Reorganize the right dock into Raster analysis with Distributions, Statistics and Raster stack, alongside Features at clicked point. Keep their context, progress and unavailable/new-result feedback separate, and make tool navigation consistent across expanded and minimized views.
* Put raster-stack plots first, harmonize the statistics editors, expose newly added plots, and retain editing focus during result updates. Keep detailed values, downloads, formulas and data-order settings available through consistent controls.
* Lead raster statistics with results and inline editing, calculate the default statistics across enabled rasters intersecting the sampling area, and preserve explicitly chosen raster bindings. Remove the separate calculation-history panel while retaining current-work status and previous-value context on cards.
* Use accepted custom polygons and filtered vector selections across all checked stack rasters even after choosing Whole raster. Follow newly enabled layers by default while preserving explicit stack checklist choices; invalidate obsolete area results and isolate late cancelled-job replies.
* Present raster clips on demand with a named source and captured area, direct layer/histogram download actions, progress, cancellation and temporary result downloads. Use enabled intersecting rasters for default Statistics and clip entry points.
* Compact map-layer rows and actions, make legends replace their disclosure controls, remember workspace-panel choices, and reveal newly added layers. Keep controls above the inspection dock on narrow screens, clarify empty-area guidance, preserve the scope of previous style distributions, and make vector feature labels opt-in for new layers.

0.8.0 (2026-09-24)
------------------

* Publish named maps at stable URLs with custom titles, subtitles, styles, layer names, basemaps, and a simplified recipient interface without the catalog.
* Edit and delete published maps through a password-protected administration page while preserving their URLs and contributors' polygons. Manage shared layers, retrieve join codes, and undo deletion there too.
* Replace facilitator-based annotation sessions with collaborative shared layers. Contributors see each other's polygons, choose their own colors, change their display names, and zoom to each contributor's polygons.
* Keep shared-layer membership separate from the layers loaded in a map, restore the root app's last layer selection, and raise shared-layer capacity without a per-browser membership limit.
* Edit polygon geometry, names, and notes together with explicit saving. Improve drawing controls, label readability and stacking, combined contributor/name/note labels, and immediate label visibility updates.
* Identify catalog vectors and shared polygons on hover, inspect clicked polygons, and make editing controls for the selected polygon easier to find.
* Rename and sort map layers, preserve list scroll position when toggling visibility, and show clearer color keys and an optional on-map legend with configurable layer inclusion.
* Add MapTiler satellite basemaps, viewport coordinate guides and a pointer crosshair, and keep map tools positioned around the available viewport.
* Queue map rendering, share identical in-flight WMS requests, report tile progress, recover failed current tiles, and debounce requests during navigation. Restore the saved viewport before requesting tiles.
* Keep WMS vectors, rasters, composite maps, and selected-feature highlights visible through the map's maximum zoom of 22.

0.6.0 (2026-09-20)
------------------

* Filter vector layers by their attributes and use filtered features as shared sampling areas for histograms, raster summaries, and clip downloads.
* Calculate raster formulas such as sum, mean, min, max, and area in hectares over map boxes, polygon areas, or whole rasters, with visible results and CSV downloads.
* Download raster clips through queued backend processing with progress, cancellation, and temporary result storage.
* Cache completed summary values, reuse projected polygons, and rasterize polygon masks once per calculation into temporary tiled rasters. Report request-to-result and detailed processing timings.
* Add a standalone Jobs service and queue calculation planning, histogram sampling, vector selections, and filter counts, with cancellation and automatic client retries when capacity is full.
* Reuse native worker processes and deliver calculation completion through server-sent events, retaining polling as a fallback.
* Plot pixel values and area statistics across raster stacks. Show multiple statistics with distinct styles, visibility controls, side-by-side plots, independent linear or logarithmic Y axes, and point details.
* Create local annotation layers with editable polygons, names and notes, vertex insertion, polygon dragging, and GeoJSON import/export. Use annotation polygons as summary areas.
* Share annotations within an EOLab site through session codes, with contributor layers, lead controls, combined downloads, and temporary session storage.
* Add basemap choices, including no basemap, and keep the basemap control visible beside open map tools. Add show-all/hide-all layer controls and undo for the last removed layer.
* Add histogram axis bounds and linear/logarithmic scales, and clarify the combined raster/feature results from each map click.
* Correct vector picking at broad zoom levels, preserve raster longitude coverage near the antimeridian, rely on backend pixel coverage, and recover observation after temporary scan-status failures.
* Remove obsolete calculator and outline pathways, consolidate processing ownership, and add reproducible application-build and database-lifecycle checks.

0.5.0 (2026-09-06)
------------------

* Keep the 2D histogram visible while styling, with focused range controls beneath the chart, improved hover feedback, and marginal projection guides.
* Use embedded raster overviews for paired histograms, hide stale analysis, and omit raster point entries outside the clicked coverage.
* Make map selections explicit, retain the anchored pixel picker during sampling, and zoom directly to a selected vector feature.
* Navigate feature-profile results and identify vector plot sources while preserving numeric spacing on cross-feature axes.
* Show histogram sampling controls and analysis context by default with clearer progressive-sampling disclosures.
* Retry failed composite tiles and cache successful composite renders by plan and tile coordinates.
* Apply valid vector style edits automatically after a short debounce, with serialized requests and no Apply button.
* Edit exact numeric break values for graduated vector styles while preserving adjacent, open-ended ranges.
* Show a color-mapped raster histogram beside visible percentile stretch controls, with direct navigation between Style and full analysis.
* Remove the COG storage-format filter from Catalog search.
* Sample broad raster histograms from suitable embedded COG overviews before falling back to bounded full-resolution reads.
* Restore blue–yellow–red raster defaults and add named vector labels, thin black outlines, and automatic numeric coloring.
* Show vector labels from zoom 0 with fixed anchors, wrapped text, overlap, and tile-edge margins; automatically color the latest annual or first non-ID numeric measurement.
* Adjust each 2D raster color range using percentiles from the paired histogram.
* Show raster and vector counts in the expanded and collapsed Map layers heading.
* Keep map-side tools reachable in a bounded, tabbed dock with retained state and independently scrollable content.

0.4.0 (2026-09-03)
------------------

* Isolate two-dimensional histogram rendering to the selected X/Y raster pair, reveal the pair atomically, and avoid refreshing map tiles when only the sample changes.
* Serve EPSG:3857 raster tiles through GeoWebCache with deterministic startup configuration.
* Keep oversized feature geometries out of GeoServer inspection responses while preserving the selected-feature outline.
* Let the Feature inspector collapse while a Series plot remains visible.
* Use opaque yellow-to-red defaults for raster fills and vector symbols, with transparent point and polygon outlines.
* Pick bounded, progressive raster-stack values from a pointer-following map panel.
* Refresh automatically derived raster styles in composite maps without requiring a manual style edit.
* Refresh the README quick tour with live tool screenshots and clearer task-focused guidance.

0.3.0 (2026-09-02)
------------------

* Remember the last valid map locally and reset it with one-step undo.
* Show exact raster values from the same retained map click as histograms and vector inspection.
* Show progressive, timed vector inspection results while slower layers continue loading.
* Open shared map links directly and dismiss successful loading automatically.
* Compose ordinary visible map layers into one authorized GeoServer WMS tile grid while preserving order, styles, and opacity.
* Plot a single vector feature across searchable numeric field families with reusable titles, ordering, and line or scatter presentation.
* Restore shared maps with bounded-concurrent layer preparation and one ordered map attachment.
* Keep the Feature inspector closed and skip off-extent vector requests when a map click finds no feature.
* Explore inspected vector observations as line or scatter series with source-layer navigation.
* Filter Catalog Items explicitly as rasters or vectors.
* Put direct style, zoom, details, clipboard, and removal actions on every map-layer row.
* Cancel abandoned map requests and bound GeoServer queue waits.
* Suggest valid Catalog search filters contextually while users type.
* Copy complete raster or vector styles and layer opacity onto compatible map layers.
* Reorder map layers with an accessible pointer, touch, or keyboard drag handle.
* Chart numeric attributes from bounded vector feature-inspection results with persistent axis and sort controls.
* Publish prepared raster files directly without raster preflight or approximate map previews.
* Show any number of map layers while limiting histogram analysis to the top two visible rasters.
* Explore visible raster histograms and vector features with one crosshair map interaction.
* Share styled map layers and the viewport through compressed links with current Catalog revalidation and compatibility warnings.

0.2.0 (2026-09-01)
------------------

* EOLab 0.2.0 provides a deployable Earth-observation workspace with mounted raster and vector catalog ingestion, indexed STAC search and Surprise me discovery, responsive map and server-status interfaces, GeoServer-backed layer visualization and styling, vector feature inspection and labels, raster sampling and pixel inspection, and interactive one- and two-dimensional histograms.
