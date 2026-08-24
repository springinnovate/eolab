# Catalog vector assessment

Catalog vector assessment determines whether one exact cataloged source layer
can be opened by the datastore readers deployed with EOLab. It does not publish
a GeoServer datastore, feature type, style, or WMS layer.

## Ownership and dependency direction

`eolab_app.catalog` owns discovery, stable Item/container identity, and the
closed `eolab:vector_source` metadata contract. Format handlers preserve native
layer identity for multi-layer containers instead of asking downstream code to
rediscover a layer by suffix or position.

`eolab_app.vector` owns mounted-source authorization, complete source
signatures, assessment policy, catalog replacement, and the port used to ask a
deployed reader about one exact layer. It depends on catalog contracts and the
shared mount but does not import raster, FastAPI, or browser modules.

`eolab_app.routes.vectors` owns HTTP translation for selected-Item assessment.
The application composition root constructs the catalog, source resolver,
GeoServer reader adapter, and service. `/scan-source` retains its existing
read-only behavior: its finalizer may inspect files and call the private reader
probe, but it does not mutate GeoServer.

The private GeoServer extension owns the GeoTools datastore call. It receives
an authenticated mounted file URI, explicit source format, and exact native
layer name, opens the matching deployed datastore factory, validates CRS and
geometry metadata, closes the datastore, and returns a bounded compatibility
document.

## Capability decisions

| Catalog source | Assessment result |
| --- | --- |
| Mounted Shapefile | Uses every required component in the source signature and probes the exact native layer. |
| Mounted GeoPackage | Preserves the container Item and selected inner layer, then probes only that layer. |
| Mounted GeoJSON | Recognized with `geojson_publication_unsupported`. |
| ZIP-contained Shapefile | Recognized with `zipped_shapefile_publication_unsupported`. |
| File Geodatabase | Preserves the exact feature-class identity and reports `file_geodatabase_publication_unsupported`. |
| Remote vector | Reports `remote_source_unsupported` without forwarding its URL or credentials. |

Every stored assessment includes a versioned policy, deployed-reader contract,
source identity, and complete mounted signature where applicable. Reassessment
reloads the authoritative Item, rebuilds current handler metadata, probes the
reader when supported, and replaces only that exact Collection/Item identity.

## Production reader contract

The GeoServer image build runs real Shapefile and multi-layer GeoPackage reader
tests. Image build and startup also require the GeoTools Shapefile and GeoPackage
runtime JARs. Deployment verification must still scan representative files from
the production read-only mount and confirm that the stored compatible result
names the expected geometry family and exact container layer.
