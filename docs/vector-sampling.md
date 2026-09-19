# Sampling with a filtered vector layer

In **Summarize → Area → Vector layer**, choose a mounted Shapefile or GeoPackage
polygon layer. Use **Edit filter → Use filtered features & calculate** to select
the matching features and run configured valid statistics. For example, select
a countries layer and filter `iso3` to equal `PER` to summarize Peru.

Closing or cancelling a filter draft does not submit it. **Cancel** remains
available during selection and calculation. **Use these features** is another
way to accept a selection: in Summarize it runs configured statistics; in the
histogram area controls it changes only the sampling area.

The analysis filter is independent of the map display filter. All matching source
features contribute regardless of viewport or visibility. No matches produces an
error, not an unfiltered fallback. See [filter rules](vector-filters.md).

## Annotation layers

Local annotation layers, imported GeoJSON annotations and shared contributions
also appear in **Summarize → Area → Vector layer**. Filter by `name` or `note`,
then choose **Use filtered features & calculate**. The same field comparisons
are available from the layer's **Filter** control. Shared contributions remain
read-only; your filter changes only your own map and calculation.

Without a filter, all committed polygons are included. An empty layer or filter
with no matches produces a message and does not calculate the whole raster.
Overlaps count once, and the numeric and ground-area rules below still apply.
Annotation areas currently support summary statistics; histogram and clip
area controls continue to use catalog vectors or uploaded AOIs.

Saving a polygon edit, changing the applied filter, or receiving an updated
shared contribution invalidates an active summary. With automatic updates on,
the open summary runs again, subject to the existing large-area review policy.
Unfinished drawing edits, visibility, labels and styles do not change the area.
Names and notes affect a result only when they change which polygons match.
Removing a layer or losing its shared session cancels its pending summary.
Older saved text searches retain case-insensitive matching until replaced with
field conditions; new field comparisons follow the regular vector rules.

For calculations, the browser uploads only matching polygon geometry to this
EOLab site's Processing service. The private input expires after one day and is
released when the area is replaced or removed. Accepted jobs keep their own
copy so their completion does not depend on an open browser tab. This does not
publish annotations in the catalog, send them to GeoServer, or share them with
another EOLab site. Cached numbers use the exact geometry and formula; labels,
notes and polygon geometry are not stored in the shared result cache.

Uploads accept at most 500 polygons, 2,000 vertices per polygon, 100,000 closed-ring
coordinates in total and 8 MiB of JSON. Temporary input storage allows 32 uploads
per browser session, 128 per deployment and 64 MiB in total. These input limits
are separate from the existing limits on raster work and result storage.

## Which geometry is used

Analysis reads the original source polygons. The map displays a simplified
outline that may omit small components or holes to fit its 256 KiB / 10,000-position
display budget. An unavailable or hidden outline does not prevent analysis.
Zoom-to uses the measured selection bounds.

Overlapping polygons count once; holes are excluded unless covered by another
selected polygon. Inclusion depends on the requested analysis:

| Analysis | Selection rule |
| --- | --- |
| 1D and 2D histograms | All-touched mask on the exact or sampled histogram grid |
| Numeric raster calculations | Native cells whose centers fall in the selection |
| `areaha(condition)` | Fractional ground area of each matching native cell inside the selection |
| Raster clips | All-touched mask on the native raster grid |

A narrow polygon may intersect pixels without containing their centers. Thus its
area may be positive even when a numeric calculation has no selected cells.

## Large areas and source changes

Direct **Use these features** asks for review on an unfiltered multi-feature
selection or an envelope over 5 million km², and again above 100 million km².
Those checks concern the bounding envelope, not measured polygon area.
Summarize's explicit filter-and-calculate action skips those confirmations;
server work limits still apply.

Selection validation has a 15-second deadline, a one-million-candidate-feature
limit and a 500,000-coordinate limit per retained feature. Raster reads,
transformations, output size and execution have their own limits. Complex
boundaries can reach a limit even when the geographic area is small. Reduce the
selection or repair invalid source geometry when the error requests it; EOLab
does not silently replace exact analysis polygons with their bounding boxes.

Raster and vector sources must remain unchanged until accepted work finishes.
Rescan changed sources and select them again. Completed results remain available
under their normal expiry policy. Sampling selections are not saved in shared
map links; the same browser session can recover accepted jobs after reload.

For missing outline errors, operators should check the [Job service](job-service.md).
