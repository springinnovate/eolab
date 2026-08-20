# EOLab

EOLab is an open source platform for Earth observation analysis and visualization. It provides a Leaflet map and a persistent STAC catalog backed by pgSTAC.

## Deploy with Coolify

1. Create a new Coolify resource from this GitHub repository.
2. Select the **Docker Compose** build pack and use `/docker-compose.yml`.
3. In Coolify's **Production** environment variables, set `EOLAB_DATABASE_PASSWORD` to a long random value before the first deployment. Keep this value: PostgreSQL uses it when initializing the persistent database volume, and changing the environment variable later does not change the database password.
4. In Coolify's **Production** environment variables, set `EOLAB_LOAD_SAMPLE_CATALOG=true` to load the sample Collection and Items, or set it to `false` to start with an empty catalog. Changing it to `false` later prevents future sample upserts but does not delete existing sample records.
5. Configure the read-only scan mount and the directories EOLab should search. In the EOLab resource's **Production** environment variables, select **Add** and create these variables:

    ```text
    EOLAB_SCAN_MOUNT_PATH=/mnt/storage/bigbucket
    EOLAB_SCAN_PATHS_WITHIN_MOUNT=["eolab_catalog_data/observations","eolab_catalog_data/model_outputs"]
    EOLAB_SCAN_DISPLAY_PATH_PREFIX=bigboi -- Z:\bigbucket
    EOLAB_SCAN_WORKER_COUNT=8
    EOLAB_SCAN_BATCH_SIZE=100
    ```

    `EOLAB_SCAN_MOUNT_PATH` is an absolute path on the deployment server. Coolify does not list it automatically because Compose uses it as a bind-mount source, so add it manually. Each entry in `EOLAB_SCAN_PATHS_WITHIN_MOUNT` is relative to that mount; use `["."]` to scan the entire mount. `EOLAB_SCAN_DISPLAY_PATH_PREFIX` is the path description shown to users in the Item inspector. `EOLAB_SCAN_WORKER_COUNT` is the number of datasets whose metadata EOLab reads concurrently. `EOLAB_SCAN_BATCH_SIZE` is the maximum number of Items in one catalog bulk upsert. Both must be positive integers. The mounted directories and dataset files must be readable by the application container.

6. In the project **Configuration**, select **Domains** for the `app` service and enter the public domain with internal port `8000` as `https://eolab.example.com:8000`.
7. In **Advanced**, enable **Include Source Commit in Build**. On Coolify versions that label this setting **Source Commit Availability**, select **Available during build**. EOLab uses `SOURCE_COMMIT` to derive the displayed version from Git tags and the deployed commit.
8. Set any other desired deployment-specific `EOLAB_*` values listed in `.env.example`.
9. Open the **Actions** menu in the upper-right corner and select **Deploy**.

## Run with Docker Compose

Copy `.env.example` to `.env`, set `EOLAB_DATABASE_PASSWORD`, choose `true` or `false` for `EOLAB_LOAD_SAMPLE_CATALOG`, and configure the scan variables described below. To display a Git-derived version locally, replace the `SOURCE_COMMIT` fallback with the full 40-character SHA reported by `git rev-parse HEAD`.

Start the stack with the local port override:

```console
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build --detach
```

Open `http://localhost:8000`. Set `EOLAB_HOST_PORT` to use a different loopback port.

## Runtime configuration

| Variable                         | Default                                           | Purpose                                             |
| -------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| `EOLAB_DATABASE_PASSWORD`        | none                                              | Required internal PostgreSQL password               |
| `EOLAB_DATABASE_VOLUME_NAME`     | `eolab-pgstac-data`                               | Database volume name, unique per deployment         |
| `EOLAB_LOAD_SAMPLE_CATALOG`      | none                                              | Required `true` or `false` sample-data choice       |
| `EOLAB_SCAN_MOUNT_PATH`          | none                                              | Required absolute host directory mounted read-only  |
| `EOLAB_SCAN_PATHS_WITHIN_MOUNT`  | none                                              | Required JSON array of relative directories to scan |
| `EOLAB_SCAN_DISPLAY_PATH_PREFIX` | none                                              | Required user-facing root shown for mounted files   |
| `EOLAB_SCAN_WORKER_COUNT`        | `8`                                               | Concurrent dataset metadata readers                 |
| `EOLAB_SCAN_BATCH_SIZE`          | `100`                                             | Maximum Items per catalog bulk upsert                |
| `EOLAB_APP_TITLE`                | `EOLab`                                           | Browser and panel title                             |
| `EOLAB_APP_SUBTITLE`             | `Explore, process, and visualize geospatial data` | Short panel description                             |
| `EOLAB_CATALOG_URL`              | `/stac`                                           | Browser-facing STAC API path                        |
| `EOLAB_BASEMAP_URL`              | OpenStreetMap tiles                               | Leaflet tile URL template                           |
| `EOLAB_BASEMAP_ATTRIBUTION`      | OpenStreetMap attribution                         | Basemap attribution text                            |
| `EOLAB_INITIAL_LATITUDE`         | `20`                                              | Initial map latitude                                |
| `EOLAB_INITIAL_LONGITUDE`        | `0`                                               | Initial map longitude                               |
| `EOLAB_INITIAL_ZOOM`             | `2`                                               | Initial Leaflet zoom, from 0 to 22                  |

