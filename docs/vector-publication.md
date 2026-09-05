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
- the focused vector field-reader port uses Fiona to read only one
  Catalog-declared scalar or numeric field, without geometry, under fixed row,
  value, concurrency, and cancellation bounds;
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

`vector/defaults.js` owns browser default-selection policy using only Catalog
field metadata and explicit numeric results. The existing vector map adapter
coordinates publication, optional classification, and style application before
the layer is attached. The controls consume the same defaults. No vector
component imports raster analysis or rendering, and numeric reads remain
available independently of GeoServer and map state.

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

Vector layers start with fixed `vector-point`, `vector-line`, or
`vector-polygon` styles and never accept raster `env` substitutions. Points and
polygons have blue fills at 70% opacity and 0.75 px black outlines; lines use a
2 px blue stroke. Before displaying a newly added layer, the browser selects a
recognizable text name (case-insensitive `name`, then `display_name`,
`common_name`, `label`, `title`, `nm`, or a sole `name_*`/`*_name`/`nm_*`/`*_nm`
field, including the workshop's `node_nm`). Labels use
12 px dark text, a 1.5 px white halo, and minimum zoom 0. Point labels sit above
the symbol; line labels use a fixed centroid; polygon labels use a fixed
interior point. Follow-line placement remains available explicitly.

After excluding obvious ID, code, and index fields, the browser chooses the
latest annual numeric field (for example, `R2024` before `R2023`); otherwise it
uses the first numeric measurement in Catalog field order. It requests five
classes over the 5th–95th percentile range and applies blue–yellow–red colors
before first display. Layers without an eligible field remain single color.
The user can change the choice under **Color features by → Numeric ranges → Color by**.
The label field remains selectable under **Label by**, and **Show labels** can
turn labels off. Automatic classification/style failures retain an authorized
base appearance and expose a notice in Style. Defaults run only on new
publication preparation: selecting retained layers preserves edits, and saved
style restoration takes precedence while the layer is still detached.

The vector-owned style workflow can replace that initializer style with a
content-addressed single-color, categorical, or graduated SLD. The browser submits only
Catalog identity and a complete validated style; the server re-resolves the current Item,
source signature, publication authorization, geometry family, and any selected
label field before deriving the GeoServer resource identity. A changed style
therefore receives a changed authorized WMS style name and refreshes cached
Leaflet tiles immediately.

Categorical discovery is a vector-owned source analysis, not a GeoServer
operation. The browser posts Collection ID, Item ID, and one exact STAC Table
field. `VectorStyleService` reloads the Item, resolves the mounted source,
requires a current successful reader assessment and source signature, and asks
the focused Fiona adapter to read only that field with geometry ignored. The
adapter scans at most 100,000 features, checks cooperative cancellation per
feature, limits explicit string values to 256 characters, and returns at most
50 typed values ordered by observed count. The response distinguishes scanned
from total features, observed from exact distinct counts, null values, excluded
long or unsupported values, and complete from partial reads. A final signature
check rejects sources that change during the read. This path does not consult
the published-layer registry or GeoServer, so Catalog search and bounded field
exploration remain available when rendering is unavailable.

The style form defaults to 20 explicit categories under the server-advertised
maximum of 50. It uses a fixed qualitative palette, retains existing
value-to-color mappings when the user changes that limit, permits individual
overrides, and regenerates colors only on explicit request. Remaining values
use an optional **Other** rule and nulls use a separate **No value** rule. JSON
values carry an explicit boolean, integer, number, or string kind so integral
floating values cannot be confused with integer fields. When a categorical
style is applied, the service revalidates its field and every rule kind against
current Catalog metadata before GeoServer receives SLD equality, null, and
else rules. Point and polygon categories replace fill color; line categories
replace stroke color; the geometry-specific size, outline, width, and opacity
controls remain authoritative.

Graduated numeric discovery follows that same vector-owned field-analysis
boundary. The browser posts only Catalog identity, one current integer or
floating-point field, `equal-interval`, `quantile`, or `percentile-interval`,
and a requested class count from two through nine. The shared Fiona adapter reads at most 100,000
features with geometry ignored and reports finite values, missing values,
unsupported values, scan completeness, and source extent. Equal intervals use
the observed minimum and maximum. Quantiles use deterministic nearest-rank
breaks; repeated breaks collapse, so the response can honestly contain fewer
classes than requested.

Percentile intervals use nearest-rank 5th and 95th percentiles from the same
bounded read, then divide that numeric span into equal intervals. Tails remain
in the open-ended first and last classes. Repeated or numerically collapsed
breaks are removed; a collapsed percentile range yields one class. Original
equal-interval and quantile behavior is unchanged.

Every returned class is adjacent and collectively covers all numeric values:
the first range has no lower bound, internal lower bounds are exclusive and
upper bounds inclusive, and the last range has no upper bound. This keeps
features outside an incomplete sample's observed extent visible. The browser
assigns a deterministic low-to-high color sequence from Blue–yellow–red, Blues,
Viridis, Yellow-to-red, or Purples, and can separately style nulls when they exist. On
apply, `VectorStyleService` repeats the current bounded classification and
requires the submitted ranges to match before generating GeoServer comparison
filters. A changed source or class result therefore stops styling rather than
publishing stale breaks. The map-layer view consumes only the vector adapter's
neutral legend entries and does not know numeric-style internals.

The vector style can optionally add one `TextSymbolizer`. Labels are `null` by
default in the fixed publication response; browser initialization enables a
recognized name as described above. An enabled label contains an exact field
from the Item's current STAC Table Extension columns, closed font-family and weight choices, bounded font
and halo values, geometry-aware placement, and a zoom from zero through 22.
Positive minimum zooms become a label-only `MaxScaleDenominator` rule; zero
omits the scale cutoff. Hiding labels at small scales never hides the underlying
geometry. Polygon labels use a full-feature `interiorPoint` expression instead
of GeoServer's tile-clipped polygon placement. The empty geometry property
selects the published feature's default geometry without guessing its column
name. Centered line labels similarly use a full-feature `centroid` expression.
Labels permit overlap (`conflictResolution=false`); fixed placements allow
partials across tile edges and wrap at the larger of 120 px or 12 font sizes.
The vector GeoServer publisher sets a bounded 256–884 px layer rendering margin
from the validated font and halo, so adjacent tiles query features whose labels
extend into their image. Unlabeled styles reset this margin to zero. This changes
neither the public tile size limit nor the explicit feature-inspection buffer.
Polygon labels also retain `goodnessOfFit=0`.
The content style identity includes the generated SLD as well as validated
settings, so changed placement policy invalidates older cached rendering.
Attribute values are neither copied through the browser nor truncated: GeoServer
evaluates the selected field for each feature. Crowded names may overlap; fixed
anchors outside the viewport do not move inward to label a visible polygon
fragment. Explicit follow-line placement remains geometry-dependent. Very long
values and large-layer label performance still need dataset-specific review. For a
categorical or graduated style, labels occupy a second `FeatureTypeStyle`; this keeps their
unfiltered, independently scaled rule from suppressing the geometry
`ElseFilter` while leaving label state independent from category selection.

Vectors share the neutral retained-layer visibility limit, opacity, top-first
ordering, activation, removal, and tile-error ownership with raster WMS
layers. Fit-to-bounds is an adapter option and defaults on when a vector is
added. Selecting a vector hides raster-only palette, histogram, pixel, and
sample-window controls.

### Feature inspection

When at least one published vector is visible, one map click issues an independent WMS 1.1.1
`GetFeatureInfo` request for each visible vector layer through the same public
proxy. The request uses the current EPSG:4326 viewport so the returned GeoJSON
geometry can be highlighted directly by Leaflet. Hidden vectors and raster
layers are never queried for features. The same click may independently select
a raster histogram window when raster analysis is available; neither result
depends on the other succeeding.

The public contract accepts only `application/json`, at most ten upstream
features, a search buffer no larger than twenty pixels, and a response no
larger than 512 KiB. The browser asks for at most five features per visible
layer, aborts superseded clicks, ignores stale responses, bounds displayed
property values, and writes all names and values with `textContent`. The
source geometry field is omitted from the attribute table because the selected
geometry is already represented by the temporary map highlight.

The browser composition root projects visible retained vector records into the
inspector's narrow target contract, owns the single Leaflet click, and fans that
intent out to the independent raster and vector boundaries. Closing either
result only hides its map-side panel and does not disable later map clicks. The
inspector does not read the retained-layer
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
point/line/polygon styles. For label changes, choose a text and numeric field,
confirm recognizable names are enabled automatically, verify geometry-specific placement and
minimum zoom, and revisit a cached zoom after changing font or halo controls.
For graduated styling, test an integer and floating-point field with both
methods, change class count and palette, confirm repeated quantiles collapse
without gaps, inspect the map-layer legend, and revisit cached zooms after
applying the style.
Keep the PR draft until that environment check is complete.
