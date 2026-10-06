# Categorical raster appearance

Issue #645 introduces the rendering contract. Issue #646 adds the manual category
editor and map-layer persistence. Issue #647 adds discrete legends and categorical
pixel presentation. CSV import remains in #648. Analysis responses remain numeric
and independent of the selected appearance.

## Manual editing and persistence

Open a raster's Style panel and choose Categorical. Enter an exact integer value,
label, six-digit hex color, and opacity percentage for each category. Rows can be
added, removed, and moved with keyboard-accessible buttons. Unmapped valid values
have a separate color and opacity; source NoData remains transparent.

The empty starter row does not invent a category. A complete valid draft applies
after a short debounce or a completed edit. Invalid rows remain editable while
the map and persistence keep the last valid appearance. Switching to Continuous
restores its retained palette, thresholds, and opacity stops. Switching back
retains the category table. Closing and reopening an editor restores committed
settings, discarding incomplete drafts.

The raster owner exports a versioned appearance envelope:

```json
{
  "kind": "raster",
  "appearanceVersion": 1,
  "mode": "categorical",
  "continuous": {
    "definition": {
      "minimum": 0, "midpoint": 50, "maximum": 100,
      "minimumColor": "#2b83ba", "midpointColor": "#ffffbf", "maximumColor": "#d7191c",
      "minimumOpacity": 1, "midpointOpacity": 1, "maximumOpacity": 1
    },
    "paletteName": "blue-yellow-red",
    "styleWasEdited": false
  },
  "categorical": {
    "mode": "categorical",
    "categories": [{"value": 41, "label": "Forest", "color": "#228b22", "opacity": 1}],
    "unmapped": {"color": "#808080", "opacity": 1}
  }
}
```

`categorical` may be null only when the selected mode is continuous. The existing
saved-map schema version remains 3; the style payload has its own explicit
version. Legacy `{kind, definition, paletteName}` raster styles restore as
continuous, with omitted legacy opacity stops set to one and the range marked
edited as before. Saved-map transport validates the envelope and existing map
size limits; the raster owner validates both style definitions on restoration.
Both configurations travel through local storage, saved/shared maps, style
copy/paste, and removal Undo. There is no catalog-wide category definition.

## Legends and pixel values

Categorical layers show discrete swatches in both the layer-list Legend disclosure
and the on-map legend. Entries follow the category table's order and include the
label and exact code, such as `Forest (41)`. An Unmapped entry uses the configured
fallback appearance. Swatches reflect category opacity multiplied by layer
opacity; fully transparent categories remain listed. Editing labels, colors,
opacities, or row order updates the legend from the committed appearance.

The pixel picker, raster values at a click, and copied picker values show
`Forest (41)` for an exact match and `Unmapped (42)` for valid values absent from
the table. Category codes use ordinary decimal notation. Samples are never rounded
to a category. NoData remains `No data`, and a category with zero opacity still
shows its label and value. Continuous layers retain their existing numeric
formatting.

Presentation uses the category table belonging to the sampled map layer.
Committed category edits refresh retained pixel readouts without another source
read. The composition layer joins immutable appearance metadata to numeric sample
results; source readers, request controllers, and analysis responses do not acquire
style or rendering dependencies. Catalog analysis without a styled map-layer
context continues to present numeric results.

Categorical histogram and percentile presentation remains deferred. Distribution
panels explain that categorical distributions and area proportions are not yet
available. Coordinated 2D styling requires continuous layers. Numeric source
sampling, statistics, and Processing remain available, including when rendering
is unavailable.

## Appearance definition

```json
{
  "mode": "categorical",
  "categories": [
    {"value": 41, "label": "Forest", "color": "#228b22", "opacity": 1},
    {"value": 21, "label": "Developed", "color": "#dc143c", "opacity": 0.75}
  ],
  "unmapped": {"color": "#808080", "opacity": 1}
}
```

