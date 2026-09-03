# Deployment and operations

This guide is for the person creating or maintaining an EOLab workspace. The
main [README](../README.md) explains how participants use the application.

## What a deployment contains

The supplied Docker Compose stack runs:

- the EOLab web application;
- PostgreSQL with pgSTAC for persistent Catalog metadata;
- GeoServer for bounded raster and vector rendering; and
- one-time database migration and GeoServer initialization services.

Source datasets are supplied through a read-only host bind mount. EOLab does
not copy the source files into its database or modify them in place.

## Before you deploy

Prepare:

1. a machine with Docker Compose, or a Coolify project that can deploy a Docker
   Compose repository;
2. three different, long random secrets for PostgreSQL, the GeoServer
   administrator, and the GeoServer keystore; and
3. an absolute host directory containing the prepared datasets, readable by
   the application container.

Keep the database password stable after the first deployment. PostgreSQL uses
it when initializing the persistent database volume; changing only the
environment variable later does not change the existing database role's
password.

Raster files should already be georeferenced and prepared for interactive map
delivery. Tiled, overviewed, single-band Cloud Optimized GeoTIFFs in Web
Mercator (EPSG:3857) are recommended for the default map. EOLab publishes
mounted rasters as-is and reports reader or CRS failures instead of rewriting
the source.

## Required configuration

Start from [`.env.example`](../.env.example), which is the authoritative list
of settings and defaults. At minimum, set:

```text
EOLAB_DATABASE_PASSWORD=<long random value>
EOLAB_GEOSERVER_ADMIN_PASSWORD=<different long random value>
EOLAB_GEOSERVER_MASTER_PASSWORD=<different long random value>
EOLAB_SCAN_MOUNT_PATH=/absolute/host/path/to/data
EOLAB_SCAN_PATHS_WITHIN_MOUNT=["."]
EOLAB_SCAN_DISPLAY_PATH_PREFIX=Workshop data
```

`EOLAB_SCAN_MOUNT_PATH` is a path on the deployment host. Compose mounts it
inside the application at `/scan-source` as read-only. Each entry in
`EOLAB_SCAN_PATHS_WITHIN_MOUNT` is relative to that root; use `.` to scan the
entire mount. `EOLAB_SCAN_DISPLAY_PATH_PREFIX` is the friendly location shown
to users in Item details.

The GeoServer administrator password must contain at least 16 letters,
numbers, hyphens, underscores, or periods. The master password must contain at
least eight characters, have no surrounding whitespace, and differ from the
administrator password.

Use distinct persistent volume names when several EOLab deployments share one
Docker host:

```text
EOLAB_DATABASE_VOLUME_NAME=my-workshop-pgstac
EOLAB_GEOSERVER_DATA_VOLUME_NAME=my-workshop-geoserver
```

## Deploy with Coolify

1. Create a resource from this repository.
2. Select the **Docker Compose** build pack and `/docker-compose.yml`.
3. Add the required variables above to the intended Coolify environment.
   `EOLAB_SCAN_MOUNT_PATH` must be added manually because it is a bind-mount
   source rather than a container variable.
4. Attach the public domain only to the `app` service at internal port `8000`,
   for example `https://eolab.example.com:8000`. Do not expose the `geoserver`
   service; EOLab publishes a restricted rendering route itself.
5. In **Advanced**, enable **Include Source Commit in Build** (called **Source
   Commit Availability** in some Coolify versions). This lets the application
   display the deployed Git-derived version.
6. Deploy the resource.

Changing an environment variable requires a redeployment. Persistent Catalog
and GeoServer volumes survive an ordinary redeployment.

## Run locally

Copy `.env.example` to `.env`, set the required values, and start the stack:

```console
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build --detach
```

Open `http://localhost:8000`. The local override exposes GeoServer's
administration interface only on the same machine at
`http://localhost:8081/geoserver/web/`; sign in as `eolab` with
`EOLAB_GEOSERVER_ADMIN_PASSWORD`.

