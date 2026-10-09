# Add a model recipe

A model is an installed YAML recipe. It describes the setup form, binds inputs
and parameters to a registered operation, and names its outputs. A run is a
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
one step and one catalog raster. Recipes can retain multiple outputs declared
by that operation, plus provenance. The bundled summary and clip operations
currently each produce one scientific result. `map` and
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
capabilities, multiple sources or multiple steps requires an
explicit contract extension rather than an unvalidated recipe workaround.

## Retain several files from a run

An operation registration declares its primary `output` and optional
`additional_outputs`. Each declares a name, format, presentation and role
(`result` or `intermediate`). A recipe must bind the primary output and may bind
any of the additional outputs using `step.output`; the recipe supplies the
labels shown to the user. Output aliases must be unique; `provenance` is reserved.
The recipe's role, type and presentation must match the registered contract.

The native operation returns its usual primary `Artifact`, with completed
`ProducedFile` entries in `additional_outputs`. Each entry identifies a flat
workspace basename and supplies its exact size, checksum, download name and
media type. The operation's preparation must reserve disk for all files it can
produce, including scratch and provenance. YAML cannot increase that reservation.
Adding another recipe that selects these outputs needs no API or UI dispatch.

After native execution exits, the worker binds completed files to the captured
recipe. Storage independently measures sizes and SHA-256 checksums, removes
unretained scratch, writes `manifest.json`, then atomically publishes the whole
directory. Missing or changed declared files fail the run; partial files never
receive download links. File hashing cooperates with cancellation and the worker
waits for publication to stop before cleanup. The final database transition still
checks the attempt, lease and deadline after the directory rename.

Storage permits up to 64 retained files and a 64 KiB inventory. Model YAML
permits up to 32 scientific outputs. A closed workspace may contain up to 128
flat regular files; nested directories, symbolic links, junctions and hard links
are rejected. Basenames must be portable and cannot be filesystem paths or
Windows device names. The exact disk charge includes every retained file and
the inventory itself. Failed attempts retain their reservation until cleanup.

Model status includes an `artifacts` manifest; it is also available from
`GET /api/processing/jobs/{jobId}/artifacts`. Each file has an opaque `artifactId`,
recipe name, label, role, media type, download filename, size, SHA-256 checksum
and a run-scoped URL. `GET`/`HEAD` on
`/api/processing/jobs/{jobId}/artifacts/{artifactId}` supports the existing single
byte-range download behavior. Every request checks the browser session's
ownership and current availability; knowing an ID grants no access. Private
workspace names and filesystem paths are absent from public manifests and YAML.

The run view lists its result and intermediate downloads together. All files
share the run's temporary expiry and deletion lifecycle. Deleting a run prevents
new transfers; existing leases retain the entire directory until those transfers
finish. Ordinary shared calculations keep their subscriber-aware deletion rules
and caller-specific downloads. Named-file endpoints apply only to model runs.
Run YAML retains file names and checksums for its metadata lifetime after the
files expire, without claiming they are still downloadable. There is no live
workspace browsing, per-file deletion, permanent saving or catalog publication.

Existing `/result` and `/provenance` links continue to work, including historical
runs without inventories. Storage still accepts historical primary-only result
metadata, while newly executed jobs publish measured manifests.

## Preview an immutable output

`GET /api/processing/jobs/{jobId}/artifacts/{artifactId}/preview` reads a private
display copy of a completed manifest file. The browser chooses individual files;
models do not automatically put every intermediate on the map. GeoTIFF previews
support one georeferenced numeric band, native NoData and internal validity masks.
GeoJSON previews support a WGS84 `FeatureCollection` containing a single geometry
family: point, line or polygon, including multipart variants. Other file types
remain downloadable. Registered operations may declare `vector` additional
outputs with `application/geo+json` and map presentation; no new native vector
calculation is installed by this display capability.

The response carries `jobId`, `artifactId`, `sha256`, `kind` and WGS84 `bounds`
in west/south/east/north order. Raster responses add `width`, `height` and
row-major `values`, with null cells for invalid data. Their grid is Web Mercator,
using nearest-neighbor sampling and at most 512 × 512 cells. Vector responses add
`geometryKind` and `geojson`; arbitrary properties are omitted from this geometry
preview. Both are display data only, never reusable Processing selections.

The delivery owner authorizes the browser session, run, file and expiry on every
request and holds a transfer lease while native work is running. Rendering
consumes that injected immutable-file contract without importing the Processing
store or worker. It checks the file's published checksum and rechecks access
before returning the preview. HTTP responses use `private, no-store`; there is
no server preview cache. The private results volume is not mounted into GeoServer.
Downloads and computations do not depend on preview availability.

Preview generation admits at most two concurrent reads per API process and has
no waiting queue. Native work is killed after 30 seconds or HTTP disconnection.
Linux native processes have a 2 GiB address-space ceiling; GDAL's cache and warp
buffer are 32 MiB each, decoded source blocks are limited to 64 MiB, and output
JSON is limited to 8 MiB. GeoJSON input is also limited to 8 MiB, 5,000 features
and 100,000 positions. Preview latitudes are limited to Web Mercator's supported
range. These display limits do not change the original file or its download.

The browser retains up to eight display copies in memory, grouped by run identity
and labeled by run name. It revalidates their run/file identities and checksums
every 30 seconds, removes expired displays, and removes displays whose access
cannot be confirmed. Saved/shared map serialization omits private previews and
explains that omission in the UI. It never exports a private artifact reference,
preview bytes, browser credentials or a reusable starting-mask selection.

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
