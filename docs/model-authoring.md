# Add a model recipe

A model is an installed YAML recipe. It describes the setup form, binds inputs
and parameters to a registered operation, and names its outputs. A run is a
separate, session-owned job containing a captured recipe and input choices.

## Reuse an operation

Add a `.yaml` file to [`processing/recipes/`](../src/eolab_app/processing/recipes/), then build and deploy
the application and worker together. All files in that directory are discovered
and validated at startup. There is no recipe-name dispatch in the API, worker
or result view, and no database migration or JavaScript change is required for
a new recipe using supported inputs, parameters and outputs.

Start with `raster-summary.yaml` or `raster-clip.yaml`. Use a distinct model ID
and semantic version. Input and parameter names belong to the recipe; the keys
under a step's `inputs` and `parameters` belong to the operation:

```yaml
inputs:
  habitat: {type: raster, label: Habitat raster}
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
| `raster.aggregate.v1` | `raster: raster`, `area: summary_area` | `expression: summary_expression` | `statistics`, type `statistics`, presentation `table`, CSV | `raster-summary` |
| `raster.clip.v1` | `raster: raster`, `area: clip_area` | None | `raster`, type `raster`, presentation `map`, GeoTIFF | `raster-clip` |
| `hydrology.downstream_beneficiaries.v1` | `starting_mask: mask_source`, `hydrology: fixed Model YAML value`, `values: raster` | `buffer_m: number`, `cutoff_m: optional_number`, `summary: summary_expression`, `wgs84_pixel_size: number`, `travel_time_pixel_size_m: number` | Statistics CSV; masked values, coverage, starting mask and per-drain routing DEM GeoTIFFs | `downstream-small-region` |

The `raster` input accepts either the existing `{collectionId, itemId}` catalog
reference or `{kind: runArtifact, jobId, artifactId}` for an owned published
GeoTIFF. Historical `catalog_raster` declarations remain valid and continue to
accept only catalog data; their saved recipes and checksums are not rewritten.
Bundled recipes use version 1.1.0 for the expanded input contract.

A summary recipe can rename its formula parameter and change its default, such
as `mean(a)` or `stdev(a)`. Formula syntax and area support remain governed by
the registered operation. The execution profile must match the operation's
registered profile; it is a compatibility check, not a calculation resource
budget. Processing has no application-imposed ceiling on calculation size,
memory, disk use or total planning/execution time. The `downstream-small-region`
profile name remains for compatibility and does not impose an area limit.
Worker concurrency, cancellation, source checks and output integrity still apply.

The current runner accepts one step, with inputs declared by its registered
operation. Recipes can retain multiple outputs declared
by that operation, plus provenance. The bundled summary and clip operations
currently each produce one scientific result. `map` and
`saveEligible` describe output capabilities; map display and permanent saving
are separate capabilities. Temporary map display is available; permanent saving
and YAML import from the browser are not yet available.

The downstream model prepares a separate DEM for each terminal drainage group
(watersheds grouped by their final drain). A starting area can reach several
groups, so the number of DEMs is known only when the model runs. Each file is kept
separately to preserve the exact grid and NoData edges used for routing.

A recipe selects all those DEMs with one output declaration:

```yaml
outputs:
  routing_dem:
    source: analysis.routing_dem
    type: raster
    label: Routing DEM (pit-filled)
    role: intermediate
    presentation: map
    saveEligible: true