## Scan mounted datasets

Open the **Catalog** panel and select **Scan directories**. EOLab searches each configured path recursively for GeoTIFF (`.tif` and `.tiff`) and ESRI Shapefile (`.shp`) datasets, matching extensions case-insensitively. After each successful bulk upsert, the live status classifies processed datasets as newly cataloged or already present, alongside discovered, processed, and failed counts. Error details are collapsed by default and remain independently scrollable when opened, so the Catalog results remain usable during a scan. EOLab reads metadata using `EOLAB_SCAN_WORKER_COUNT` concurrent workers and uses standard STAC Bulk Transactions to upsert at most `EOLAB_SCAN_BATCH_SIZE` Items per Collection and request. A failure in one dataset does not stop the remaining scan; a catalog inventory or write failure stops the scan. Configured paths cannot be duplicated, nested inside one another, or escape the mount.

The live performance timing separates elapsed wall time, catalog inventory, filesystem discovery, time awaiting metadata results, catalog writes, and search-count refresh. Metadata worker time is cumulative across all workers, so it can exceed elapsed wall time. Worker CPU time estimates metadata processing; the remainder of worker wall time is reported as estimated I/O wait and also includes time the operating system leaves a worker unscheduled. These measurements are diagnostic rather than additive percentages.

Scans create or update the `eolab-mounted-geotiffs` and `eolab-mounted-vectors` STAC Collections. Item identifiers are derived from each primary file's path relative to the mounted root, so scanning the same path again updates its Item instead of adding a duplicate. A later scan does not delete records for files that have disappeared or moved. STAC Assets retain their container `file:` URIs; the inspector combines their mount-relative titles with `EOLAB_SCAN_DISPLAY_PATH_PREFIX` so users see each location as it is known on their own system.

One Shapefile Item groups files with the same exact base name. The `.shp`, `.shx`, `.dbf`, and `.prj` components are required; recognized `.cpg`, `.qix`, `.sbn`, `.sbx`, and `.shp.xml` companions are included when present. Missing or unreadable required components produce one dataset error. The Item records the native CRS and bounds, feature count, declared layer geometry type, and field names and types using published STAC Projection and Table extensions. Empty Shapefiles are reported as dataset errors because pgSTAC requires every stored Item to have a spatial footprint.

For GeoTIFFs, the scanner uses `ACQUISITIONDATETIME` from GDAL's `IMAGERY` metadata domain when it contains an RFC 3339 timestamp with a UTC offset. Otherwise it uses the source file's filesystem modification time as the required STAC Item `datetime`. A Shapefile Item uses the latest modification time among its component files. Each fallback is explained in the Item description, and every Asset records its own modification time as `updated`. Filesystem creation time is not used because its meaning differs among operating systems. A malformed GeoTIFF `ACQUISITIONDATETIME` is reported as a dataset failure rather than guessed or silently replaced.

GeoTIFFs without a coordinate reference system are reported as individual dataset errors because pgSTAC requires every stored Item to have a spatial footprint.

## Search the catalog

The Catalog search finds case-insensitive matches in Item filenames, relative paths, descriptions, and standard STAC datetime values. Enter any part of the text; for example, `2002` matches both `grassland_2002.tif` and a description containing `2002`, while `2025-01` matches a datetime containing that year and month. Dates use the same literal substring search as other text; date-range searches are a separate feature. Clear the search field to show the complete catalog.

## How to reset the database

Deleting the database volume permanently deletes the catalog. To intentionally discard the catalog and start over, stop the deployment, delete the volume named by `EOLAB_DATABASE_VOLUME_NAME`, and deploy again. PostgreSQL creates a new empty database during startup.
