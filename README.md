# EOLab

EOLab is an open source platform for Earth observation analysis and visualization. The current application provides a Leaflet map and a persistent STAC catalog backed by pgSTAC.

## Deploy with Coolify

1. Create a new Coolify resource from this GitHub repository.
2. Select the **Docker Compose** build pack and use `/docker-compose.yml`.
3. In the settings for `pgstac-migrate` and `catalog-seed`, enable **Exclude from service status** (called **Exclude from health checks** by some Coolify versions). These are one-shot services that should exit after successful work.
4. Set `EOLAB_DATABASE_PASSWORD` to a long random value in the deployment environment before the first deployment.
5. Set `EOLAB_LOAD_SAMPLE_CATALOG=true` while evaluating the catalog. Set it to `false` before the first deployment to start with an empty catalog. Disabling it later stops future sample upserts but does not delete records already loaded.
6. In the project **Configuration**, select **Domains** for the `app` service and enter the public domain with internal port `8000`, such as `https://eolab.example.com:8000`.
7. In **Advanced**, enable **Include Source Commit in Build**. On Coolify versions that label this setting **Source Commit Availability**, select **Available during build**. EOLab uses `SOURCE_COMMIT` to derive the displayed version from Git tags and the deployed commit.
8. Set any other deployment-specific `EOLAB_*` values listed in `.env.example`.
9. Open the **Actions** menu in the upper-right corner and select **Deploy**.

## Run with Docker Compose

Create `.env` from `.env.example`, set `EOLAB_DATABASE_PASSWORD`, and set `SOURCE_COMMIT` to the full 40-character SHA reported by `git rev-parse HEAD`. Choose `true` or `false` for `EOLAB_LOAD_SAMPLE_CATALOG`, then start the stack with the local port override:

```console
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build --detach
```

Open `http://localhost:8000`. Set `EOLAB_HOST_PORT` to use a different loopback port.

## Verify the catalog

Open the deployed application after all services start. A working deployment displays:

- `Catalog connected · 4 items shown` in the application status;
- the **EOLab sample geospatial data** Collection in the Catalog panel;
- four sample Item cards; and
- four blue Item footprints on the map.

Select an Item card to zoom to its footprint. Select **Refresh** to repeat the live STAC requests. The **Open STAC API** link opens the standards-compliant landing page at `/stac`; `/stac/collections` and `/stac/search` are available beneath it.

If the catalog is unavailable, the Catalog panel reports the failing STAC request while the map and `/healthz` remain available. Application health is intentionally independent from catalog health, so also check `/stac/_mgmt/health` and the catalog service logs when diagnosing a deployment.

The `catalog-seed` service upserts the sample records, so deployment and manual reruns do not create duplicates:

```console
docker compose run --rm catalog-seed
```

To remove the sample Collection and its Items, first set `EOLAB_LOAD_SAMPLE_CATALOG=false`, then run:

```console
docker compose exec database psql -U eolab -d eolab -c "SELECT pgstac.delete_collection('eolab-sample-data');"
```

Catalog records are stored in the `pgstac-data` Docker volume and survive container recreation.

`pgstac-migrate` and `catalog-seed` are one-shot services. They should finish with exit code `0` and may appear as **Exited** or **Completed** in Coolify; that is expected. The `app`, `database`, and `stac-api` services should remain running.

## Runtime configuration

| Variable                    | Default                                           | Purpose                                      |
| --------------------------- | ------------------------------------------------- | -------------------------------------------- |
| `EOLAB_DATABASE_PASSWORD`   | none                                              | Required internal PostgreSQL password        |
| `EOLAB_LOAD_SAMPLE_CATALOG` | none                                              | Required `true` or `false` sample-data choice |
| `EOLAB_APP_TITLE`           | `EOLab`                                           | Browser and panel title                      |
| `EOLAB_APP_SUBTITLE`        | `Explore, process, and visualize geospatial data` | Short panel description                      |
| `EOLAB_CATALOG_URL`         | `/stac`                                           | Browser-facing STAC API path                 |
| `EOLAB_BASEMAP_URL`         | OpenStreetMap tiles                               | Leaflet tile URL template                    |
| `EOLAB_BASEMAP_ATTRIBUTION` | OpenStreetMap attribution                         | Basemap attribution text                     |
| `EOLAB_INITIAL_LATITUDE`    | `20`                                              | Initial map latitude                         |
| `EOLAB_INITIAL_LONGITUDE`   | `0`                                               | Initial map longitude                        |
| `EOLAB_INITIAL_ZOOM`        | `2`                                               | Initial Leaflet zoom, from 0 to 22           |

Application identity, catalog URL, and map settings are read by FastAPI, so changing them does not require rebuilding the frontend image. The database password and sample-data choice are consumed by the catalog services.

Set `EOLAB_DATABASE_PASSWORD` before the first deployment and retain it. PostgreSQL applies this bootstrap value only when it creates the `pgstac-data` volume; changing the environment variable later does not rotate the existing database role password and will disconnect the catalog services.

The Compose-only `EOLAB_CATALOG_INTERNAL_URL` points the application container to `http://stac-api:8080`. It is never returned by `/api/config`; browsers use the public `/stac` path instead.
