# Portable saved map views

EOLab saved map views are bounded JSON documents that reproduce a map's
retained Catalog layers, top-first order, visibility, opacity, validated
per-layer appearance, and WGS 84 viewport. They also record the creating
viewer version and origin as provenance for potentially stale or
cross-deployment restoration.

The browser gzip-compresses the canonical document, encodes it as unpadded
Base64URL, and places it in a `#view=` URL fragment. The fragment is retained by
the browser rather than sent in an HTTP request. Opening a valid shared link
immediately clears the existing composition, resolves every layer by its
standard STAC Collection and Item identity, repeats the current preparation and
publication flow, and delegates style validation to the layer's raster or
vector adapter. Successful restoration dismisses its loading state
automatically; warnings and partial restoration keep an actionable exception
report open.

## Trust boundary

Saved maps are references and presentation intent, not rendering authority.
They never contain or accept source paths, Asset URLs, GeoServer layer names,
WMS URLs, SLD documents, credentials, or source data. An opaque SHA-256 digest
allows the browser to notice that scanner-owned source metadata changed
without exporting that metadata. The current Catalog Item and publication
flow remain authoritative on every open.

The fragment transport accepts at most 128 KiB of encoded content and stops
decompression after 512 KiB. The document parser accepts only schema version 1,
at most 512 KiB, at most 50 unique Catalog identities, a canonical single-world
viewport, and bounded scalar fields. A different viewer version or origin is
provenance rather than rendering authority; an incompatible schema is rejected.

The first schema deliberately excludes Catalog search state, selected Item,
feature inspection, pixel probes, histogram and 2D-analysis state, sampling
windows, temporary AOIs, server status, and pending work. Fragment sharing is a
transport for this same canonical document, not a second map-state format.

## Browser ownership

`saved-map-view/model.js` owns the portable schema and untrusted-content bounds.
`saved-map-view/fragment-codec.js` owns bounded gzip and Base64URL transport.
`SavedMapViewController` owns the copy/open workflow but no dataset behavior.
It consumes the neutral viewport and retained-layer boundaries plus
`CatalogVisualizationCoordinator`; raster and vector adapters alone export and
apply their validated appearance. `SavedMapViewCatalogClient` performs exact
standard STAC Item retrieval independently of interactive search cancellation.

The composition root is the only place these collaborators are assembled.
The saved-map package does not import raster or vector implementations, and the
map-layer package continues to depend only on its peers and Catalog identity.
