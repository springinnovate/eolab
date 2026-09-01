# Portable saved map views

EOLab saved map views are bounded local JSON documents that reproduce a map's
retained Catalog layers, top-first order, visibility, opacity, validated
per-layer appearance, and WGS 84 viewport. They also record the creating
viewer version and origin so another deployment can warn before it attempts a
potentially stale or cross-deployment restoration.

The browser can download a `.eolab-map.json` file and open one through the
file picker or by dropping it on the map. Opening first presents a replacement
summary. Approval clears the existing composition, resolves every layer by its
standard STAC Collection and Item identity, repeats the current preparation and
publication flow, and delegates style validation to the layer's raster or
vector adapter. The result dialog reports every loaded, missing, changed, or
style-incompatible layer separately.

## Trust boundary

Saved maps are references and presentation intent, not rendering authority.
They never contain or accept source paths, Asset URLs, GeoServer layer names,
WMS URLs, SLD documents, credentials, or source data. An opaque SHA-256 digest
allows the browser to notice that scanner-owned source metadata changed
without exporting that metadata. The current Catalog Item and publication
flow remain authoritative on every open.

The file parser accepts only schema version 1, at most 512 KiB, at most 50
unique Catalog identities, a canonical single-world viewport, and bounded
scalar fields. A different viewer version or origin is a warning rather than
rendering authority; an incompatible schema is rejected.

The first schema deliberately excludes Catalog search state, selected Item,
feature inspection, pixel probes, histogram and 2D-analysis state, sampling
windows, temporary AOIs, server status, and pending work. URL-fragment sharing can be added later as a transport for the same
canonical document rather than creating a second map-state format.

## Browser ownership

`saved-map-view/model.js` owns the portable schema and untrusted-file bounds.
`SavedMapViewController` owns the save/open workflow but no dataset behavior.
It consumes the neutral viewport and retained-layer boundaries plus
`CatalogVisualizationCoordinator`; raster and vector adapters alone export and
apply their validated appearance. `SavedMapViewCatalogClient` performs exact
standard STAC Item retrieval independently of interactive search cancellation.

The composition root is the only place these collaborators are assembled.
The saved-map package does not import raster or vector implementations, and the
map-layer package continues to depend only on its peers and Catalog identity.
