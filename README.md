# EOLab

EOLab is an open source platform for Earth observation analysis and visualization. This first milestone provides a deployable application shell: a Leaflet map, runtime configuration, and placeholder surfaces for the catalog, processing, and run history that will follow.

## Deploy with Coolify

1. Create a new Coolify resource from this GitHub repository.
2. Select the **Docker Compose** build pack and use `/docker-compose.yml`.
3. In the project **Configuration**, select **Domains** for the `app` service and enter the public domain with internal port `8000`, such as `https://eolab.example.com:8000`.
4. Furthermore, in the application **Configuration**, set **Source Commit Availability** to **Available during build**. This is because EOLab uses `SOURCE_COMMIT` to derive the displayed version from Git tags and the deployed commit.
5. In **Environment Variables**, set any deployment-specific `EOLAB_*` values listed in `.env.example`.
6. Open the **Actions** menu in the upper-right corner and select **Deploy**.

## Runtime configuration

| Variable                    | Default                                           | Purpose                            |
| --------------------------- | ------------------------------------------------- | ---------------------------------- |
| `EOLAB_APP_TITLE`           | `EOLab`                                           | Browser and panel title            |
| `EOLAB_APP_SUBTITLE`        | `Explore, process, and visualize geospatial data` | Short panel description            |
| `EOLAB_CATALOG_URL`         | empty                                             | Optional future STAC API location  |
| `EOLAB_BASEMAP_URL`         | OpenStreetMap tiles                               | Leaflet tile URL template          |
| `EOLAB_BASEMAP_ATTRIBUTION` | OpenStreetMap attribution                         | Basemap attribution text           |
| `EOLAB_INITIAL_LATITUDE`    | `20`                                              | Initial map latitude               |
| `EOLAB_INITIAL_LONGITUDE`   | `0`                                               | Initial map longitude              |
| `EOLAB_INITIAL_ZOOM`        | `2`                                               | Initial Leaflet zoom, from 0 to 22 |

Runtime settings are read by FastAPI, so changing them does not require rebuilding the frontend image.
