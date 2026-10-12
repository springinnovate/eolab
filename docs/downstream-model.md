# Downstream ecosystem beneficiaries

`downstream-beneficiaries` version **2.0.0** wraps the original
[WWF workflow at 7e32ae28540ab53178248758a6f40affea8d6ff6](https://github.com/springinnovate/wwf_es_beneficiaries/tree/7e32ae28540ab53178248758a6f40affea8d6ff6).
Its source is packaged byte for byte. Processing calls the original partitioning,
DEM preparation, flow routing, conditional coverage, stitching and population
masking functions in their original order, sequentially in the existing supervised
native process. It does not start the upstream TaskGraph scheduler inside a worker.

The wrapper temporarily uses the private attempt as the native process's current
directory, containing upstream helpers that create relative scratch files. The
application and input mounts remain read-only; the prior directory is restored
on success or failure.

The existing queue, progress, explicit cancellation, source authorization, session
ownership, expiry and artifact publication still own the run. There is no new
renderer, pixel reader or job scheduler.

Open **Tools > Models** to choose the starting mask, prepared hydrology, values
raster and parameters. See the [setup guide](model-library.md#set-up-downstream-analysis).

## Inputs and results

Choose prepared hydrology, one starting mask and a values raster. A raster mask
passes unchanged to the original conditional calculation with `value > 0`.
Filtered vector features become one combined AOI and a binary mask on the chosen
calculation grid. Paths and geometries stay private to the attempt.

A private OGR view maps configured integer ID fields to `HYBAS_ID`, `NEXT_DOWN`
and `NEXT_SINK`, leaving IDs, links and geometries unchanged. Upstream controls
traversal and grouping, including virtual downstream links.

| Model field | Original setting | Default |
| --- | --- | ---: |
| Calculation pixel size | `wgs84_pixel_size` | 0.008333333333333 degrees |
| Pixel size used for distances | `travel_time_pixel_size_m` | 900 m |
| Buffer radius | `buffer_size_m` | 5000 m |
| Maximum straight-line distance | `max_downstream_distance_m` | No cutoff |

Pixel-size defaults come from the upstream example. They are explicit settings,
not inferred from the DEM. Compare standalone runs using identical settings,
inputs and AOIs.

Retained outputs are original coverage and masked-values GeoTIFFs, a starting-mask
diagnostic, statistics CSV, provenance and Run YAML. Rasters use ordinary EOlab
rendering, styling, sampling and model-input pipelines. Scratch remains run-owned
and is removed after calculation or by failed/cancelled-attempt cleanup.

## Numerical behavior

The original functions define DEM resampling, pit filling, MFD flow, accumulation
convolution with a pixel-based circular buffer, distance cutoff, threshold order,
stitching, nearest-neighbor value resampling, positive-value inclusion and NoData.
EOlab does not substitute native-grid totals, geodesic distances or new routing.

Default `sum(a)` returns the exact total from upstream
`mask_population_with_coverage`, including zero when no positive values contribute.
Other formulas are **EOlab postprocessing of the upstream masked-values output**.
They do not alter coverage or the original total.

Version 1.0.0 used the replaced EOlab calculation. Historical numerical policies
remain readable. New runs record version-2 policy and upstream revision. Recipe
version and implementation checksums change so stale selections and queued
implementations cannot silently execute new math.

## Resources and performance

Existing source, geometry, memory, work, disk and time safeguards remain. These
conservative admission estimates are **not measurements of upstream requirements**;
they can still reject work that standalone upstream could run. Changing that
policy is separate work. Checks also cover actual upstream partitions, output
resolution and buffer allocation, rejecting oversized work without altering math.

`DownstreamLimits` owns defaults; Compose only forwards optional overrides.
Recreate both app and worker containers after changing deployment settings.

| Deployment override | Default |
| --- | ---: |
| `EOLAB_PROCESSING_DOWNSTREAM_MAX_ROUTING_CELLS` | 4000000 |
| `EOLAB_PROCESSING_DOWNSTREAM_MAX_VALUE_CELLS` | 4000000 |
| `EOLAB_PROCESSING_DOWNSTREAM_MAX_MASK_CELLS` | 4000000 |
| `EOLAB_PROCESSING_DOWNSTREAM_MAX_WATERSHEDS` | 100000 |
| `EOLAB_PROCESSING_DOWNSTREAM_MAX_WATERSHED_COORDINATES` | 2000000 |
| `EOLAB_PROCESSING_DOWNSTREAM_MAX_TERMINALS` | 64 |

Omit `EOLAB_` for direct worker deployments. Historical
`PROCESSING_DOWNSTREAM_MAX_DISTANCE_PAIRS` remains accepted for configuration
compatibility; upstream does not use the former geodesic-pair calculation.
Existing request caps of 100 km buffer and 1000 km cutoff remain. Cell overrides
do not increase memory, storage, source-reading or execution-time budgets.

EOlab adds preparation/rechecks, progress, checksums and publication overhead.
Partitions execute sequentially; the standalone CLI can parallelize via TaskGraph.
EOlab does not read DEM pixels in a separate validation pass before the original
model runs. Terrain values, NoData and masks are handled by the original model.
Measure representative data before claiming equal end-to-end runtime. Small
parity fixtures print direct CLI, EOlab preparation and wrapped wall time. Earlier
benchmarks of the removed implementation do not describe this wrapper.

## Build and verification

`deployment/beneficiaries-source.json` pins source revision and archive SHA-256.
`deployment/build-beneficiaries.py` verifies the archive and adds only packaging
metadata around unchanged `workflow_runner.py` and the original
`shortest_distances` extension. Installed provenance includes the runner checksum.
Application and disposable PostgreSQL images use this same builder.

The calculation uses the existing reviewed EcoShard revision
`f7e2adba2a4d41128aea941bb747470418d2dce9`. Runtime wheels have reviewed hashes.
The application build verifies imports; model checksums and build inventory record
numerical package versions. Revision changes require a reviewed build change.

For native development, run `python deployment/build-beneficiaries.py --manifest
deployment/beneficiaries-source.json --output /tmp/beneficiaries-wheels`, install
the generated wheels, then install EOlab.

`tests/test_downstream_upstream.py` invokes the unchanged CLI separately with
independently prepared inputs. It requires exact coverage and masked pixels,
validity masks, CRS, transforms, dimensions, types, NoData and total equality.
Cases cover buffer/cutoff, resampled signed/NoData values, filtered vector starts,
multiple drainages and virtual links. Worker tests retain publication, Run YAML,
actual native cancellation and resource-budget coverage.

## Resilience configuration

[resilience-hydrology.yaml](model-examples/resilience-hydrology.yaml) identifies the
catalog DEM and watersheds. Configure `HYBAS_ID`, `NEXT_DOWN` and `NEXT_SINK`;
`ID` and `MAIN_BAS` do not participate in upstream calculations. See
[prepared-hydrology.md](prepared-hydrology.md) for installation. This wrapper does
not change that contract. Registration-only and both validation-report versions
remain supported. Installation checks source metadata; each run checks the
selected drainage and its DEM coverage, so unrelated basins outside a regional
DEM do not prevent installation.
