# EOLab

EOLab is an open source platform for Earth observation analysis and visualization. It provides a Leaflet map and a persistent STAC catalog backed by pgSTAC.

## Deploy with Coolify

1. Create a new Coolify resource from this GitHub repository.
2. Select the **Docker Compose** build pack and use `/docker-compose.yml`.
3. In Coolify's **Production** environment variables, set `EOLAB_DATABASE_PASSWORD` to a long random value before the first deployment. Keep this value: PostgreSQL uses it when initializing the persistent database volume, and changing the environment variable later does not change the database password.
4. Set `EOLAB_GEOSERVER_ADMIN_PASSWORD` and `EOLAB_GEOSERVER_MASTER_PASSWORD` to different long random values. Use at least 16 letters, numbers, hyphens, underscores, or periods for the administrator password. The master password must contain at least eight characters with no surrounding whitespace. GeoServer uses the first value for its internal administrator account; EOLab's initializer applies the second to the GeoServer keystore without exposing either value to the browser.
   Add `EOLAB_GEOSERVER_CPU_LIMIT=4`,
   `EOLAB_GEOSERVER_MAX_HEAP_SIZE=4g`, and
   `EOLAB_GEOSERVER_WMS_RENDER_COUNT=2` if Coolify does not list those
   defaulted variables automatically.
5. Configure the read-only scan mount and the directories EOLab should search. In the EOLab resource's **Production** environment variables, select **Add** and create these variables:

    ```text
    EOLAB_SCAN_MOUNT_PATH=/mnt/storage/bigbucket
    EOLAB_SCAN_PATHS_WITHIN_MOUNT=["eolab_catalog_data/observations","eolab_catalog_data/model_outputs"]
    EOLAB_SCAN_DISPLAY_PATH_PREFIX=bigboi -- Z:\bigbucket
    EOLAB_SCAN_WORKER_COUNT=8
    EOLAB_SCAN_WRITER_COUNT=4
    EOLAB_SCAN_BATCH_SIZE=100
    ```

    `EOLAB_SCAN_MOUNT_PATH` is an absolute path on the deployment server. Coolify does not list it automatically because Compose uses it as a bind-mount source, so add it manually. Each entry in `EOLAB_SCAN_PATHS_WITHIN_MOUNT` is relative to that mount; use `["."]` to scan the entire mount. `EOLAB_SCAN_DISPLAY_PATH_PREFIX` is the path description shown to users in the Item inspector. `EOLAB_SCAN_WORKER_COUNT` is the number of concurrent metadata processes. `EOLAB_SCAN_WRITER_COUNT` is the maximum number of catalog bulk upserts in progress at once. `EOLAB_SCAN_BATCH_SIZE` is the maximum number of Items in each bulk upsert. Keep the defaults initially; the additional scanner limits in the runtime configuration table are intended for measured tuning. The mounted directories and dataset files must be readable by the application container.

    To audit a running container, use `docker exec <container> grep ' /scan-source ' /proc/self/mountinfo`. The mount options immediately after `/scan-source` must begin with `ro`; for NFS, the filesystem options after the `- nfs4 ...` separator should also contain `ro`. Treat this kernel-reported state as authoritative. A `docker inspect` mount entry may still show `Mode: rw` because it describes Docker's bind request rather than a read-only property inherited from the host filesystem.

6. In the project **Configuration**, select **Domains** for the `app` service and enter the public domain with internal port `8000` as `https://eolab.example.com:8000`. Do not attach a domain to the `geoserver` service; EOLab exposes only its restricted WMS route.
7. In **Advanced**, enable **Include Source Commit in Build**. On Coolify versions that label this setting **Source Commit Availability**, select **Available during build**. EOLab uses `SOURCE_COMMIT` to derive the displayed version from Git tags and the deployed commit.
8. Set any other desired deployment-specific `EOLAB_*` values listed in `.env.example`.
9. Open the **Actions** menu in the upper-right corner and select **Deploy**.

## Run with Docker Compose

Copy `.env.example` to `.env`, set the database and two GeoServer passwords, and configure the scan variables described below. To display a Git-derived version locally, replace the `SOURCE_COMMIT` fallback with the full 40-character SHA reported by `git rev-parse HEAD`.

Start the stack with the local port override:

```console
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build --detach
```

Open `http://localhost:8000`. The local override also makes the GeoServer administration interface available only from the same machine at `http://localhost:8081/geoserver/web/`; sign in as `eolab` with `EOLAB_GEOSERVER_ADMIN_PASSWORD`. Set `EOLAB_HOST_PORT` or `EOLAB_GEOSERVER_HOST_PORT` to use different loopback ports.

