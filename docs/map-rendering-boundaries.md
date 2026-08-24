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
  validates parameters owned by the publishing dataset domain.
- The restricted WMS route owns operation, size, response-format, and parameter
  bounds. It asks each configured registry for authorization and does not
  import a dataset feature package.

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

- `MapLayerStack` owns two-visible-layer capacity, opacity, active selection,
  and top-first order without DOM or Leaflet dependencies.
- `LeafletLayerSet` owns keyed attachment, detachment, opacity, z-order, and
  cleanup without publication behavior.
- `MapLayerStackView` owns the layer-list DOM and emits semantic user actions.
- `MapLayerController` coordinates publication concurrency and retained-layer
  lifecycle through dataset-owned adapters. When active ownership changes, it
  asks the outgoing adapter to release its controls before activating the next
  adapter; neither owner imports or calls its sibling.

The application composition root constructs the controller. The raster viewer
supplies an adapter and continues to own its appearance, analysis, sampling,
and pixel-probe sessions. Shared map-layer modules do not import raster modules,
and raster modules do not duplicate retained-stack or Leaflet-set ownership.
Raster detail preview depends on Catalog identity directly and does not import
the map-layer package.

## Dependency direction

```text
application composition
    -> dataset feature adapter
    -> neutral map-layer controller -> stack / view / Leaflet set
    -> Catalog Item identity <- detail preview / Catalog actions

FastAPI composition
    -> dataset publication service -> shared GeoServer REST gateway
    -> restricted WMS route -> published-layer registry contract
```

New dataset renderers must implement these explicit contracts at composition;
they must not add suffix dispatch, source assessment, publication policy, or
dataset-specific request rules to the neutral modules.
