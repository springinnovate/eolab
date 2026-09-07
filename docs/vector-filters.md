# Vector attribute filters

Issue: [#326](https://github.com/springinnovate/eolab/issues/326).

Each retained vector layer has a dedicated **Filter** panel. Add up to 12
field/comparison/value conditions, then choose Match all (AND) or Match any (OR).
Complete edits apply after 450 ms. Invalid drafts show a message and leave the
previous applied filter in use. Disable preserves rules; Clear removes them.
The layer row and the map's top controls link back to the filter. Active counts
describe the whole layer, never the current viewport or a sampled estimate.

The initial operators are numeric comparisons, case-sensitive text equality,
inequality and literal substring matching, Boolean equality/inequality, ISO
calendar-date comparisons for Catalog `date` columns, and explicit missing/not
missing checks. Other field types offer missing checks only. Nonmissing
comparisons exclude nulls, including inequality. A text value is a literal, not
an expression, wildcard pattern, regular expression, SQL fragment, or function.
Nested groups and a raw expression editor are intentionally outside this issue.

Filters affect rendered geometry, labels, GetFeatureInfo, and highlights. Changing
the rendering identity invalidates the existing feature sample and its plots;
the next click produces plots from the filtered sample. Filtering preserves the
applied style, class boundaries, and label configuration. Saved maps retain
enabled or disabled rules separately from style, and reauthorize them against the
current Catalog on restore. Style copy/paste never copies a filter. A failed
filter restore skips that layer with an explanation rather than displaying it
unfiltered.

## Ownership and relationships

**Owner:** the existing vector feature. `VectorPublicationService` authorizes
filtered views and coordinates bounded counts. The vector adapter owns applied
browser state; `VectorFilterControls` owns editing and drafts.

**Used by:** thin vector delivery routes, the neutral WMS/composite boundaries,
the map-layer presentation and saved-map adapter hooks, and browser composition.

**Depends on:** authoritative Catalog fields and assessments, the existing exact
mounted-source resolver/signature contract, and the existing geometry-free vector
field reader. Shared rendering contracts carry authorized identities and queries.

**Coordinates with:** style, feature inspection and plots through composition
callbacks and existing lifecycle identities. No vector control imports another
control implementation, and shared map/rendering components import no feature
implementation. Raster statistics and analysis are unchanged.

Architectural components changed:

- Vector predicate values/compilers, metadata helpers, bounded field reader and
  port, publication workflow, publication registry and WMS authorization.
- Thin vector routes and the existing neutral HTTP disconnect helper's use.
- Neutral rendering authorization protocol and WMS delivery; raster WMS
  authorization implements its new identity-preserving query hook.
- Vector browser API, retained-layer adapter, filter controls and feature
  inspector's Filter intent callback.
- Neutral layer controller/presentation, style editor's Filter intent callback,
  map inspection dock, saved-map model/controller, and frontend/backend
  composition roots. Markup and styles provide the new panel and indicators.

Dependency changes:

- Existing vector route → vector publication, vector publication → Catalog,
  resolver and registry, and WMS route → neutral authorization edges are extended
  with filtering operations; they retain their original directions.
- Vector publication → existing vector field-reader port is added for counts.
  Styling and filtering share extracted vector metadata helpers and one field
  visitor; there is no publication → styling-service dependency.
- Vector API/adapter and filter controls → vector predicate module are added.
  The frontend composition root → filter controls edge wires existing neutral
  presentation/adapter hooks. Inspector and style editor emit Filter intent
  callbacks through composition; neither imports the filter controls.
- Saved-map controller → optional neutral adapter filter hooks and map-layer
  view → neutral filter presentation fields extend existing adapter contracts.
- Vector routes → existing neutral HTTP disconnect helper is added for counts.
- No subsystem dependency is removed or reversed. No new top-level service,
  coordinator, source dataset, GeoServer datastore or global layer filter is
  introduced. No sibling implementation knowledge is added.

## Rendering identities and bounds

An active filter registers a content-addressed opaque `eolab:filtered-…` identity
bound to the original publication, complete source signature, and validated
rules. The process-local LRU retains at most 256 identities. Every render
reauthorizes the original source; eviction/restart/source changes fail closed
with a reapply/reload message. Other maps using the original publication remain
unfiltered. Rule registration does not mutate shared GeoServer layer settings.

The vector authorization translates public WMS identities into the original
upstream layer and a server-generated ECQL predicate. Public arbitrary
`cql_filter`/`filter` parameters remain prohibited. Filtered individual WMS
requests omit GWC tiled hints; composite plan identities include the opaque view
identity. Highlight IDs are intersected with the same predicate.

Composite styles intersect the predicate with every original geometry and label
rule. Category ElseFilter rules retain the complement of their original class
predicates. Original style hashes continue to use the original layer identity.
Text substring matching uses GeoServer's documented
[`strIndexOf`](https://docs.geoserver.org/stable/en/user/filter/function_reference/)
with an escaped literal in both ECQL and OGC expressions.

Counts are asynchronous, geometry-free source scans with a 1,000,000-row cap,
20-second cooperative budget, 21-second response deadline, and two reader slots.
Cancellation retains a slot until the worker actually exits. Complete source
signatures are checked before and after reading; complete row counts must agree
with authoritative Catalog metadata. At most 256 exact count results are cached
by complete source identity and rules. Partial results expose neither matched nor
total counts. Capacity/time limits produce “Count unavailable” while preserving
the applied filter.

The deliberate coupling is the extended neutral rendering query hook and optional
saved-filter adapter contract. An opaque view expires with its application
process, like existing composite plans. Counts may be unavailable for very large
layers; map filtering does not depend on counts finishing.

## Validation

Owner tests exercise typed validation, literal escaping, Boolean/null semantics,
AND/OR, exact/incomplete/canceled Fiona reads, source changes, LRU expiration,
unchanged base publications and styles, composite label/ElseFilter behavior,
public WMS/FeatureInfo/highlight forwarding, and HTTP request validation.
Browser tests cover debounce, invalid drafts, enable/clear, stale replies,
removed-layer cancellation, count labels, saved-link round trips, fail-closed
restoration, and separation from style copy/paste. Existing architecture tests
remain part of the backend suite.

Local checks for this draft:

- `.venv-312/python.exe -m pytest -q --tb=short`: all 543 backend tests pass.
- `node --test --test-reporter=dot` in `frontend`: all 564 browser-module tests pass.
- `node node_modules/vite/bin/vite.js build` in `frontend`: production build passes
  (Vite reports its advisory bundle-size warning).
- Browser review of the real filter controls and dock: the two-condition example
  fits the panel, input focus remains stable, and changes debounce automatically.
- `git diff --check`: clean.