## First-run verification

After the application reports that its services are ready:

1. Open **Status** and run **Scan directories** from the Catalog section.
2. Confirm that the configured user-facing paths appear and the scan completes.
3. Search for and add one representative raster and vector.
4. Verify **Zoom to**, styling, map clicking, and a raster histogram.
5. Open **Rendering diagnostics** while changing zoom levels and check for
   repeated `GetMap` failures, queue saturation, or sustained heap pressure.
6. Copy a map link and open it in another browser tab to verify shared-view
   restoration.

Scanning is repeatable. It creates or updates stable Catalog Items for mounted
datasets and removes Items whose required mounted files no longer exist. A
failure in one dataset is reported without preventing unrelated valid files
from being cataloged.

## Supported mounted data

The scanner recognizes GeoTIFF, GeoPackage, mounted Shapefile, ZIP-contained
Shapefile, GeoJSON FeatureCollection, and Esri File Geodatabase sources.
Mounted GeoTIFFs, mounted Shapefiles, and spatial GeoPackage layers are the
current map-rendering paths. Other recognized vector formats remain useful as
Catalog records and report an actionable message when rendering is unsupported.

The scanner is metadata-oriented. It does not validate raster tiling,
overviews, compression, decoded size, or GeoServer reader compatibility. Data
preparation remains an upstream responsibility.

## Capacity controls

Begin with the defaults in `.env.example` and change them only after observing
the deployed workload. The main controls are:

| Setting | Default | What it bounds |
| --- | ---: | --- |
| `EOLAB_GEOSERVER_CPU_LIMIT` | `4` | CPUs available to GeoServer |
| `EOLAB_GEOSERVER_MAX_HEAP_SIZE` | `4g` | GeoServer Java heap |
| `EOLAB_GEOSERVER_WMS_RENDER_COUNT` | `2` | Concurrent WMS renders |
| `EOLAB_GEOSERVER_WMS_QUEUE_TIMEOUT_SECONDS` | `10` | Seconds a render may wait for capacity |
| `EOLAB_RASTER_PIXEL_READ_CONCURRENCY` | `2` | Concurrent interactive pixel reads |
| `EOLAB_RASTER_STATISTICS_READ_CONCURRENCY` | `1` | Concurrent bounded statistics reads |
| `EOLAB_SCAN_WORKER_COUNT` | `8` | Concurrent metadata workers |
| `EOLAB_SCAN_WRITER_COUNT` | `4` | Concurrent Catalog bulk writes |
| `EOLAB_SCAN_BATCH_SIZE` | `100` | Items in each bulk write |

EOLab abandons queued upstream `GetMap` work when the requesting browser
disconnects, but an already-running GeoServer render may not stop immediately.
Increasing concurrency beyond the storage and CPU available can make latency
worse rather than better.

## Operations notes

- Keep all three secrets out of browser-facing configuration and logs.
- Verify the source mount from a running container with
  `grep ' /scan-source ' /proc/self/mountinfo`; the mount options should begin
  with `ro`.
- Use **Status** and **Rendering diagnostics** before increasing memory, CPU, or
  render concurrency.
- Deleting the volume named by `EOLAB_DATABASE_VOLUME_NAME` permanently deletes
  the Catalog. Do this only when intentionally creating a new empty Catalog.
- A temporary AOI upload is isolated from the source mount, STAC, and GeoServer
  publication and expires automatically.

## Detailed contracts

Use these documents when changing or troubleshooting a subsystem:

- [Map rendering boundaries](map-rendering-boundaries.md)
- [Raster publication and recovery](raster-publication.md)
- [Raster analysis](raster-analysis.md)
- [Bivariate raster comparison](bivariate-raster.md)
- [Vector publication](vector-publication.md)
- [Temporary AOI uploads](temporary-aoi.md)
- [Saved map views](saved-map-views.md)
- [Catalog dataset handlers](catalog-dataset-handlers.md)