EOLab no longer loads a sample Collection during deployment. Upgrading does not remove sample records that an earlier release already stored in the persistent database; deleting those records remains a separate, deliberate database operation.

## Runtime configuration

| Variable                           | Default                                           | Purpose                                             |
| ---------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `EOLAB_DATABASE_PASSWORD`          | none                                              | Required internal PostgreSQL password               |
| `EOLAB_DATABASE_VOLUME_NAME`       | `eolab-pgstac-data`                               | Database volume name, unique per deployment         |
| `EOLAB_GEOSERVER_ADMIN_PASSWORD`   | none                                              | Required internal GeoServer administrator password  |
| `EOLAB_GEOSERVER_MASTER_PASSWORD`  | none                                              | Required GeoServer keystore password                |
| `EOLAB_GEOSERVER_DATA_VOLUME_NAME` | `eolab-geoserver-data`                            | Persistent GeoServer configuration volume name      |
| `EOLAB_GEOSERVER_CPU_LIMIT`        | `4`                                               | GeoServer container CPU limit                        |
| `EOLAB_GEOSERVER_MAX_HEAP_SIZE`    | `4g`                                              | Maximum GeoServer Java heap (`m` or `g`)             |
| `EOLAB_GEOSERVER_WMS_RENDER_COUNT` | `2`                                               | Concurrent GeoServer WMS map renders                 |
| `EOLAB_RASTER_PIXEL_READ_CONCURRENCY` | `2`                                            | Concurrent Rasterio pixel reads                      |
| `EOLAB_RASTER_STATISTICS_READ_CONCURRENCY` | `1`                                       | Concurrent Rasterio statistics reads                 |
| `EOLAB_RASTER_STATISTICS_CACHE_ENTRIES` | `32`                                          | Completed statistics documents cached per app process |
| `EOLAB_SCAN_MOUNT_PATH`            | none                                              | Required absolute host directory mounted read-only  |
| `EOLAB_SCAN_PATHS_WITHIN_MOUNT`    | none                                              | Required JSON array of relative directories to scan |
| `EOLAB_SCAN_DISPLAY_PATH_PREFIX`   | none                                              | Required user-facing root shown for mounted files   |
| `EOLAB_SCAN_WORKER_COUNT`          | `8`                                               | Concurrent dataset metadata processes               |
| `EOLAB_SCAN_WRITER_COUNT`          | `4`                                               | Concurrent catalog bulk upserts                     |
| `EOLAB_SCAN_BATCH_SIZE`            | `100`                                             | Maximum Items per catalog bulk upsert               |
| `EOLAB_SCAN_ERROR_DETAIL_LIMIT`    | `100`                                             | Failure details retained in scan status             |
| `EOLAB_SCAN_RECONCILIATION_PAGE_SIZE` | `500`                                          | Catalog Items loaded per cleanup page               |
| `EOLAB_SCAN_RECONCILIATION_CONCURRENCY` | `8`                                          | Concurrent mounted-file cleanup checks              |
| `EOLAB_SCAN_RECONCILIATION_SPOOL_MEMORY_BYTES` | `1048576`                              | Missing-key bytes kept in memory before disk spill  |
| `EOLAB_SCAN_CATALOG_WRITE_TIMEOUT_SECONDS` | `120`                                      | Per-operation STAC API write timeout                |
| `EOLAB_SCAN_CATALOG_ERROR_DETAIL_LIMIT` | `500`                                        | Upstream error characters retained in scan status   |
| `EOLAB_APP_TITLE`                  | `EOLab`                                           | Browser and panel title                             |
| `EOLAB_APP_SUBTITLE`               | `Explore, visualize, and analyze Earth observation data` | Short panel description                     |
| `EOLAB_CATALOG_URL`                | `/stac`                                           | Browser-facing STAC API path                        |
| `EOLAB_BASEMAP_URL`                | OpenStreetMap tiles                               | Leaflet tile URL template                           |
| `EOLAB_BASEMAP_ATTRIBUTION`        | OpenStreetMap attribution                         | Basemap attribution text                            |
| `EOLAB_INITIAL_LATITUDE`           | `20`                                              | Initial map latitude                                |
| `EOLAB_INITIAL_LONGITUDE`          | `0`                                               | Initial map longitude                               |
| `EOLAB_INITIAL_ZOOM`               | `2`                                               | Initial Leaflet zoom, from 0 to 22                  |

## Rendering service

