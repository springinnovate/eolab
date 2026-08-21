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

    `EOLAB_SCAN_MOUNT_PATH` is an absolute path on the deployment server. Coolify does not list it automatically because Compose uses it as a bind-mount source, so add it manually. Each entry in `EOLAB_SCAN_PATHS_WITHIN_MOUNT` is relative to that mount; use `["."]` to scan the entire mount. `EOLAB_SCAN_DISPLAY_PATH_PREFIX` is the path description shown to users in the Item inspector. `EOLAB_SCAN_WORKER_COUNT` is the number of concurrent metadata processes. `EOLAB_SCAN_WRITER_COUNT` is the maximum number of catalog bulk upserts in progress at once. `EOLAB_SCAN_BATCH_SIZE` is the maximum number of Items in each bulk upsert. All three must be positive integers. The mounted directories and dataset files must be readable by the application container.

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
| `EOLAB_SCAN_MOUNT_PATH`            | none                                              | Required absolute host directory mounted read-only  |
| `EOLAB_SCAN_PATHS_WITHIN_MOUNT`    | none                                              | Required JSON array of relative directories to scan |
| `EOLAB_SCAN_DISPLAY_PATH_PREFIX`   | none                                              | Required user-facing root shown for mounted files   |
| `EOLAB_SCAN_WORKER_COUNT`          | `8`                                               | Concurrent dataset metadata processes               |
| `EOLAB_SCAN_WRITER_COUNT`          | `4`                                               | Concurrent catalog bulk upserts                     |
| `EOLAB_SCAN_BATCH_SIZE`            | `100`                                             | Maximum Items per catalog bulk upsert               |
| `EOLAB_APP_TITLE`                  | `EOLab`                                           | Browser and panel title                             |
| `EOLAB_APP_SUBTITLE`               | `Explore, process, and visualize geospatial data` | Short panel description                             |
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

The scanner assesses mounted GeoTIFFs before offering **View on map**. The initial policy accepts supported one-band rasters that are small enough for direct rendering, or larger rasters with bounded base-resolution blocks and a complete internal overview pyramid. Other rasters remain fully searchable and inspectable with an explanation of why visualization is unavailable. For existing Items created before this policy, **Assess for visualization** inspects and updates only the selected raster.

While a raster is displayed, **Raster appearance** shows an approximate
band-1 distribution from a fixed, bounded sample. EOLab initially applies the
sample's 5th, 50th, and 95th percentiles, and the user can apply other ordered
percentiles or directly edit the color palette and minimum, midpoint, and
maximum display values. **Select area on map** adds a 1–300 km window that
follows the pointer without reading the raster; clicking or tapping fixes that
window and calculates its bounded distribution. **Sample map center** provides
the same action for keyboard users, and **Use whole raster** restores the
retained dataset distribution. Masked, nodata, and non-finite samples are
excluded. A statistics failure leaves the raster, manual appearance controls,
and hover pixel picker available. These appearance changes are session-only:
they do not modify either the source raster or its catalog Item. Selected
windows that cross a pole or the antimeridian are rejected rather than being
interpreted as a different area.

## Scan mounted datasets

Open the **Catalog** panel and select **Scan directories**. EOLab searches each configured path recursively for GeoTIFF (`.tif` and `.tiff`) and ESRI Shapefile (`.shp`) datasets, matching extensions case-insensitively. After each successful bulk upsert, the live status classifies processed datasets as newly cataloged or already present, alongside discovered, processed, and failed counts. Error details are collapsed by default and remain independently scrollable when opened, so the Catalog results remain usable during a scan. EOLab reads metadata using `EOLAB_SCAN_WORKER_COUNT` concurrent processes and uses `EOLAB_SCAN_WRITER_COUNT` concurrent STAC Bulk Transactions, each containing at most `EOLAB_SCAN_BATCH_SIZE` Items from one Collection. Catalog-write timing is cumulative across writers and can exceed wall time. A failure in one dataset does not stop the remaining scan; a catalog inventory or write failure stops the scan. Configured paths cannot be duplicated, nested inside one another, or escape the mount.

