# Prepared hydrology datasets

A prepared hydrology configuration pairs an existing catalog DEM with a complete
watershed network. The DEM may cover only part of that network; each run must
have complete terrain coverage for the downstream watersheds it uses. The
configuration names the fields that connect watersheds and records how
the terrain was prepared. It is separate from Model YAML: the same model can use
different regional datasets without changing its recipe.

The administrator validates each configuration explicitly and installs the
resulting report. Model setup can discover these reports through the Processing
API. Opening setup does not scan a DEM or rebuild a network. The
[downstream model](downstream-model.md) executes through Processing. Its Models
setup lists the installed configurations and rechecks the selected sources before
enabling Run; terrain and topology details are expandable in the same panel.

## Administrator setup

1. Prepare the DEM and complete watershed network externally, place them in the
   existing read-only source mount, and scan them into the catalog. The DEM must
   be a north-up, single-band numeric GeoTIFF with embedded georeferencing and
   validity. Watersheds use the existing GeoPackage or Shapefile catalog support.
2. Copy [the configuration example](model-examples/prepared-hydrology.yaml).
   Replace its catalog IDs, field mappings, title and preparation provenance.
   A vector catalog Item identifies its exact native layer; no file paths occur
   in this YAML. Include **all downstream partitions**, even when they cross
   administrative boundaries.
3. Run the validator with the deployment's source mount and catalog. For example,
   with the catalog already running and a host setup directory containing the YAML:

   ```sh
   docker compose run --rm --no-deps \
     --volume /absolute/host/hydrology-setup:/hydrology \
     app python -m eolab_app.hydrology_cli /hydrology/region.yaml \
       --catalog-url http://stac-api:8080 \
       --scan-mount /scan-source \
       --output /hydrology/region.hydrology.json
   ```

   Validation reads original files without editing them. A successful command
   atomically writes the report. An invalid configuration, changed source,
   exhausted budget or cancellation leaves an existing report untouched and
   exits unsuccessfully. Run against the same mounted files as the application;
   copying files to a different filesystem can change their source identities.
4. Place the completed `*.hydrology.json` reports in a directory available to the
   app, such as `/scan-source/config/hydrology`. Set
   `EOLAB_PREPARED_HYDROLOGY_DIRECTORY=/scan-source/config/hydrology` in Compose
   and redeploy the app. The directory remains read-only in the app. Direct
   deployments use `PREPARED_HYDROLOGY_DIRECTORY`.

Leaving the setting blank installs no configurations and preserves normal
summary/clip models. An explicitly configured missing directory, invalid report,
duplicate ID/version or mismatched checksum fails app startup with a diagnostic.
There is no fixed maximum number of installed configurations. Each report is
bounded by the existing 256 KiB Run YAML/JSON parser limits.

Raw YAML edits take effect only after validation and installation of the new
report. Use a new semantic version for intentional dataset/configuration changes.
The effective SHA-256 also changes when any configuration, source signature or
validation result changes, even if an administrator accidentally reuses a version.

## Install the Resilience configuration from Coolify