Definitions belong to an individual map layer's appearance. They do not change
catalog metadata, a dataset's shared GeoServer style, or its source data.

- A table contains 1–256 unique exact integer values within JavaScript's safe
  integer range, including zero and negative values. Integral numeric JSON values
  such as `41.0` are accepted. Strings, booleans, fractional values, and nonfinite
  numbers are rejected. Raster samples are never rounded into categories.
- Labels are trimmed, nonempty, at most 128 Unicode code points, and remain
  display data. Their text never enters a GeoServer expression or SLD literal.
- Colors use six-digit `#RRGGBB` notation, normalized to lowercase. Opacity is a
  finite number from 0 to 1 and defaults to 1. Layer opacity multiplies the rendered
  category opacity.
- Missing `unmapped` fields default to opaque `#808080`. Unmapped valid samples
  use that appearance. Source NoData remains transparent. A zero-opacity category
  is still a category, distinct from NoData.
- Unknown fields and duplicate category values are rejected. Direct JSON rejects
  duplicate object keys. A definition is limited to 65,536 UTF-8 bytes.
- Input order is retained for the editor and legends. Rendering sorts a copy
  by value and does not reorder the appearance definition.

`frontend/src/raster/categorical-style.js` provides normalization for the manual
editor and retained appearance state. Python's raster-owned `styles.py` validates the public input
boundary independently. Neither module imports analysis or editor implementation
state.

## Rendering requests

Use the existing `POST /api/map-rendering/plans` endpoint for structured tables:

```json
{
  "layers": [{
    "layerName": "eolab:published-layer-id",
    "styleName": "dynamic-raster",
    "styleDefinition": {
      "mode": "categorical",
      "categories": [{"value": 41, "label": "Forest", "color": "#228b22"}]
    },
    "opacity": 1
  }]
}
```

The layer must already have an authorized publication. Each layer supplies exactly
one of `styleEnvironment` (continuous) or `styleDefinition` (categorical for a
raster). Composite plans retain the existing 64-layer and 256-plan limits, with a
512 KiB compact UTF-8 limit per plan. Appearance data participates in the plan
identity, so two maps can style the same dataset independently.

For small definitions, the existing direct WMS GetMap proxy also accepts a
`raster_style` query parameter containing serialized JSON. It cannot accompany
`env`, be supplied to vector layers, or be used for GetFeatureInfo or legends.
Browser/proxy URL limits can be lower than the definition limit; use the composite
POST for larger tables. Arbitrary public SLD parameters remain forbidden.

Both paths compile trusted per-request SLD using the same raster-owned generator.
Categorical requests use form-encoded upstream POST bodies, bypass shared native
tile caching, and select nearest-neighbor interpolation per categorical layer.
Continuous-only composite requests retain their existing XML transport.

## Native rendering ownership

The existing GeoServer extension build packages `eolabCategoricalRaster`, a
GeoTools rendering transformation. It styles the source's first band, matching
the existing single-band raster appearance model. Its input consists only of bounded numeric
codes, colors, and alpha values generated by the raster adapter. It operates on
the reader's requested coverage and preserves its NoData and mask information.
It does not scan sources to discover categories or change shared publication
configuration. Per-request reader parameters select nearest-neighbor sampling
and ignore potentially averaged source overviews. The transformation limits its
requested/classified grid to 4096 pixels per side and 16,777,216 pixels overall.
These limits do not bound the number of compressed TIFF blocks the reader must
decode. GeoServer's existing memory, time, and concurrency controls continue to
own that work; ignoring overviews can make far-zoom rendering more expensive.

The browser composition and neutral composite renderer coordinate feature-owned
styles through the existing authorization port. The port's interpolation override
is trusted rendering metadata, with no raster-specific parsing in the composite
service. Catalog authorization, request coalescing/cancellation, render queue
bounds, source lifecycle checks, and analysis independence remain in their current
owners. Pixel analysis, statistics, and Processing gain no dependency on this
rendering function or GeoServer.
