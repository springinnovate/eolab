# Add a model recipe

A model is an installed YAML recipe. It describes the setup form, binds inputs
and parameters to a registered operation, and names its output. A run is a
separate, session-owned job containing a captured recipe and input choices.

## Reuse an operation

Add a `.yaml` file to `src/eolab_app/processing/recipes/`, then build and deploy
the application and worker together. All files in that directory are discovered
and validated at startup. There is no recipe-name dispatch in the API, worker
or result view, and no database migration or JavaScript change is required for
a new recipe using supported inputs, parameters and outputs.

Start with `raster-summary.yaml` or `raster-clip.yaml`. Use a distinct model ID
and semantic version. Input and parameter names belong to the recipe; the keys
under a step's `inputs` and `parameters` belong to the operation:

```yaml
inputs:
  habitat: {type: catalog_raster, label: Habitat raster}
  region: {type: clip_area, label: Analysis area}
parameters: {}
steps:
  - id: extract
    operation: raster.clip.v1
    inputs:
      raster: {input: habitat}
      area: {input: region}
    parameters: {}
outputs:
  habitat_extract:
    source: extract.raster
    type: raster
    label: Habitat within the analysis area
    role: result
    presentation: map
    saveEligible: true
executionProfile: raster-clip
```

This fragment also needs the ordinary `schema`, `id`, `version`, `title` and
`description` fields from the complete bundled examples. The output label is
shown on the completed run. Output `type` and `label` are optional for older
recipes: the operation supplies defaults. Declaring a type that differs from
the operation's actual output is rejected. Defaulted fields are not inserted
into exported older recipes, preserving their checksums.

| Operation | Required input types | Parameters | Output | Execution profile |
| --- | --- | --- | --- | --- |
| `raster.aggregate.v1` | `raster: catalog_raster`, `area: summary_area` | `expression: summary_expression` | `statistics`, type `statistics`, presentation `table`, CSV | `raster-summary` |
| `raster.clip.v1` | `raster: catalog_raster`, `area: clip_area` | None | `raster`, type `raster`, presentation `map`, GeoTIFF | `raster-clip` |

A summary recipe can rename its formula parameter and change its default, such
as `mean(a)` or `stdev(a)`. Formula syntax and area support remain governed by
the registered operation. Execution profiles select supported server policy;
recipes cannot raise deployment resource limits. The current runner accepts
one step, one catalog raster and one output file, plus provenance. `map` and
`saveEligible` describe output capabilities; map previews and permanent saving
are not implemented yet. YAML import from the browser is also not available.

## Add a new algorithm

YAML selects trusted capabilities; it does not contain Python import paths or
execute arbitrary code. A genuinely new algorithm needs a registered operation
in `processing/model_operations.py`, with its adapters in the owning Processing
module. `processing/raster_operations.py` contains the existing adapters.

The registration declares input/parameter types, queued and prepared schemas,
request binding, source identity, owned polygon capture, preparation, native
execution, numerical policy, result metadata and retained Run YAML outcome.
Ordinary summary cache behavior is also registered. Model runs execute afresh
and do not join ordinary shared calculations or reuse their scalar cache.

The worker continues to own authorization, attempt fencing, cancellation,
time limits, disk admission and atomic file publication. Native kernels and
storage adapters do not import recipe definitions or inspect model IDs.
Registered numerical policy reports what the implementation actually did;
YAML cannot claim different resampling or inclusion rules. Adding new input
capabilities, multiple sources, multiple steps or multiple outputs requires an
explicit contract extension rather than an unvalidated recipe workaround.

## Reuse an output type

Model job responses carry `kind`, `name`, `label`, `role`, `presentation` and
`mediaType` alongside owned download metadata. `name` and `label` are captured
from YAML when the run starts, so results keep their names even after the
recipe is removed or saved setup metadata expires. Raster result grids expose
file dimensions, CRS, datatype and affine transform; execution windows and
reservations belong to Run YAML, not the shared file result contract.

`processing/model_result_contracts.py` validates backend output types.
`frontend/src/processing/model-results.js` validates browser responses and
`frontend/src/models/result-view.js` presents those types. These modules need
changes only for a genuinely new result type, not another recipe producing a
supported raster or statistics table. Ordinary raster clip and summary API
response contracts are unchanged. Historical model records without output
descriptors are normalized at the backend serialization boundary.

## Verify a recipe

Load it through `ModelRegistry`, round-trip exported Model YAML, submit it
through the Models API, run the actual operation, and check its downloads and
Run YAML. Tests use unfamiliar model IDs, renamed input/parameter bindings and
custom output names to verify that no application code recognizes the recipe
by name. Keep numerical, source-staleness, ownership, resource-limit and
cancellation tests with the operation that owns those rules.