The live performance timing separates elapsed wall time, catalog inventory, filesystem discovery, time awaiting metadata results, catalog writes, catalog cleanup, and search-count refresh. Metadata worker time is cumulative across all workers, so it can exceed elapsed wall time. Worker CPU time estimates metadata processing; the remainder of worker wall time is reported as estimated I/O wait and also includes time the operating system leaves a worker unscheduled. These measurements are diagnostic rather than additive percentages.

Scans create or update the `eolab-mounted-geotiffs` and `eolab-mounted-vectors` STAC Collections. Item identifiers are derived from each primary file's path relative to the mounted root, so scanning the same path again updates its Item instead of adding a duplicate. In parallel, EOLab removes catalog Items whose required mounted source files no longer exist. Cleanup checks the whole mounted source, not only configured scan subdirectories, and stops without deleting anything if the source cannot be verified. Its progress and any failure are reported separately from dataset scanning. STAC Assets retain their container `file:` URIs; the inspector combines their mount-relative titles with `EOLAB_SCAN_DISPLAY_PATH_PREFIX` so users see each location as it is known on their own system.

One Shapefile Item groups files with the same exact base name. The `.shp`, `.shx`, `.dbf`, and `.prj` components are required; recognized `.cpg`, `.qix`, `.sbn`, `.sbx`, and `.shp.xml` companions are included when present. Missing or unreadable required components produce one dataset error. The Item records the native CRS and bounds, feature count, declared layer geometry type, and field names and types using published STAC Projection and Table extensions. Empty Shapefiles are reported as dataset errors because pgSTAC requires every stored Item to have a spatial footprint.

For GeoTIFFs, the scanner uses `ACQUISITIONDATETIME` from GDAL's `IMAGERY` metadata domain when it contains an RFC 3339 timestamp with a UTC offset. Otherwise it uses the source file's filesystem modification time as the required STAC Item `datetime`. A Shapefile Item uses the latest modification time among its component files. Each fallback is explained in the Item description, and every Asset records its own modification time as `updated`. Filesystem creation time is not used because its meaning differs among operating systems. A malformed GeoTIFF `ACQUISITIONDATETIME` is reported as a dataset failure rather than guessed or silently replaced.

GeoTIFF Items also record standard file size, dimensions, and band metadata plus an EOLab-local `eolab:rendering` Asset member containing the versioned structural assessment. This member records whether the base-resolution blocks meet the large-raster limit, their exact shapes, overview factors and storage, compression, estimated full-resolution pixel data, eligibility, and an explanation when unavailable. It is a local STAC foreign member rather than a claim that the file passed full COG validation.

GeoTIFFs without a coordinate reference system are reported as individual dataset errors because pgSTAC requires every stored Item to have a spatial footprint.

## Search the catalog

The Catalog search finds case-insensitive matches in Item filenames, relative paths, descriptions, and standard STAC datetime values. Enter any part of the text; for example, `2002` matches both `grassland_2002.tif` and a description containing `2002`, while `2025-01` matches a datetime containing that year and month. Separate terms are combined automatically, so `ESA 2020` requires both terms but permits them to match different searchable fields. Add `format:cog` to return only Cloud Optimized GeoTIFFs; for example, `barley format:cog` combines the literal text match and format filter. Search terms and filters do not require an `&`. Dates use the same literal substring search as other text; date-range searches are a separate feature. Clear the search field to show the complete catalog.

## How to reset the database

Deleting the database volume permanently deletes the catalog. To intentionally discard the catalog and start over, stop the deployment, delete the volume named by `EOLAB_DATABASE_VOLUME_NAME`, and deploy again. PostgreSQL creates a new empty database during startup.