```

The registered operation declares `multiple_files=True` for this output so the
recipe can retain every DEM without listing drain IDs in advance. Each file
keeps its unique operation-supplied name and adds its drain label to the recipe
label, such as `Routing DEM (pit-filled) · Drain 6060506430`. The existing run-file
view supplies download and Show on map controls for each file; it does not need
to interpret drainage groups. Single-file outputs still use their recipe aliases,
and files not belonging to a declared operation output are rejected.

## Reuse a published raster

Only immutable manifest entries declared as scientific `result` or `intermediate`
with `image/tiff` format are eligible, including a retained starting-mask GeoTIFF.
Transient preparation masks, filtered geometry, scratch files and provenance are
not input sources. Admission rechecks ownership, ready
status, expiry, file ID, checksum and byte count under the same database lock that
accepts the job. A prior metadata lookup alone confers no access.

Processing schema version 18 adds input grants tied to accepted computations,
separate from short download leases. Expiry and explicit parent deletion reject
new uses immediately; accepted children keep their original inputs. Cleanup waits
for all children to stop. Each job can reference at most 16 input files
(current operations use one). Processing does not estimate disk usage or reject a
child because of retained parent files; ordinary filesystem failures are reported
by the worker. The same worker-count queue applies to catalog and private inputs.

Success, failure, queued cancellation and acknowledged running cancellation release
grants transactionally. A lost heartbeat alone does not free files or worker slots.
Linux native processes stop when their supervisor dies. Supported worker restart
first stops the previous container, then interrupts unfinished jobs and releases grants.
Ordinary physical cleanup releases disk accounting only after file removal.

The worker resolves original files through the grant and confined artifact storage,
checks their SHA-256 in a supervised process without a total-runtime deadline,
then uses the same native
planning and execution adapters as catalog rasters. Run YAML retains upstream
run/file references, checksum and byte count; prepared calculation provenance adds
the source checksum. Public and persisted specifications contain no filesystem paths.

Private submissions do not join shared active computations. Ordinary summary cache
keys include the run/file reference, verified checksum and source signature; each
use requires a fresh accepted grant and integrity check, even on a cache hit.
Identical bytes do not grant another session access. Catalog sharing and cache
behavior remain unchanged, and Models still execute fresh. No renderer, preview,
map visibility or GeoServer availability is involved.

The ordinary aggregate API accepts the same reference in `sources`. The clip API
accepts it in `source`, while preserving historical flat `collectionId`/`itemId`
requests. This is explicit reuse of an already completed file, not automatic
execution of dependent recipes or permanent storage.

## Add a new algorithm

The downstream DEM, watershed source and topology mappings are configured in
`steps[0].inputs.hydrology.value`, using catalog identities. The downstream
operation owns this configuration schema, its starting-mask input schema and
historical report parsing. Generic model binding uses the schemas and validation
callbacks declared by the operation registration. See
[model hydrology configuration](prepared-hydrology.md) for deployment instructions.
Model setup presents the starting mask, values and calculation parameters to the
user. Saved Run YAML captures the configuration and preserves historical reports.

YAML selects trusted capabilities; it does not contain Python import paths or
execute arbitrary code. A genuinely new algorithm needs a registered operation
in [`processing/model_operations.py`](../src/eolab_app/processing/model_operations.py),
with its adapters in the owning Processing module.
[`processing/raster_operations.py`](../src/eolab_app/processing/raster_operations.py)
contains the existing raster adapters.

The registration declares input/parameter types, queued and prepared schemas,
request binding, source identity, owned polygon capture, preparation, native
execution, numerical policy, result metadata and retained Run YAML outcome.
Operations can declare fixed-input schemas for recipe values, adapters for their
input types and validation for their saved metadata. The owning operation checks
those values; the generic runner binds and stores the validated result.
Ordinary summary cache behavior is also registered. Model runs execute afresh
and do not join ordinary shared calculations or reuse their scalar cache.

Each operation supplies `progress_descriptions` as native phase/description pairs
on its registration. Descriptions are plain text, contain non-whitespace content
and may use up to 200 Unicode characters. The Models status response adds the
optional `progress.description` alongside the existing phase and measured counts;
the browser displays it without recognizing algorithm stages. Unknown phases and
older responses without a description display **Running model**. Native code uses
the existing `write_progress(..., unit=...)` contract for its actual work units:
raster operations count blocks, while downstream routing and buffering count
drainage groups. These are current-stage counts, not an overall percentage.
Ordinary clip/summary job presentation keeps its existing separate contract.

The worker continues to own authorization, concurrency, attempt fencing,
cancellation, restart recovery and atomic file publication. A worker slot stays
occupied until its native process exits. Result expiry and renewable worker
leases govern retention and ownership; they are not calculation deadlines.
Native kernels and storage adapters do not import recipe definitions or inspect
model IDs.
Registered numerical policy reports what the implementation actually did;
YAML cannot claim different resampling or inclusion rules. The registered
additional-source contract already supports the downstream operation's sources.
New input controls or multi-step execution require explicit contract extensions
rather than unvalidated recipe workarounds.

Choose the extension point according to what the new model needs:

| Change | Existing extension points and limitations |
| --- | --- |
| Another recipe using supported capabilities | Add an installed YAML recipe; [`ModelRegistry` and `validate_operation`](../src/eolab_app/processing/model_definitions.py) validate its bindings against the registered operation. No recipe-specific API, worker or browser dispatch is needed. |
| A new algorithm | Implement the operation and its owned adapters, then register its input, execution and output contracts in [`model_operations.py`](../src/eolab_app/processing/model_operations.py). YAML alone cannot add executable behavior. |
| A new input type or independently chosen raster inputs | Extend the owning operation's input contract and the supported browser capture/form behavior in [`models/inputs.js`](../frontend/src/models/inputs.js) and [`models/view.js`](../frontend/src/models/view.js). The current form captures one primary raster choice plus a supported area or starting mask; merely adding named raster declarations does not create independent raster choices. |
| Another file of a supported output type | Declare it on the operation and select it in the recipe, as described below. A file collection uses `multiple_files=True`. |
| A new output type | Extend the backend result contract and browser validation/presentation described under [Reuse an output type](#reuse-an-output-type). A new media type does not automatically gain map display or model-input support. |

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
media type. Processing writes the requested files without estimating or reserving
a maximum disk footprint; actual filesystem failures are reported by the worker.
Adding another recipe that selects these outputs needs no API or UI dispatch.

After native execution exits, the worker binds completed files to the captured
recipe. Storage independently measures sizes and SHA-256 checksums, removes
unretained scratch, writes `manifest.json`, then atomically publishes the whole
directory. Missing or changed declared files fail the run; partial files never
receive download links. File hashing cooperates with cancellation and the worker
waits for publication to stop before cleanup. The final database transition still
checks the current attempt, live worker lease and running status after the
directory rename, so cancelled or superseded work cannot become a ready result.

Retained file inventories have no fixed file-count or byte ceiling, so an output
collection can grow with the calculation's drainage groups. For example, 64
drainage groups produce 64 DEMs plus the run's other outputs. The browser accepts
the full inventory and validates each file rather than rejecting the completed
run at a fixed file count. Model YAML still
permits up to 32 logical scientific outputs. A closed workspace contains only
flat regular files; nested directories, symbolic links, junctions and hard links
are rejected. Basenames must be portable and cannot be filesystem paths or
Windows device names. The exact disk charge includes every retained file and
the inventory itself. Failed attempts remain owned by Processing until cleanup.

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
New model submissions request at least seven days of retention for both files
and saved details through the neutral job plan. Longer deployment result or
metadata lifetimes are preserved and captured at submission. Successful runs use
one expiry for both; ordinary clips and statistics keep their existing policy.

`POST /api/processing/jobs/{jobId}/renew` retains an available completed model
run until at least seven days from the request. It uses the same browser cookie,
same-origin mutation header and public job response as existing Processing
actions. Renewal refreshes that cookie without changing ownership, aligns file
and metadata expiry, preserves later deadlines and does not copy files or change
their checksums. Renewal cannot revive expired/deleted runs or expired details.
Repeated requests renew from the present time, not the previous deadline.
`DELETE /api/processing/jobs/{jobId}` remains the run-wide deletion operation;
accepted readers keep their existing protections until they finish.
Models requests `DELETE /api/processing/jobs/{jobId}?undo=true` to offer a
30-second Undo window. The run immediately disappears from history and rejects
new access. Its response includes `deletionUndo: {deletionId, expiresAt}` until
that window ends. `POST /api/processing/jobs/{jobId}/deletion/undo` restores the
exact deletion, and `/deletion/dismiss` ends its Undo window early. Both accept
`{deletionId}`, use the usual owner cookie and same-origin mutation protections,
and return the current model job. Repeated deletes preserve the original
deadline; repeated Undo is idempotent. An old deletion ID cannot act on a later
deletion of the same run. Omitting `undo=true` preserves immediate deletion.

Schema 20 records each subscriber's deletion identity, deadline and previous
cancellation state. Cleanup retains ready files and their storage charge during
Undo, without extending their original expiry. Dismissal and timeout release
that hold; accepted input grants and transfers still protect existing readers.
Undo may restore expired history but cannot revive expired files or metadata.
These transitions use the existing lifecycle lock and job-change notifications.

Schema 19 adds a nullable captured result lifetime. Historical rows keep their
existing deadlines until explicitly renewed; ordinary jobs use the unchanged
deployment result setting. Renewal, expiry and deletion share the lifecycle
transaction lock. Updated deadlines produce the existing job-change hints, and
rendering checks current source availability through its existing interface.
Neither renewal nor deletion requires GeoServer availability.
Run YAML retains file names and checksums for its metadata lifetime after the
files expire, without claiming they are still downloadable. There is no live
workspace browsing, per-file deletion, permanent saving or catalog publication.

Existing `/result` and `/provenance` links continue to work, including historical
runs without inventories. Storage still accepts historical primary-only result
metadata, while newly executed jobs publish measured manifests.

## Show an immutable output on the map

The user chooses individual files with **Show on map**; models do not
automatically display every intermediate. GeoTIFFs use ordinary raster rendering,
while GeoJSON files use a bounded geometry preview. Other file types remain
downloadable. The browser routes these choices in
[`ModelOutputLayers`](../frontend/src/model-output-preview/controller.js).

### GeoTIFF: ordinary raster rendering and original-source analysis

The browser describes the original `{kind: runArtifact, jobId, artifactId}` source,
checks its version against the manifest checksum and adds it through the common
raster controller. The normal GeoServer publication, tile and styling pipeline
displays the retained GeoTIFF. GeoServer receives a read-only `/processing-data`
mount; the [publication service](../src/eolab_app/raster/publication.py) checks
private-source access and cleans up expired publications. It does not copy a
sampled JSON preview into a separate raster renderer.

Pixel reads, statistics and reuse as a model input read the original raster
through their own source-access contracts. They do not require map visibility,
GeoServer publication or a successful display preview. Private source access
continues to enforce session ownership, file identity and expiry. Interactive
metadata/statistics readers hold renewable leases and verify checksums; short
pixel requests use the separate short-read contract. See
[private raster access](raster-analysis.md#catalog-rasters-and-private-run-files)
and [temporary raster map delivery](raster-analysis.md#temporary-raster-map-delivery)
for the reader budgets and rendering lifecycle.

### GeoJSON: a display-only geometry preview

`GET /api/processing/jobs/{jobId}/artifacts/{artifactId}/preview` supplies the
GeoJSON map display. It accepts a WGS84 `FeatureCollection` containing a single
geometry family: point, line or polygon, including multipart variants. Registered
operations may declare `vector` additional outputs with `application/geo+json`
and map presentation; this does not install a native vector calculation.

The response carries `jobId`, `artifactId`, `sha256`, `kind`, WGS84 `bounds` in
west/south/east/north order, `geometryKind` and `geojson`. Arbitrary properties are
omitted. The browser displays this geometry through its vector map adapter; the
preview does not become a catalog source or a reusable Processing selection.

The preview endpoint authorizes the session, run, file and expiry on every
request. Its immutable-file access scope verifies the published checksum,
holds a renewable transfer lease while native work runs and rechecks access
before returning. HTTP responses use `private, no-store`; there is no server
preview cache. Downloads and calculations do not depend on preview availability.

### Legacy raster JSON preview endpoint

The same `/preview` endpoint still accepts GeoTIFFs, although the current browser's
GeoTIFF **Show on map** path does not call it. This supported implementation remains
in [`rendering/artifact_preview.py`](../src/eolab_app/rendering/artifact_preview.py);
its removal is a separate compatibility decision. It reads one georeferenced
numeric band, respecting native NoData and internal validity masks. Raster
responses include `width`, `height` and row-major `values` with null invalid
cells. The sampled grid is Web Mercator, uses nearest-neighbor resampling and is
at most 512 × 512 cells. These display values are not a reusable Processing input.

### Preview budgets and temporary map layers

The `/preview` endpoint admits at most two concurrent reads per API process and has
no waiting queue. Shared checksum verification separately admits two checks with
a 30-second deadline. Native preview work is killed after 30 seconds or HTTP
disconnection. The file lease renews every 10 seconds until reading stops.
Linux native processes have a 2 GiB address-space ceiling; GDAL's cache and warp
buffer are 32 MiB each, decoded source blocks are limited to 64 MiB, and output
JSON is limited to 8 MiB. GeoJSON input is also limited to 8 MiB, 5,000 features
and 100,000 positions. Preview latitudes are limited to Web Mercator's supported
range. These endpoint-specific limits do not apply to ordinary GeoTIFF tile
delivery or impose ceilings on Processing calculations. They do not change the
original file or its download.

The browser allows up to eight temporary output map layers, including pending
additions, across raster and vector outputs. Layers are grouped by run identity
and labeled by run name. It revalidates their run/file identities and checksums
every 30 seconds, removes expired displays, and removes displays whose access
cannot be confirmed. Saved/shared map serialization omits private output layers and
explains that omission in the UI. It never exports a private artifact reference,
preview bytes, browser credentials or a reusable starting-mask selection.

## Reuse an output type

Model job responses carry `kind`, `name`, `label`, `role`, `presentation` and
`mediaType` alongside owned download metadata. `name` and `label` are captured
from YAML when the run starts, so results keep their names even after the
recipe is removed or saved setup metadata expires. Raster result grids expose
file dimensions, CRS, datatype and affine transform. Run YAML records the captured
invocation, prepared grid and execution outcome separately from this shared file
result contract. The [historical Run YAML example](model-examples/raster-summary.run.yaml)
preserves old execution-limit fields for round-trip compatibility; those fields
do not describe current calculation policy.

[`processing/model_result_contracts.py`](../src/eolab_app/processing/model_result_contracts.py)
validates backend output types.
[`processing/model-results.js`](../frontend/src/processing/model-results.js) validates
browser responses and [`models/result-view.js`](../frontend/src/models/result-view.js)
presents those types. These modules need
changes only for a genuinely new result type, not another recipe producing a
supported raster or statistics table. Ordinary raster clip and summary API
response contracts are unchanged. Historical model records without output
descriptors are normalized at the backend serialization boundary.

Primary model results currently support `raster` and `statistics`. A declared
additional GeoJSON file can use `vector` and map presentation; that support does
not make `vector` a supported primary result type.

## Verify a recipe

Load it through [`ModelRegistry`](../src/eolab_app/processing/model_definitions.py),
round-trip exported Model YAML, submit it
through the Models API, run the actual operation, and check its downloads and
Run YAML. Tests use unfamiliar model IDs, renamed input/parameter bindings and
custom output names to verify that no application code recognizes the recipe
by name. See the executable [recipe and historical-export tests](../tests/test_model_definitions.py).
Keep numerical, source-staleness, ownership and cancellation tests with the
operation that owns those rules. Preserve interactive reader budgets separately
from Processing's unlimited calculation work.
