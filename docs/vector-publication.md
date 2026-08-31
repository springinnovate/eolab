# Catalog vector visualization

EOLab visualizes catalog vectors through read-only assessment followed by
authenticated, convergent GeoServer publication and the restricted public WMS
proxy. The browser sends only STAC Collection and Item identity. It never
receives a source path, credentials, or a source `FeatureCollection`, and each
WMS request is bounded to one authorized layer and the existing image-size
limits.

## Capability matrix

| Source contract | Assessment and result |
| --- | --- |
| Mounted Shapefile | GeoServer opens the exact `.shp` type. EOLab signs every recorded component, publishes one read-only datastore/type, and renders fixed point, line, or polygon WMS styling. |
| Mounted GeoPackage layer | GeoServer opens the exact recorded native layer. One container can therefore produce several independently identified and published Items. |
| Mounted GeoJSON | `geojson_publication_unsupported`: the production image has no owned bounded mounted-GeoJSON publication adapter. |
| ZIP-contained Shapefile | `zipped_shapefile_publication_unsupported`: no validated archive datastore or extraction publication adapter is installed. |
| File Geodatabase layer | `file_geodatabase_publication_unsupported`: the production image does not own an OpenFileGDB publication adapter. The exact container/layer identity remains cataloged. |
| Remote vector Asset | `remote_source_unsupported`: remote credentials are never forwarded and a remote URL is never reinterpreted as a mounted path. |

Unsupported Items remain searchable and inspectable with their precise stored
reason. Adding support for another format requires a focused datastore adapter,
an image capability check, and exact source/layer tests; it does not relax the
source resolver.

## Architecture and code map

The vector feature owns assessment, exact source resolution, signatures,
publication policy, and stable vector responses under
`src/eolab_app/vector/`. It is used by the thin routes in
`src/eolab_app/routes/vectors.py` and by application composition in
`src/eolab_app/main.py`.

The feature depends on these lower-level contracts:

- catalog handlers emit the closed `eolab:vector_source` metadata contract;
- `DatasetHandlerRegistry` rebuilds a selected Item without suffix dispatch in
  the service;
- the catalog adapter reloads and replaces authoritative Items;
- `src/eolab_app/rendering/` supplies only the GeoServer REST transport,
  failure categories, and published-layer authorization protocol genuinely
  shared with raster publication; and
- the deployed GeoServer reader-assessment endpoint proves the exact native
  type, CRS, and geometry family without modifying the GeoServer catalog.

Vector and raster publication coordinate only through the neutral WMS
authorization protocol. Neither feature imports the other. The public WMS
proxy asks each feature-owned registry for the requested layer and validates
the authorized fixed style. Raster analysis, pixel reads, statistics, detail
preview, and temporary AOI lifecycles do not depend on vector assessment or
publication.

In the browser, `catalog-visualization.js` is the composition-level dispatcher.
The vector API module owns HTTP, `vector/leaflet.js` owns Leaflet WMS creation,
and `vector/map-layer-adapter.js` implements the neutral retained-layer
contract. `map-layers/` owns only identity, visibility, ordering, opacity,
removal, and presentation-ready legends. It imports neither raster nor vector.
The raster viewer continues to own raster analysis/control sessions while
accepting sibling layers only through that neutral adapter contract.

## Persisted identity and assessment

Every vector handler emits `eolab:vector_source` with exactly:

- `kind`: `mounted` or `remote`;
- `format`: the stable handler name;
- `asset_key`: the handler-owned source Asset; and
- `layer_name`: the exact native type, including a container layer when one
  exists.

GeoPackage and FileGDB Items never select a container's “first layer.” Legacy
Items can be normalized only when their stable ID namespace, Asset media type,
roles, and format-specific layer metadata agree. A `file:` Asset must resolve
below the configured scan mount.

`eolab:vector_rendering` records policy `vector-v1`, eligibility, a stable
reason code/message, complete source signature, deployed reader contract,
compatibility, and geometry family. Shapefile signatures cover all component
files. Publication reloads the authoritative Item and requires the current
signature and reader contract to match the assessment.

## Stable and convergent GeoServer state

The stable STAC Item ID is also the datastore, configured feature type, and WMS
resource name in workspace `eolab`. For a GeoPackage, `nativeName` separately
retains the exact layer inside the container.

Publication handles only proven states:

- no vector resources: create datastore and exact feature type, verify native
  identity, then assign the geometry-specific style;
- datastore only: delete that proven orphan, re-inspect, and create cleanly;
- complete datastore/type/layer: verify native identity and reapply style
  idempotently; and
- any ambiguous partial state: stop with a categorized configuration error and
  preserve it for administrator inspection.

A failed clean create performs bounded best-effort rollback of only the newly
created datastore. Application restart clears process-local WMS authorization,
not GeoServer state; selecting the Item again converges and reauthorizes it.

## Browser lifecycle and bounds

Vector layers use fixed `vector-point`, `vector-line`, or `vector-polygon`
styles and never accept raster `env` substitutions. They share the neutral
retained-layer visibility limit, opacity, top-first ordering, activation,
removal, and tile-error ownership with raster WMS layers. Fit-to-bounds is an
adapter option and defaults on when a vector is added. Selecting a vector hides
raster-only palette, histogram, pixel, and sample-window controls.

### Feature inspection

When at least one published vector is visible, the browser offers an explicit
feature-inspection mode. One map click issues an independent WMS 1.1.1
`GetFeatureInfo` request for each visible vector layer through the same public
proxy. The request uses the current EPSG:4326 viewport so the returned GeoJSON
geometry can be highlighted directly by Leaflet. Hidden vectors and raster
layers are never queried.

The public contract accepts only `application/json`, at most ten upstream
features, a search buffer no larger than twenty pixels, and a response no
larger than 512 KiB. The browser asks for at most five features per visible
layer, aborts superseded clicks, ignores stale responses, bounds displayed
property values, and writes all names and values with `textContent`. The
source geometry field is omitted from the attribute table because the selected
geometry is already represented by the temporary map highlight.

The browser composition root projects visible retained vector records into the
inspector's narrow target contract and coordinates raster-sampling pause and
map-side panel visibility. The inspector does not read the retained-layer
controller, compare concrete map adapters, or call sibling presentation
controllers. Its WMS publication name remains a current-process lifecycle
identifier authorized by the existing published-layer registry; no filesystem
path is accepted or exposed.

## Production verification

`deployment/require-geoserver-vector-datastores.sh` fails image build and
startup unless `gt-shapefile-*.jar` and `gt-geopkg-*.jar` exist. The Maven tests
exercise the same deployed-factory assessment service against a representative
Shapefile and multi-layer GeoPackage. These checks prove image contents and the
exact-reader contract available in CI/local builds.

Deployment still requires richpsharp to run the draft PR image against the
production mount: scan a representative Shapefile and a two-layer GeoPackage,
add each exact layer, reload/re-add it, and confirm WMS tiles plus distinct
point/line/polygon styles. Keep the PR draft until that environment check is
complete.
