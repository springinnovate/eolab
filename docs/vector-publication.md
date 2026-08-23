# Catalog vector publication contract

EOLab visualizes catalog vectors through authenticated, convergent GeoServer publication and the existing restricted public WMS proxy. The browser sends only a STAC Collection and Item identity. It never receives source paths, credentials, or a source `FeatureCollection`, and every WMS request contains exactly one authorized layer.

## Capability matrix

| Source contract | Assessment | Publication | Browser rendering |
| --- | --- | --- | --- |
| Mounted Shapefile | GeoServer opens the exact `.shp` layer and EOLab signatures every recorded component | Read-only Shapefile datastore and one configured feature type | Bounded, single-layer WMS with `vector-point`, `vector-line`, or `vector-polygon` |
| Mounted GeoPackage layer | GeoServer opens the exact recorded native layer | Read-only, immutable GeoPackage datastore and one configured feature type | Bounded, single-layer WMS with a geometry-specific fixed style |
| Mounted GeoJSON | Recorded as `geojson_publication_unsupported` | Not attempted; the production image has no owned bounded adapter | Unavailable with the recorded capability reason |
| ZIP-contained Shapefile | Recorded as `zipped_shapefile_publication_unsupported` | Not attempted; no archive datastore or validated extraction adapter is installed | Unavailable with the recorded capability reason |
| File Geodatabase layer | Recorded as `file_geodatabase_publication_unsupported` | Not attempted; the production image has no OpenFileGDB datastore | Unavailable with the recorded capability reason |
| Remote vector Asset | Recorded as `remote_source_unsupported` | Never reinterpreted as a mounted path and no credential is forwarded | Out of scope until a separate remote-source publisher is implemented |

The production GeoServer image fails its build and startup checks unless its Shapefile and GeoPackage GeoTools datastore modules are present. The authenticated `vector-reader-assessments` endpoint provides the runtime proof: it opens the exact cataloged native type through the factories loaded in that deployed image, verifies CRS metadata, and classifies its schema as point, line, or polygon without changing GeoServer catalog state.

## Persisted source and assessment contracts

Scanner finalization adds `eolab:vector_source` to every mounted-vector Item. Its four fields are closed and explicit:

- `kind`: `mounted` or `remote`;
- `format`: `shapefile`, `geopackage`, `geojson`, `zipped-shapefile`, or `file-geodatabase`;
- `asset_key`: the format-owned primary Asset; and
- `layer_name`: the exact native type within the source container, when the format has one.

Legacy scanner Items are normalized only when their stable ID namespace, expected Asset key, media type, roles, and format-specific layer metadata agree. Multi-layer containers are never opened by “first layer” convention. A `file:` Asset must resolve below the configured scan mount; another URI scheme is remote even when its filename resembles a local format.

`eolab:vector_rendering` records policy `vector-v1`, eligibility, a stable reason code and message, the complete mounted-source signature, the deployed-reader contract, compatibility, and geometry family. Shapefile signatures cover all recorded components. Publication re-resolves the authoritative Item and requires the current signature and reader contract to match the assessment.

## Convergent GeoServer state

The STAC Item ID is the stable datastore, configured feature type, and WMS layer resource name inside workspace `eolab`. GeoPackage Items retain their exact native layer separately as the feature type's `nativeName`, so multiple layers in one container cannot collide or drift.

Publication inspects workspace, style, datastore, feature type, and layer resources through the same strict transport, status, sanitization, and categorized-error boundary used by raster publication. It handles these states:

| Existing state | Transition |
| --- | --- |
| No vector resources | Create datastore, create the exact feature type, verify the complete state and native identity, then assign the fixed style |
| Datastore only | Delete the proven orphan recursively, re-inspect, and perform one clean creation |
| Complete datastore, feature type, and layer | Verify the native identity and reapply the fixed style idempotently |
| Any other partial combination | Stop with a categorized configuration error; preserve ambiguous upstream resources for administrator inspection |

A failed clean creation performs bounded best-effort rollback of only the newly created datastore. Application restarts clear the process-local WMS authorization registry but not GeoServer state; selecting the Item again converges the complete publication and authorizes its current source for the new process.

## Browser and map lifecycle

The public WMS proxy accepts the three fixed vector style names in addition to `dynamic-raster`. It authorizes the layer against the current process, verifies that the requested style matches that layer, rejects raster `env` substitutions for vectors, and continues to enforce one layer and bounded image dimensions per request.

Vector WMS layers use catalog bounds for tile-layer bounds and initial fitting. They participate in the same retained-layer visibility limit, opacity, top-first ordering, activation, removal, tile-error ownership, and mixed raster/vector lifecycle as catalog rasters. Selecting a vector hides raster histogram, palette, pixel, and sample-window controls. Temporary AOI geometry remains in its independent high-z-index pane, so it can coexist with both WMS layer kinds.

## Adding another vector publisher

Supporting another format requires a focused adapter, not a relaxed resolver:

1. Prove that the production GeoServer image contains the required datastore and add it to the build/startup capability guard.
2. Extend the authenticated read-only assessment endpoint with exact container and layer parameters.
3. Add the format to the publication adapter with read-only connection parameters and documented recovery behavior.
4. Remove only that format's stable unsupported reason and add assessment, exact-layer, restart, partial-state, WMS, and container tests.

Remote Assets additionally require an explicit remote source contract, credential isolation, URL allowlisting, and a bounded publication design. Adding a remote catalog Asset alone must not activate mounted-file publication.
