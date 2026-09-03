# Map rendering boundaries

EOLab separates dataset-owned assessment and publication rules from the
application-wide delivery and browser lifecycle needed by every retained map
layer. This boundary is deliberately behavior-preserving: it does not add a
dataset format, publication policy, fixture, or appearance rule.

## Server ownership

`eolab_app.rendering` contains only contracts and infrastructure shared by map
publication adapters:

- `GeoServerPublicationGateway` owns strict REST transport, accepted-status
  enforcement, failure sanitization, and the initialized workspace convention.
- `PublishedLayerRegistry` returns current process-local authorization for one
  published layer.
- `PublishedLayerAuthorization` exposes the fixed authorized appearance and
  validates parameters owned by the publishing dataset domain. It also builds
  one single-layer SLD only after validating a composite-plan appearance.
- The restricted WMS route owns operation, size, response-format, and parameter
  bounds. It asks each configured registry for authorization and does not
  import a dataset feature package.
- `CompositeMapRenderingService` owns bounded, immutable, process-local render
  plans. It coordinates feature-owned authorizations through the same neutral
  registry contract and assembles their SLD layers without importing raster or
  vector implementations. The composite HTTP route serializes a WMS GetMap
  POST and shares disconnect cancellation and diagnostics with ordinary WMS.

Raster retains ownership of mounted-source resolution, filesystem signatures,
dynamic-appearance parameters, assessment, and publication reconciliation.
FastAPI composition supplies the raster registry to the restricted WMS route;
neither the route nor the shared rendering package constructs feature services.

## Browser ownership

`frontend/src/catalog-item-identity.js` owns validation and serialization of a
Catalog Item's composite Collection and Item identity. Catalog actions, map
layers, and raster detail previews depend on that lower-level contract without
depending on each other's implementation state.

`frontend/src/map-layers/` owns the retained presentation contract:

- `MapLayerStack` owns retained-layer visibility, opacity, active selection,
  and top-first order without DOM or Leaflet dependencies.
- `LeafletLayerSet` owns keyed attachment, detachment, opacity, z-order, and
  cleanup without publication behavior. With the composition-supplied
  `CompositeLeafletRenderer`, it presents the ordinary visible stack as one
  WMS grid while retaining feature layers detached for interaction state.
- `CompositeLeafletRenderer` atomically replaces content-addressed render-plan
  grids after the new grid loads; `CompositeMapPlanClient` owns only the
  same-origin plan-registration HTTP contract.
- `MapLayerStackView` owns the layer-list DOM and emits semantic user actions.
- `MapLayerController` coordinates publication concurrency and retained-layer
  lifecycle through dataset-owned adapters. When active ownership changes, it
  asks the outgoing adapter to release its controls before activating the next
  adapter; neither owner imports or calls its sibling.

The retained presentation contract imposes no UI layer-count limit. The
ordinary visible raster/vector stack is sent as one bounded composite plan and
rendered by GeoServer in bottom-to-top order, so adding a retained layer does
not add another Leaflet tile grid. The server rejects plans above its explicit
layer-count bound. The raster viewer independently bounds automatic histogram
and bivariate analysis to the top two visible rasters. Explicit bivariate mode
temporarily requests the composition root's independent-grid strategy because
its browser additive blend cannot be represented by the ordinary composite
contract; leaving 2D mode restores the single composite grid.

The application composition root constructs the controller. The raster viewer
supplies an adapter and continues to own its appearance, analysis, sampling,
and retained point-sample sessions. Shared map-layer modules do not import
raster modules, and raster modules do not duplicate retained-stack or
Leaflet-set ownership.
Raster detail preview depends on Catalog identity directly and does not import
the map-layer package.

Portable saved maps add a composition-level coordinator rather than a new
rendering owner. The coordinator reads neutral retained records and delegates
appearance export/restoration through optional adapter hooks. It resolves only
Catalog Collection and Item identities, repeats current assessment and
publication, and hashes opaque source revisions before encoding a browser-only
URL fragment. The fragment codec stays inside the saved-map package and does
not create another rendering or persistence owner.
The saved-map package imports neither raster nor vector implementations; see
`saved-map-views.md` for its trust and compatibility contract.

Map exploration remains composition rather than a new feature coordinator.
The application root owns one Leaflet click and forwards its position to the
raster viewer and vector feature inspector through their public boundaries.
It also applies the map-wide crosshair interaction cue. The raster viewer owns
sample-window validation, its passive noninteractive pointer preview, and
statistics requests; the vector inspector owns bounded GetFeatureInfo requests,
cancellation, progressive target-ordered result presentation, attributes, and
highlighting. It exposes loading and completed observations only through its
existing immutable callback boundary. Neither peer imports, activates, pauses,
or reads the implementation state of the other, and closing a result panel
changes presentation only.

## Dependency direction

```text
application composition
    -> dataset feature adapter
    -> map click -> raster exploration / vector inspection
    -> neutral map-layer controller -> stack / view / Leaflet set
                                -> composite plan client / Leaflet renderer
    -> Catalog Item identity <- detail preview / Catalog actions
    -> saved-map coordinator -> Catalog visualization / neutral viewport
                             -> neutral map-layer adapter hooks

FastAPI composition
    -> dataset publication service -> shared GeoServer REST gateway
    -> restricted WMS route -> published-layer registry contract
    -> composite map route -> composite plan service
                           -> published-layer registry contract
                           -> GeoServer WMS GetMap POST
```

New dataset renderers must implement these explicit contracts at composition;
they must not add suffix dispatch, source assessment, publication policy, or
dataset-specific request rules to the neutral modules.
