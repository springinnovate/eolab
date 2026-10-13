# Downstream ecosystem beneficiaries

`downstream-beneficiaries` version **4.0.0** wraps the original
[WWF workflow at 3f577e27deb347cd4520977eb99474fb81e990fc](https://github.com/springinnovate/wwf_es_beneficiaries/tree/3f577e27deb347cd4520977eb99474fb81e990fc).
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

Open **Tools > Models** to choose the starting mask, values raster and parameters.
The installed Model YAML supplies the DEM and watershed layer. See the [setup guide](model-library.md#set-up-downstream-analysis).

## Inputs and results

Choose one starting mask and a values raster. A raster mask
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

Version 3.0.0 passes `treat_nodata_as_closed=True` and
the configured `max_pixel_fill_count` (1000 by default) to the WWF workflow's
existing pit-filling step.
During filling, NoData holes and the outer raster boundary cannot serve as
drains. The cutoff is EcoShard's existing per-search exploration budget, not
an exact maximum number of changed elevations or a lake-size classification.
When the search gives up, the unresolved depression remains. NoData pixels
are unchanged. MFD still uses its original downhill and NoData-fallback rules;
this does not force every flow path to the ocean or a selected terminal basin.

To change the search budget, set
`EOLAB_PROCESSING_DOWNSTREAM_PIT_FILL_SEARCH_LIMIT=10000` in Coolify and redeploy
the app and worker. Missing or blank values use the code default of 1000;
`-1` or `0` means unlimited search. The worker captures this setting when it
prepares a run, then records it in the run plan, numerical policy, provenance and
Run YAML. Changing the setting does not rewrite completed runs. Redeployment
interrupts unfinished runs under the existing worker restart policy.

For a matching standalone WWF run, add these options under `inputs` in its YAML,
using the search budget recorded for the EOlab run (1000 here):

```yaml
max_pixel_fill_count: 1000
treat_nodata_as_closed: true
```

Existing WWF configurations that omit them retain unlimited, open-edge filling.
New EOlab runs record these settings and both dependency revisions in their
provenance and Run YAML. Rerun a model to inspect the newly conditioned routing
DEM; files and recorded policies from older runs are not rewritten.

Default `sum(a)` returns the exact total from upstream
`mask_population_with_coverage`, including zero when no positive values contribute.
Other formulas are **EOlab postprocessing of the upstream masked-values output**.
They do not alter coverage or the original total.

Version 1.0.0 used the replaced EOlab calculation. Historical numerical policies
remain readable, including the version-2 open-edge WWF policy. New runs record
version-3 policy and upstream revisions. Recipe
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

The calculation uses EcoShard revision
`6bd106862a2cb2517f91f9bd7ca8bb071ccb6013`, which includes the optional closed-edge
flag and keeps optional Float16 types compatible with the application's GDAL 3.10.
Its declared `filelock` dependency is included in the runtime wheel lock.
Runtime wheels have reviewed hashes.
The application build verifies imports; model checksums and build inventory record
numerical package versions. Revision changes require a reviewed build change.

For native development, run `python deployment/build-beneficiaries.py --manifest
deployment/beneficiaries-source.json --output /tmp/beneficiaries-wheels`, install
the generated wheels, then install EOlab.

`tests/test_downstream_upstream.py` invokes the original CLI separately with
independently prepared inputs and the same pit-filling options. It requires exact coverage, masked values and each
drainage group's pit-filled routing DEM pixels,
validity masks, CRS, transforms, dimensions, types, NoData and total equality.
Cases cover buffer/cutoff, resampled signed/NoData values, filtered vector starts,
multiple drainages, virtual links and a depression beside the raster edge.
Worker tests retain publication, Run YAML,
actual native cancellation, worker recovery and large-grid planning coverage.

## Resilience configuration

The bundled [Model YAML](model-examples/downstream-beneficiaries.model.yaml)
contains the Resilience catalog DEM and level-06 watershed references under
`steps[0].inputs.hydrology.value`. It maps `HYBAS_ID`, `NEXT_DOWN` and `NEXT_SINK`;
`ID` and `MAIN_BAS` do not participate in upstream calculations. See
[model hydrology configuration](prepared-hydrology.md) for deployment instructions.

There is no registration report or hydrology suitability preflight. A run opens
the current configured sources and lets the original model use them. Missing or
unreadable sources fail at access with the affected input identified. Source
consistency within a run, catalog authorization and ordinary job lifecycle checks
remain enforced. Historical Run YAML registration records remain readable.