GeoServer is configured automatically. Keep `EOLAB_GEOSERVER_ADMIN_PASSWORD` and `EOLAB_GEOSERVER_MASTER_PASSWORD` stable in Coolify. The administrator password must contain at least 16 letters, numbers, hyphens, underscores, or periods. The master password must contain at least eight characters with no surrounding whitespace and must differ from the administrator password.

GeoServer may use up to `EOLAB_GEOSERVER_CPU_LIMIT` CPUs and
`EOLAB_GEOSERVER_MAX_HEAP_SIZE` of Java heap. Its control-flow extension runs
at most `EOLAB_GEOSERVER_WMS_RENDER_COUNT` WMS map renders concurrently and
queues the remaining tile requests. Change these Coolify variables and
redeploy to tune the service; Java detects the Docker CPU limit without an
`ActiveProcessorCount` override. The CPU limit must be positive, the render
count must be a positive integer, and the heap must be at least `256m` with an
`m` or `g` suffix.

The application also bounds its own Rasterio work. Keep
`EOLAB_RASTER_STATISTICS_READ_CONCURRENCY` at `1` unless storage benchmarks
show that overlapping bounded statistics reads improves throughput without
hurting map rendering. `EOLAB_RASTER_PIXEL_READ_CONCURRENCY` controls small
interactive band-one reads; canceled requests retain their slot until the
underlying GDAL thread finishes. `EOLAB_RASTER_STATISTICS_CACHE_ENTRIES`
controls how many completed statistics documents each app process retains;
the cache does not retain raster pixels. All three values must be positive
integers, and changing them requires a redeploy.

Open **Rendering diagnostics** in the application header to inspect the JVM
heap used and maximum, GeoServer process CPU, garbage collection, live threads,
uptime, active and completed WMS GetMap requests, latest GetMap duration, and
recent failures. Values refresh quickly only while the disclosure is open and
stop while the browser tab is hidden. The raw JMX Exporter and GeoServer
administrative endpoints remain internal; the browser receives only a fixed
numeric summary. Heap maximum is the configured Java `-Xmx`, not host RAM, and
GetMap duration is measured end to end at EOLab's WMS proxy, including any
control-flow queue time. The exporter endpoint is not published outside the
Compose network, and the diagnostics panel never exposes metric labels,
internal URLs, request parameters, or upstream error text.

The scanner assesses mounted GeoTIFFs before offering **View on map**. The initial policy accepts supported one-band rasters that are small enough for direct rendering, or larger rasters with bounded base-resolution blocks and a complete internal overview pyramid. Other rasters remain fully searchable and inspectable with an explanation of why visualization is unavailable. For existing Items created before this policy, **Assess for visualization** inspects and updates only the selected raster.

Raster publication is a recoverable state transition rather than a blind
GeoServer create. EOLab preserves complete existing publications, removes and
retries only coverage-store-only orphans, and retains healthy resources when a
later style operation fails. A restarted app reauthorizes existing layers
without recreating them. Runtime failures appear beside **View on map** with a
stable category and actionable message, while the application log retains only
a bounded sanitized GeoServer response excerpt. The exact state, rollback,
REST response, and error contracts are documented in
[Raster publication recovery contract](docs/raster-publication.md).

While a raster is displayed, **Raster appearance** shows an approximate
band-1 distribution from a fixed, bounded sample. EOLab initially applies the
sample's 5th, 50th, and 95th percentiles, and the user can apply other ordered
percentiles or directly edit the color palette and minimum, midpoint, and
maximum display values. Whenever a raster is displayed, a 1–300 km window
follows the pointer without reading the raster; clicking or tapping fixes that
window and displays its bounded histogram. The percentile controls immediately
show the selected distribution's approximate 5th, 50th, and 95th percentile
values without changing the rendered colors. **Rescale colors to this range**
applies those values, or other selected percentiles, when the user chooses.
Hovering a histogram bar reports its bin midpoint, its percentage of the valid
sample, its sampled-pixel count, and its value range. Each bar uses the same
active color ramp as a raster pixel at that bin midpoint.
**Sample map center** provides the same action for keyboard users, and **Use
whole raster** restores the retained dataset distribution while leaving the
hover window active. Masked, nodata, and non-finite samples are excluded. A
statistics failure leaves the raster, manual appearance controls, and hover
pixel picker available. These appearance changes are session-only: they do not
modify either the source raster or its catalog Item. Selected windows that
cross a pole or the antimeridian are rejected rather than being interpreted as
a different area.

## Scan mounted datasets

