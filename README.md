# EOLab

EOLab is an open source platform for Earth observation analysis and visualization. It provides a Leaflet map and a persistent STAC catalog backed by pgSTAC.

## Deploy with Coolify

1. Create a new Coolify resource from this GitHub repository.
2. Select the **Docker Compose** build pack and use `/docker-compose.yml`.
3. In Coolify's **Production** environment variables, set `EOLAB_DATABASE_PASSWORD` to a long random value before the first deployment and retain it. PostgreSQL applies this password when it initializes the persistent database volume; changing the environment variable later does not rotate the database password.
4. In Coolify's **Production** environment variables, set `EOLAB_LOAD_SAMPLE_CATALOG=true` while evaluating the catalog. Set it to `false` before the first deployment to start with an empty catalog. Disabling it later stops future sample upserts but does not delete records already loaded.
5. In the project **Configuration**, select **Domains** for the `app` service and enter the public domain with internal port `8000` as `https://eolab.example.com:8000`.
6. In **Advanced**, enable **Include Source Commit in Build**. On Coolify versions that label this setting **Source Commit Availability**, select **Available during build**. EOLab uses `SOURCE_COMMIT` to derive the displayed version from Git tags and the deployed commit.
7. Set any other desired deployment-specific `EOLAB_*` values listed in `.env.example`.
8. Open the **Actions** menu in the upper-right corner and select **Deploy**.

## Run with Docker Compose

Create `.env` from `.env.example`, set `EOLAB_DATABASE_PASSWORD`, and choose `true` or `false` for `EOLAB_LOAD_SAMPLE_CATALOG`. To display a Git-derived version locally, replace the `SOURCE_COMMIT` fallback with the full 40-character SHA reported by `git rev-parse HEAD`. Then start the stack with the local port override:

```console
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build --detach
```

Open `http://localhost:8000`. Set `EOLAB_HOST_PORT` to use a different loopback port.

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

## How to reset the database

Reset the database if its password is lost or out of sync, or if you want to discard the catalog and start over. Stop the deployment, delete the `pgstac-data` volume, confirm the desired `EOLAB_DATABASE_PASSWORD`, and deploy again.

Deleting the volume permanently deletes the catalog. On the next deployment PostgreSQL creates a new empty database and applies the current password.
