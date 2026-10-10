# Downstream ecosystem beneficiaries

`downstream-beneficiaries` is an installed Model YAML recipe calling the trusted
`hydrology.downstream_beneficiaries.v1` Processing adapter. It uses the existing
queue, session ownership, cancellation, expiry, worker supervision and published
artifact inventory. It starts no TaskGraph workers or nested jobs. The browser
setup controls for its mask and prepared-hydrology inputs are separate work in
#701; the current browser explains that these controls are unavailable.

## Inputs and results

Select a validated prepared-hydrology report, one starting mask, and one values
raster. The mask is either `{kind: catalogRaster, source: {collectionId, itemId}}`
or `{kind: catalogSelection, selection: ...}` using the normal immutable catalog
selection and filter contract. The values input also accepts the ordinary owned
`runArtifact` reference. All filtered starting features form one combined mask
and one result. The operation accepts no arbitrary paths, Python, expressions
outside the existing scalar grammar, or uploaded job code.

The recipe produces a statistics CSV and retains two ordinary GeoTIFF rasters:
downstream coverage and the starting mask. Both rasters have 1 for included
cells, 0 for excluded cells inside the admitted watershed domain, and NoData 255
outside it. Complete rasters enter the normal source, rendering, styling,
sampling and dependent-model pipelines. There is no new preview renderer.
Provenance records grids, selected watershed IDs, cell counts and numerical rules;
Run YAML additionally records the recipe, build and accepted source signatures.
Routing scratch is removed by normal publication/cleanup and is not a reusable
catalog source.

## Numerical rules

- Terrain uses the original north-up WGS84 DEM grid and stored elevations. The
  model does not fill pits or reproject the DEM. The administrator is responsible
  for preparing elevations suitable for MFD routing.
- A raster starts flow only at positive, finite, valid cells sampled by native
  cell containment at DEM centers. Vector masks use centers inside the combined
  filtered polygons. Expanding downstream partitions never expands the seed mask.
- Original watershed queries use the existing spatial and attribute filters.
  Only intersecting starting partitions and their downstream connections are
  retained. Each real sink is routed separately, so virtual links cannot move
  flow past that sink. Accumulation weights are one at starting cells and zero
  elsewhere. Coverage includes seeds and cells with accumulation above `1e-8`.
- The buffer includes DEM centers within the requested WGS84 ellipsoidal distance
  of reached centers. An optional straight-line cutoff measures distance from
  the original seed centers. Both thresholds are inclusive. Buffers remain inside
  the selected watershed domain. Distances do not use an assumed metres-per-pixel
  conversion on degree grids. This is binary coverage, without attenuation or
  distance decay.
- Values remain on their original grid with no interpolation or resampling.
  Each native value cell contributes once when its center falls inside a covered
  DEM cell. Overlapping starting features and routes never multiply its value.
  Cells outside the values raster and masked, NoData or nonfinite values do not
  contribute. Valid zeros and negative values do contribute. The normal scalar
  evaluator provides `sum(a)` by default and the other area-summary formulas.
  `areaha` measures full covered native value-cell areas using the existing ground
  area calculator. Its coverage boundary is the binary DEM mask, not a subpixel
  intersection with a mathematical buffer. Point-only formulas are rejected.
- Empty or subpixel starting masks and incomplete prepared terrain fail explicitly.
  A covered region without valid values uses the existing `no_valid_data` result.

## Bounds and execution

The initial small-region profile admits at most four million routing cells
summed across terminal groups, four million value cells and four million native
starting-mask cells. It retains at most 100,000 selected watershed records, two
million selected watershed coordinates and 64 real drainage groups. Original
vector stream limits, source block/decoded-byte limits, the configured preparation
deadline, memory ceiling and total run deadline still apply. The buffer is capped
at 100 km and the optional cutoff at 1,000 km. Ambiguous exact-distance comparisons
have a four-million-pair ceiling.

Preparation reserves conservative scratch capacity before routing. The native
operation rechecks its plan and resource limits before allocation. Numerical
libraries and GDAL are configured for one thread per admitted process. Stage
progress identifies mask preparation, routing, buffering, summary and publication.
Explicit cancellation terminates and reaps the existing native process before
the attempt becomes eligible for cleanup. Restarts retain the normal interrupted
state; there is no restart-resume behavior or cross-run result sharing.

### Reproducible resource measurement

`python tests/measure_downstream_resources.py NEW_DIRECTORY --width 2000 --height
2000 --cutoff-metres 50000` runs the production native lane against a generated
eastward slope, three connected basins and a first-column seed mask. With the
pinned EcoShard revision, Python 3.11.14 and GDAL 3.12.1 on Windows, the four-million-
cell case measured 0.094 seconds of preparation, 6.297 seconds of execution
including process startup, 568,475,648 bytes peak resident memory and 3,706,291
bytes peak scratch storage. No descendant processes were observed. Its conservative
disk reservation was 1,158,217,728 bytes. Sampling uses 20 ms intervals and the
platform's peak working-set counter where available.

This synthetic reference establishes a bounded sizing example, not performance
for the administrator's datasets. Complex coastlines, many partitions, storage
latency and different terrain can require more work. The hard admission limits
and supervised deadline remain authoritative. Production CI separately builds
and tests the pinned Linux/Python 3.12/GDAL 3.10 environment.

## Algorithm and build provenance

The starting workflow was reviewed at
[`wwf_es_beneficiaries` revision 7e32ae2](https://github.com/springinnovate/wwf_es_beneficiaries/tree/7e32ae28540ab53178248758a6f40affea8d6ff6).
EOlab calls the MFD direction and weighted-accumulation kernels from
[`ecoshard` revision f7e2adb](https://github.com/springinnovate/ecoshard/tree/f7e2adba2a4d41128aea941bb747470418d2dce9),
whose archive and runtime/build dependencies are hash-locked. Its `LICENSE.txt`
contains BSD-3-Clause notices for the inherited components and Apache-2.0 terms
for later contributions. The package and its notices remain in the built wheel. This revision is compatible
with EOlab's GDAL 3.10 pin; newer upstream revisions assume GDAL 3.11 datatypes.
The external workflow orchestrator is not imported or copied into EOlab.

The application build compiles EcoShard beside GDAL from the reviewed archive,
using the fixed distribution version `0.7.0+gf7e2adba2a4d`. Application build
inventory and model implementation checksums include installed numerical packages.
YAML selects this reviewed operation; it cannot choose a different source revision.

## Resilience configuration

[resilience-hydrology.yaml](model-examples/resilience-hydrology.yaml) contains the
actual catalog IDs found for `astgtm_compressed.tif` and
`merged_lev06_repaired.gpkg — merged_lev06` on the Resilience instance. Use
`HYBAS_ID` as the connection identity, `NEXT_DOWN` as the next link, and stop when
`NEXT_SINK == HYBAS_ID`. `ID` and `MAIN_BAS` are not used.

Run the [administrator validator](prepared-hydrology.md) against those original
mounted files before installing the report. This repository does not include a
fabricated validation report. Catalog metadata reports watershed coverage to
83.6256° N but DEM coverage only to approximately 83.0001° N. A global validation
may therefore fail and require a smaller complete watershed network within valid
terrain. Do not bypass coverage checks or silently trim a downstream drainage.
Global validation also needs appropriately configured administrator work budgets;
regional model execution retains only the selected drainage polygons.