Open the **Catalog: connected** System state menu and select **Scan directories**. The menu lists each configured scan location using its user-facing path and reports either live scan progress or the most recent completion time since EOLab started. EOLab searches each configured path recursively for GeoTIFF (`.tif` and `.tiff`), GeoPackage (`.gpkg`), mounted ESRI Shapefile (`.shp`), ZIP-contained Shapefile (`.zip`), and GeoJSON FeatureCollection (`.geojson`) datasets, matching extensions case-insensitively. Generic `.json` files are not scanned. Live status reports source datasets discovered and processed separately from catalog Items produced and written, then classifies written Items as new or already present. Error details are collapsed by default and remain independently scrollable when opened, so the Catalog results remain usable during a scan. EOLab reads metadata using `EOLAB_SCAN_WORKER_COUNT` concurrent processes and uses `EOLAB_SCAN_WRITER_COUNT` concurrent STAC Bulk Transactions, each containing at most `EOLAB_SCAN_BATCH_SIZE` Items from one Collection. Catalog-write timing is cumulative across writers and can exceed wall time. A failure in one dataset does not stop the remaining scan; a catalog inventory or write failure stops the scan. Configured paths cannot be duplicated, nested inside one another, or escape the mount.

The remaining scanner limits are deployment tuning controls. `EOLAB_SCAN_ERROR_DETAIL_LIMIT` bounds the individual failures retained for the UI without changing the total failed count. Cleanup reads `EOLAB_SCAN_RECONCILIATION_PAGE_SIZE` catalog records at a time and performs at most `EOLAB_SCAN_RECONCILIATION_CONCURRENCY` mounted-file checks concurrently; raise concurrency only when the storage server can sustain the additional metadata traffic. Missing Item keys remain in memory up to `EOLAB_SCAN_RECONCILIATION_SPOOL_MEMORY_BYTES`, then spill to a temporary file, so raising it trades application memory for less temporary-file I/O. `EOLAB_SCAN_CATALOG_WRITE_TIMEOUT_SECONDS` is an upstream HTTP operation timeout, not a total scan deadline; increase it only when measured large-batch writes need longer. `EOLAB_SCAN_CATALOG_ERROR_DETAIL_LIMIT` bounds the STAC API response excerpt stored in a terminal scan error. All limits must be greater than zero, and all except the timeout are integers.

The live performance timing separates elapsed wall time, catalog inventory, filesystem discovery, time awaiting metadata results, catalog writes, catalog cleanup, and search-count refresh. Metadata worker time is cumulative across all workers, so it can exceed elapsed wall time. Worker CPU time estimates metadata processing; the remainder of worker wall time is reported as estimated I/O wait and also includes time the operating system leaves a worker unscheduled. These measurements are diagnostic rather than additive percentages.

Scans create or update the `eolab-mounted-geotiffs` and `eolab-mounted-vectors` STAC Collections. Item identifiers are derived from each primary file's path relative to the mounted root, so scanning the same path again updates its Item instead of adding a duplicate. In parallel, EOLab removes catalog Items whose required mounted source files no longer exist. Cleanup checks the whole mounted source, not only configured scan subdirectories, and stops without deleting anything if the source cannot be verified. Its progress and any failure are reported separately from dataset scanning. STAC Assets retain their container `file:` URIs; the inspector combines their mount-relative titles with `EOLAB_SCAN_DISPLAY_PATH_PREFIX` so users see each location as it is known on their own system.

One Shapefile Item groups files with the same exact base name. The `.shp`, `.shx`, `.dbf`, and `.prj` components are required; recognized `.cpg`, `.qix`, `.sbn`, `.sbx`, and `.shp.xml` companions are included when present. Missing or unreadable required components produce one dataset error. The Item records the native CRS and bounds, feature count, declared layer geometry type, and field names and types using published STAC Projection and Table extensions. Empty Shapefiles are reported as dataset errors because pgSTAC requires every stored Item to have a spatial footprint.

One ZIP source container can produce multiple vector Items, including Shapefiles in nested internal directories. Each complete internal component group uses the same required-component, projection, table, geometry, and empty-dataset rules as a mounted Shapefile. Item IDs are stable hashes of both the mount-relative archive path and the exact validated internal `.shp` path, while the Item title identifies both locations and its source Asset retains the original mounted archive URI. ZIP Items use the archive filesystem modification time as their fallback datetime. Internal paths that are absolute, traversing, backslash-ambiguous, drive-qualified, duplicated case-insensitively, encrypted, or symbolic links are rejected. Before direct GDAL `/vsizip/` access, EOLab bounds compressed archive size to 2 GiB, the central directory to 16 MiB, entries to 4,096, each uncompressed member to 2 GiB, total declared uncompressed size to 4 GiB, and each compression ratio to 1,000:1. ZIP64, multi-disk, and unsupported compression methods are rejected. Direct access creates no temporary extraction directory; an invalid internal Shapefile is logged and skipped without discarding valid siblings, and an archive with no valid Shapefiles produces a scan error.