Deploy this PR's updated application **and processing-worker** first. In the
Resilience application in Coolify, open its terminal and choose the
`processing-worker` container. Run the following in that Linux shell (not in the
browser's developer console or on your local computer):

The container name may have a deployment suffix. If you are unsure, identify its
main process first:

```sh
python -c "from pathlib import Path; print(Path('/proc/1/cmdline').read_bytes().replace(b'\0', b' ').decode())"
```

It should include `eolab_app.worker_cli`. The `app` container runs Uvicorn and has
a read-only `/processing-data` mount. If `mkdir` reports a read-only filesystem,
select the worker container before continuing; do not change the mount permissions.

```sh
mkdir -p /processing-data/hydrology
python -c "from urllib.request import urlretrieve; urlretrieve('https://raw.githubusercontent.com/springinnovate/eolab/main/docs/model-examples/resilience-hydrology.yaml', '/processing-data/hydrology/resilience.yaml')"
cat /processing-data/hydrology/resilience.yaml
```

This downloads only the small administrator configuration, not the DEM or
watersheds. It names Resilience's already-cataloged `astgtm_compressed.tif` and
`merged_lev06_repaired.gpkg` and uses `HYBAS_ID`, `NEXT_DOWN` and `NEXT_SINK`.
Check those entries, then run:

```sh
python -m eolab_app.hydrology_cli /processing-data/hydrology/resilience.yaml \
  --catalog-url http://stac-api:8080 \
  --scan-mount /scan-source \
  --output /processing-data/hydrology/resilience.hydrology.json \
  --timeout-seconds 1800 \
  --max-coordinates 30000000
```

This gives the full Resilience network a one-time validation allowance of 30
minutes and 30 million polygon coordinates, while retaining the 2 GiB native
memory limit. These are maximum allowances, not an estimated runtime or a measured
coordinate count. They apply to this administrator command, not ordinary map reads
or model runs. The default budgets remain available for smaller regional networks.

Wait for `Validated configuration written to ...resilience.hydrology.json` and a
successful exit. If it reports a missing field, source change or exhausted budget,
address that message before continuing; do not hand-edit a validation report.
The diagnostic distinguishes a time limit from a feature or coordinate limit.
See the limits below before increasing memory or work budgets.

Older deployments report `Vector reading exceeded its feature/time budget` after
15 seconds even when a longer CLI timeout was requested. Deploy the updated worker
before retrying; changing the command's timeout alone cannot fix that older reader.

After validation succeeds, add this **runtime** environment variable to the
Resilience deployment in Coolify, then redeploy the app:

```text
EOLAB_PREPARED_HYDROLOGY_DIRECTORY=/processing-data/hydrology
```

The existing Compose configuration makes this volume writable in the worker and
read-only in the app. The `hydrology` directory is outside the temporary job
`attempts` and `results` directories, so run cleanup does not remove it. Keep the
same processing-data volume when redeploying; a replacement volume needs the
configuration installed again. No changes to the read-only dataset mount are needed.

Open `/api/processing/prepared-hydrology` on the Resilience site to confirm its
`configurations` list contains **Resilience prepared ASTER drainage**. Then reopen
**Tools / Models / Downstream ecosystem beneficiaries** and choose that dataset.
Start with a small drainage inside the DEM's extent. Installing a configuration
does not itself run the model.

## Field mappings and checks

`idField` and `downstreamField` name distinct fields. IDs must all use the declared
`integer` or `string` type; numeric strings are never coerced and fractional IDs
are never rounded. `terminal.field` and `terminal.value` define an exact stop rule.
Alternatively, `terminal.equalsField` compares two source fields. For real
HydroBASINS sinks, use `field: NEXT_SINK` and `equalsField: HYBAS_ID`; virtual
`NEXT_DOWN` links at these sinks are deliberately not followed.
For a network without virtual sink links, a terminal rule of `NEXT_DOWN` equal
to integer `0` is also valid. If `terminalIdField` is supplied, it must describe
the terminal reached under the chosen rule.
The configured display name, including HUC06, implies no schema.

Validation rejects missing fields, wrong/null ID types, duplicate IDs, dangling
links, cycles and a constant-value terminal that still links to another feature.
A field-to-field terminal rule permits virtual downstream links at the declared
real sink. When
`terminalIdField` is supplied, every value must name the terminal actually reached
by following links. A network may contain several independent complete drainages.

The shared bounded vector reader checks polygon validity and CRS, applies the
existing source-signature checks and streams original features. No filtered
vectors or reusable geometry snapshots are saved. Installation checks DEM
georeferencing, native source structure and the north-up grid, without projecting
the entire network into the DEM or reading elevation cells.

For each run, Processing follows the selected starting mask's downstream links
to the real sinks. Before planning raster windows, it projects those watersheds,
checks that the DEM contains their complete extent, and checks connected
boundaries within one native DEM-pixel diagonal. Execution checks pixel-center
coverage and the ordinary mask/NoData/nonfinite elevation policy before routing.
Missing elevation in a required watershed fails that run with an actionable
error; unrelated watersheds outside the DEM or containing NoData do not prevent
installation or a covered run. Zero and negative elevations remain valid.
Coverage means the full selected downstream watershed polygons, not just the
starting mask or a route inferred from incomplete terrain. No drainage is silently
clipped to the DEM. Resource, source-identity and cancellation checks still apply.

New reports use `eolab.hydrology-validation/v2` with `demCellsChecked: 0`, which
explicitly records that installation did not scan DEM pixels. Version 1 reports
and their checksums remain readable in installed configurations and saved Run YAML;
those reports additionally certified network-wide pixel-center coverage.
Revalidating produces a version 2 report and a new effective checksum.

These checks do not certify exterior or subpixel gaps, inferred drainage
connections, vertical accuracy or the scientific correctness of the stated
conditioning. `terrain.conditioning` and `terrain.datasetVersion` record the
administrator's provenance; `routing: mfd` and `elevationUnit: metre` state the
supported intended method. Installation does not run pit filling, MFD routing,
distance buffers or resampling.

## Resource limits and diagnostics

The command uses the existing native-process supervisor with a 120-second default
deadline and 2 GiB Linux address-space ceiling. It terminates and reaps native
work on cancellation, deadline or crash. The CLI passes the same time allowance to
the watershed reader, which checks elapsed time between features. The supervisor
still enforces the overall deadline, including native startup and all validation
work. Ordinary map and analysis reads retain their separate 15-second default.
The reader also limits a stream to one million scanned features and 500,000
coordinates per feature. These limits fail validation explicitly; no truncated
network is accepted. Containers should retain their normal memory limits.

The validator defaults to 100,000 retained network features and two million
geographic coordinates. These are computational budgets, adjustable with
`--max-features` and `--max-coordinates`; they do not limit the number of installed
configurations. `--timeout-seconds` and `--memory-mib` configure the supervised
process. The shared vector-reader limits remain in force. The former
`--max-decoded-mib` option has been removed because installation no longer reads
DEM cells; remove it from older validator commands. Per-run native-read budgets
remain unchanged. Prepare smaller **complete drainages**, or increase the
appropriate administrator budget within the server's capacity, when a dataset
exceeds these limits.

Errors identify the failed field, connection, coverage condition or budget.
Repair or rescan sources, validate again, and install the new report. Discovery
does not certify current availability: selection reauthorizes catalog Items and
compares the exact raster and vector signatures against the report. Stale reports
return `hydrology_changed` and cannot be captured as newly accepted model inputs.

## API and captured runs

- `GET /api/processing/prepared-hydrology` returns `configurations`, containing
  installed reports with their definition, grid, counts, validation time and
  source identities.
- `POST /api/processing/prepared-hydrology/resolve` accepts
  `{presetId, version, effectiveSha256}` with the existing
  `X-EOLab-Processing: 1` same-origin header. It rechecks catalog/source access and
  returns the selected report. It performs no native coverage scan.

Both use existing Processing session/cache handling. Public requests and reports
contain no filesystem paths. Resolution confers no transferable source grant.
Registered models declaring a `prepared_hydrology` input capture its complete
server-resolved report in `invocation.hydrology`, keyed by the recipe's input name.
Run YAML validates that the captured report matches the submitted reference and
retains that snapshot independently of later installed configuration changes.
The downstream operation uses and reauthorizes these captured sources;
the current summary and clip operations do not declare hydrology inputs.

The deterministic test dataset uses a 6-by-4 eastward-sloping DEM and three
adjacent watersheds draining `1 → 2 → 3 → terminal`, with 24 valid pixel centers.
`tests/test_prepared_hydrology.py` generates the source files and checks them
through the real vector/raster contracts without a viewer or GeoServer.
