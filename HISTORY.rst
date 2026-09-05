History
*******

Unreleased
----------

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