One GeoPackage source may produce several Items: each catalogable spatial vector layer receives its own stable Item identity derived from the mount-relative container path and exact layer name. Raster tile tables and nonspatial attribute tables are not cataloged. EOLab reads each layer's schema, feature count, bounds, and CRS through GDAL metadata without loading its full feature collection. Every Item uses the GeoPackage as its source Asset, records the applicable layer name, and exposes the shared vector metadata in the Catalog inspector. An unreadable or empty layer is logged and skipped when valid sibling layers remain; when no spatial layer can be cataloged, the GeoPackage produces one dataset error.

One GeoJSON FeatureCollection file produces one vector Item. Features are streamed so memory does not grow with the source feature count; retained field metadata is explicitly capped, and malformed or over-limit files produce isolated dataset errors. Bounds, feature count, geometry types, and property types are derived from the streamed features. Mixed JSON property types and nulls remain visible as union types rather than being narrowed. RFC 7946 WGS 84 coordinates are required. Legacy named CRS declarations are accepted only when they unambiguously identify EPSG:4326 or OGC CRS84; other legacy CRS declarations are rejected rather than guessed or reprojected. The Item datetime and Asset update time use the source file's modification time.

For GeoTIFFs, the scanner uses `ACQUISITIONDATETIME` from GDAL's `IMAGERY` metadata domain when it contains an RFC 3339 timestamp with a UTC offset. Otherwise it uses the source file's filesystem modification time as the required STAC Item `datetime`. A mounted Shapefile Item uses the latest modification time among its component files. ZIP-contained Shapefile Items use the archive's modification time, every layer Item from a GeoPackage uses the container file's modification time, and a GeoJSON Item uses its source file's modification time. Each fallback is explained in the Item description, and every Asset records its own modification time as `updated`. Filesystem creation time is not used because its meaning differs among operating systems. A malformed GeoTIFF `ACQUISITIONDATETIME` is reported as a dataset failure rather than guessed or silently replaced.

GeoTIFF Items also record standard file size, dimensions, and band metadata plus an EOLab-local `eolab:rendering` Asset member containing the versioned structural assessment. This member records whether the base-resolution blocks meet the large-raster limit, their exact shapes, overview factors and storage, compression, estimated full-resolution pixel data, eligibility, and an explanation when unavailable. It is a local STAC foreign member rather than a claim that the file passed full COG validation.

GeoTIFFs without a coordinate reference system are reported as individual dataset errors because pgSTAC requires every stored Item to have a spatial footprint.

The scanner's typed handler, container-pruning, multi-Item, progress, and shared vector conventions are documented in [Catalog dataset-handler extension contract](docs/catalog-dataset-handlers.md). That contract is the starting point for adding a mounted GIS format without redesigning discovery or scan coordination.

## Search the catalog

The Catalog search finds case-insensitive matches in Item filenames, relative paths, descriptions, and standard STAC datetime values. Enter any part of the text; for example, `2002` matches both `grassland_2002.tif` and a description containing `2002`, while `2025-01` remains a literal datetime-text match. Separate terms are combined automatically, so `ESA 2020` requires both terms but permits them to match different searchable fields. Add `format:cog` to return only Cloud Optimized GeoTIFFs. Add `viewable:true` to return only rasters whose current recorded assessment makes **View on map** available; unassessed and unavailable rasters are excluded without being assessed during the search. Search terms and filters do not require an `&`.

Use `date:YYYY` for a whole UTC calendar year, `date:YYYY-MM` for a whole month, or `date:YYYY-MM-DD` for one day. Two values separated by `..` form an inclusive range; each endpoint may use any of those precisions. The start expands to the beginning of its calendar period and the end expands to the final day of its period, so `date:2020-01..2020-03` covers January 1 through March 31. The range uses standard STAC Item Search temporal-intersection semantics, so it includes instant Items within the period and interval Items that are contained by, partially overlap, or span the requested range. An Item touching either boundary is included. For example, `ESA format:cog viewable:true date:2020` combines text, COG format, current viewability, and calendar-year constraints. Open-ended ranges and timestamps are not accepted; invalid dates and reversed ranges are reported beside the search field. Clear the field to show the complete catalog.

## How to reset the database

Deleting the database volume permanently deletes the catalog. To intentionally discard the catalog and start over, stop the deployment, delete the volume named by `EOLAB_DATABASE_VOLUME_NAME`, and deploy again. PostgreSQL creates a new empty database during startup.
