# Downstream ecosystem beneficiaries

`downstream-beneficiaries` version **2.1.0** wraps the original
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
diagnostic, routing DEMs, statistics CSV, provenance and Run YAML. Rasters use ordinary EOlab
rendering, styling, sampling and model-input pipelines. Scratch remains run-owned
and is removed after calculation or by failed/cancelled-attempt cleanup.

In a completed run, find **Routing DEM (pit-filled) · Drain …** under **Files from
this run** and choose **Show on map** or **Download**. This is the exact elevation
file passed to the original model's MFD routing, after clipping to the drainage
polygons, resampling to the calculation pixel size and filling pits. Its NoData
edge is preserved, so it can help explain where a downstream trace stops.

Separate drainage groups keep separate DEM files, identified by terminal drain ID;
EOlab does not mosaic or resample them again. These intermediate rasters use the
same styling, pixel picking, model-input access, seven-day expiry, renewal and
deletion controls as other run rasters. They are retained by the recipe's
`analysis.routing_dem` output. Older completed runs have already discarded their
DEM scratch files and must be rerun to inspect them. Version 2.1.0 adds these files
without changing the original calculations.

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

Processing attempts the requested calculation without cell, geometry, memory,
disk or total-runtime ceilings. It does not estimate those resources, scan DEM
pixels before execution, or reopen upstream partitions to size their work.
The old `EOLAB_PROCESSING_DOWNSTREAM_MAX_*` settings are ignored and can be
removed from Coolify. Buffer and cutoff inputs must be finite and nonnegative
(the optional cutoff must be positive); there is no arbitrary distance ceiling.

Worker concurrency remains configurable through `EOLAB_PROCESSING_WORKER_COUNT`.
Cancellation stops and joins the native child before releasing its slot. Linux
kills native children when their supervisor dies. Replacing the single worker
container interrupts unfinished runs after its predecessor stops; completed
outputs remain subject to normal ownership and expiry. Actual OS or filesystem
failures are reported by the worker rather than predicted through admission.

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
independently prepared inputs. It requires exact coverage, masked values and each
drainage group's pit-filled routing DEM pixels,
validity masks, CRS, transforms, dimensions, types, NoData and total equality.
Cases cover buffer/cutoff, resampled signed/NoData values, filtered vector starts,
multiple drainages and virtual links. Worker tests retain publication, Run YAML,
actual native cancellation, worker recovery and large-grid planning coverage.

## Resilience configuration

[resilience-hydrology.yaml](model-examples/resilience-hydrology.yaml) identifies the
catalog DEM and watersheds. Configure `HYBAS_ID`, `NEXT_DOWN` and `NEXT_SINK`;
`ID` and `MAIN_BAS` do not participate in upstream calculations. See
[prepared-hydrology.md](prepared-hydrology.md) for installation. This wrapper does
not change that contract. Registration-only and both validation-report versions
remain supported. Installation checks source metadata; each run checks the
selected drainage and its DEM coverage, so unrelated basins outside a regional
DEM do not prevent installation.
