# Prepared hydrology datasets

A prepared hydrology configuration pairs an existing catalog DEM with a complete
watershed network. It names the fields that connect watersheds and records how
the terrain was prepared. It is separate from Model YAML: the same model can use
different regional datasets without changing its recipe.

The administrator validates each configuration explicitly and installs the
resulting report. Model setup can discover these reports through the Processing
API. Opening setup does not scan a DEM or rebuild a network. Downstream execution
and its form are delivered separately; this feature does not add an executable
downstream model to the library yet.

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

## Field mappings and checks

`idField` and `downstreamField` name distinct fields. IDs must all use the declared
`integer` or `string` type; numeric strings are never coerced and fractional IDs
are never rounded. `terminal.field` and `terminal.value` define an exact stop rule.
For example, a HydroBASINS-style network can map `HYBAS_ID`, `NEXT_DOWN`, a terminal
rule of `NEXT_DOWN` equal to integer `0`, and optional `terminalIdField: NEXT_SINK`.
The configured display name, including HUC06, implies no schema.

Validation rejects missing fields, wrong/null ID types, duplicate IDs, dangling
links, cycles and a terminal that still links to another feature. When
`terminalIdField` is supplied, every value must name the terminal actually reached
by following links. A network may contain several independent complete drainages.

The shared bounded vector reader checks polygon validity and CRS, applies the
existing source-signature checks and streams original features. No filtered
vectors or reusable geometry snapshots are saved. The validator projects those
polygons using the existing bounded projection mechanism, checks that the DEM
contains them, and checks connected boundaries within one native DEM-pixel
diagonal. Exact raster blocks are read using the ordinary mask/NoData/nonfinite
validity policy. Missing elevation at a watershed-covered pixel center fails
validation, including missing data in downstream partitions. Zero and negative
elevations are valid.

These checks certify the declared network and **DEM pixel-center coverage inside
its polygons**. They do not certify exterior or subpixel gaps, inferred drainage
connections, vertical accuracy or the scientific correctness of the stated
conditioning. `terrain.conditioning` and `terrain.datasetVersion` record the
administrator's provenance; `routing: mfd` and `elevationUnit: metre` state the
supported intended method. Validation does not run pit filling, MFD routing,
distance buffers or resampling. Execution must still verify that the starting
mask lies in supported coverage and check every run-specific grid/mask operation.

## Resource limits and diagnostics

The command uses the existing native-process supervisor with a 120-second default
deadline and 2 GiB Linux address-space ceiling. It terminates and reaps native
work on cancellation, deadline or crash. The existing vector reader additionally
limits a stream to 15 seconds, one million scanned features and 500,000 coordinates
per feature, checking its elapsed-time budget between features. Raster coverage
is checked after this stream closes. These limits fail validation explicitly;
no truncated network is accepted. Containers should retain their normal memory limits.

The validator defaults to 100,000 retained network features, two million projected
coordinates and 512 MiB cumulative decoded DEM work. These are computational
budgets, adjustable with `--max-features`, `--max-coordinates` and
`--max-decoded-mib`; they do not limit the number of installed configurations.
`--timeout-seconds` and `--memory-mib` configure the supervised process. The shared
vector-reader limits remain in force. DEM work charges repeat reads and embedded
mask blocks without assuming cache hits. It stores only a bounded network in the
child and releases it on exit. Prepare smaller **complete drainages**, or increase
the appropriate administrator budget, when a dataset exceeds these limits.

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
The later downstream operation must use and reauthorize these captured sources;
the current summary and clip operations do not declare hydrology inputs.

The deterministic test dataset uses a 6-by-4 eastward-sloping DEM and three
adjacent watersheds draining `1 → 2 → 3 → terminal`, with 24 valid pixel centers.
`tests/test_prepared_hydrology.py` generates the source files and checks them
through the real vector/raster contracts without a viewer or GeoServer.
