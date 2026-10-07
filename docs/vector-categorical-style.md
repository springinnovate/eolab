# Vector category tables

In a catalog vector layer’s style editor, choose **Categories** and the
**Attribute field** whose values identify the categories. Existing bounded
category discovery and color editing remain available. You can also choose
**Import categories from CSV**, inspect the preview, then select **Replace
categories**. The whole table replaces the category rules in the current layer
style. Reading, invalid input and **Cancel import** leave the style unchanged.

CSV headers are `value,label,color` with optional `opacity`. Headers are
case-insensitive and may appear in any order. Unknown or duplicate columns and
uneven rows are rejected. Colors use `#RRGGBB`; opacity is a decimal from 0 to 1,
with omitted or blank values defaulting to 1. Labels contain 1–256 characters.
Ordinary quoted commas, doubled quotes, LF/CRLF and UTF-8 BOM are supported.
Input is limited to 128 KiB and the existing **50 vector categories**.

For example, [vector-category-example.csv](vector-category-example.csv):

```csv
value,label,color,opacity
forest,Forest,#228b22,1
wetland,Wetland,#4169e1,0.6
water,Water,#0000ff,1
```

Values match the selected Catalog attribute’s type:

| Field type | CSV value |
| --- | --- |
| Text | Exact literal text, including meaningful whitespace, leading zeros and empty strings |
| Integer | Safe whole decimal integers; zero and negatives are supported; `41.0` is accepted but fractional values and exponents are rejected |
| Number | Finite decimal numbers, including decimal exponents |
| Boolean | `true` or `false`, case-insensitive |

The importer does not guess types from a cell or join data to the source. An
empty text category differs from a missing/null attribute. Duplicate values
after typed conversion are rejected, with the source record’s physical row.
Imported values need not appear in a bounded discovery sample.

CSV order controls category and legend order. Imported colors, legend labels and
opacity remain editable in the same style panel. Re-import a CSV to change the
value identities or table order. Changing the attribute returns to discovery
for that field. **New colors** recolors the retained values. Switching to another
color mode preserves the table while the editor remains open; saved styles retain
the active mode through the existing style contract. Other/No value colors and
geometry symbol settings remain in the editor’s existing state.

Category opacity multiplies both fill and stroke opacity, then whole-layer
opacity. A zero-opacity category still matches its typed value; it does not fall
through to Other or change source validity, feature labels, filters or analysis.
Category labels affect legends only; feature labels still use their selected
attribute. Saved/shared maps, local persistence, and compatible style copy/paste
retain the table in the existing vector style definition. No catalog-wide
defaults or source files are changed.

Values outside the table use **Other**, including when feature labels are
enabled. Missing/null values use **No value** when configured, otherwise Other.
The category field matters: for example, a feature with `BIOME=13` and
`G200_BIOME=0` matches category 13 only when the selected field is `BIOME`.

## Ownership and compatibility

The vector editor owns file preview/replacement and cancellation. The vector CSV
input boundary interprets typed values and calls canonical vector normalization.
Raster and vector CSV inputs share only the neutral bounded record/header reader
in `frontend/src/category-csv.js`; no style owner imports its sibling. Raster
input retains its integer-only category and 256-row contracts.

Each existing typed vector rule may additionally carry `label` (literal legend
text or null) and `opacity` (finite 0–1). Supported older rules without these
fields default to their formatted attribute value and opacity 1. Portable style
validation adds only these defaults and continues rejecting other missing or
unsupported fields. Existing opaque saved-map envelopes need no schema change.

Vector-owned API validation and style generation preserve Catalog source/field
authorization, signatures, geometry, scalar types, rule limits, and immutable
style/cache identity. Counts do not authorize explicit categories. The same SLD
generator applies category opacity through ordinary and composite rendering;
literal legend text never becomes a GeoServer expression.
