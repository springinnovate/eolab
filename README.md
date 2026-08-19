# EOLab

EOLab is an open source platform for Earth observation analysis and visualization. It provides a Leaflet map and a persistent STAC catalog backed by pgSTAC.

## Deploy with Coolify

1. Create a new Coolify resource from this GitHub repository.
2. Select the **Docker Compose** build pack and use `/docker-compose.yml`.
3. In Coolify's **Production** environment variables, set `EOLAB_DATABASE_PASSWORD` to a long random value before the first deployment. Keep this value: PostgreSQL uses it when initializing the persistent database volume, and changing the environment variable later does not change the database password.
4. In Coolify's **Production** environment variables, set `EOLAB_LOAD_SAMPLE_CATALOG=true` to load the sample Collection and Items, or set it to `false` to start with an empty catalog. Changing it to `false` later prevents future sample upserts but does not delete existing sample records.
5. Create the directory that EOLab will scan on the Coolify deployment server. Open the EOLab resource's **Production** environment variables, select **Add**, and create `EOLAB_SCAN_SOURCE_PATH` with that absolute host path as its value, for example `/mnt/eolab/geotiffs`. Coolify does not add this variable to the list automatically because Docker Compose uses it only as the source of a bind mount, rather than as a container environment variable. Docker Compose mounts the directory read-only at `/scan-source` in the application container. The path must exist on the deployment server and its directories and GeoTIFFs must be readable by the application container.
6. In the project **Configuration**, select **Domains** for the `app` service and enter the public domain with internal port `8000` as `https://eolab.example.com:8000`.
7. In **Advanced**, enable **Include Source Commit in Build**. On Coolify versions that label this setting **Source Commit Availability**, select **Available during build**. EOLab uses `SOURCE_COMMIT` to derive the displayed version from Git tags and the deployed commit.
8. Set any other desired deployment-specific `EOLAB_*` values listed in `.env.example`.
9. Open the **Actions** menu in the upper-right corner and select **Deploy**.

## Run with Docker Compose

Copy `.env.example` to `.env`, set `EOLAB_DATABASE_PASSWORD`, choose `true` or `false` for `EOLAB_LOAD_SAMPLE_CATALOG`, and set `EOLAB_SCAN_SOURCE_PATH` to an existing absolute directory containing the GeoTIFFs to scan. To display a Git-derived version locally, replace the `SOURCE_COMMIT` fallback with the full 40-character SHA reported by `git rev-parse HEAD`.

Start the stack with the local port override:

```console
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build --detach
```

Open `http://localhost:8000`. Set `EOLAB_HOST_PORT` to use a different loopback port.

## Runtime configuration

| Variable                     | Default                                           | Purpose                                        |
| ---------------------------- | ------------------------------------------------- | ---------------------------------------------- |
| `EOLAB_DATABASE_PASSWORD`    | none                                              | Required internal PostgreSQL password          |
| `EOLAB_DATABASE_VOLUME_NAME` | `eolab-pgstac-data`                               | Database volume name, unique per deployment    |
| `EOLAB_LOAD_SAMPLE_CATALOG`  | none                                              | Required `true` or `false` sample-data choice  |
| `EOLAB_SCAN_SOURCE_PATH`     | none                                              | Required absolute host directory mounted read-only for GeoTIFF scans |
| `EOLAB_APP_TITLE`            | `EOLab`                                           | Browser and panel title                        |
| `EOLAB_APP_SUBTITLE`         | `Explore, process, and visualize geospatial data` | Short panel description                        |
| `EOLAB_CATALOG_URL`          | `/stac`                                           | Browser-facing STAC API path                   |
| `EOLAB_BASEMAP_URL`          | OpenStreetMap tiles                               | Leaflet tile URL template                      |
| `EOLAB_BASEMAP_ATTRIBUTION`  | OpenStreetMap attribution                         | Basemap attribution text                       |
| `EOLAB_INITIAL_LATITUDE`     | `20`                                              | Initial map latitude                           |
| `EOLAB_INITIAL_LONGITUDE`    | `0`                                               | Initial map longitude                          |
| `EOLAB_INITIAL_ZOOM`         | `2`                                               | Initial Leaflet zoom, from 0 to 22             |

## Scan mounted GeoTIFFs

Open the **Catalog** panel and select **Scan directory**. EOLab searches the configured mount recursively for `.tif` and `.tiff` files, shows live discovered, processed, indexed, and failed counts, and refreshes the catalog when the scan completes. A failure in one file does not stop the remaining scan.

Scans create or update the `eolab-mounted-geotiffs` STAC Collection. Item identifiers are derived from each file's path relative to the mounted root, so scanning the same path again updates its Item instead of adding a duplicate. A later scan does not delete records for files that have disappeared or moved.

The scanner uses `ACQUISITIONDATETIME` from GDAL's `IMAGERY` metadata domain when it contains an RFC 3339 timestamp with a UTC offset. Otherwise it uses the source file's filesystem modification time as the required STAC Item `datetime`, records the same value as `updated` on the data Asset, and explains the fallback in the Item description. Filesystem creation time is not used because its meaning differs among operating systems. A malformed `ACQUISITIONDATETIME` is reported as a file failure rather than guessed or silently replaced.

## Search the catalog

The Catalog search field waits briefly after typing stops, then performs a case-insensitive substring search over Item titles and descriptions across the complete catalog. The scanner preserves each file's relative path in the Item title, so `2002` matches both a file such as `grassland_2002.tif` and a description containing `2002`. Search text is treated literally, including underscores and percent signs, and can match an arbitrary fragment such as part of a hash. Clearing the field returns to the unfiltered catalog. Requests use the standard STAC Filter extension with CQL2 JSON.

Results are returned 20 at a time. **Previous** and **Next** follow the pagination requests supplied by the STAC API. Result footprints are not all drawn at once: selecting a result displays its footprint, while pointer hover or keyboard focus temporarily displays a lighter preview.

The `pgstac-migrate` service enables PostgreSQL's `pg_trgm` extension and creates GIN trigram indexes over the case-insensitive Item title and description expressions used by the CQL2 filter. PostgreSQL maintains the indexes when a scan creates or updates an Item. The indexes consume database storage and add some work to catalog writes in exchange for supporting indexed searches with a wildcard at the beginning of the pattern.

On a deployment with enough Items for PostgreSQL to prefer the index, inspect the active plan from a server shell with:

```console
docker compose exec database psql -U eolab -d eolab -c "EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM pgstac.items WHERE upper(pgstac.to_text(content->'properties'->'title')) LIKE upper('%2004%') OR upper(pgstac.to_text(content->'properties'->'description')) LIKE upper('%2004%') ORDER BY datetime DESC, id DESC LIMIT 20;"
```

The plan should reference `eolab_items_title_trgm_idx`, `eolab_items_description_trgm_idx`, or their partition indexes. PostgreSQL may reasonably choose a sequential scan for a very small catalog because reading the table directly is cheaper. Very short search strings may also produce too few trigrams for a selective index scan.

## How to reset the database

Deleting the database volume permanently deletes the catalog. To intentionally discard the catalog and start over, stop the deployment, delete the volume named by `EOLAB_DATABASE_VOLUME_NAME`, and deploy again. PostgreSQL creates a new empty database during startup.
