# EOLab

EOLab is an open source, catalog-driven platform for Earth observation analysis and visualization. This first milestone provides a deployable application shell: a Leaflet map, runtime configuration, and placeholder surfaces for the catalog, processing, and run history that will follow.

## Run with Docker

Copy `.env.example` to `.env`, adjust any public runtime settings, and run:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Open <http://localhost:8000>. The liveness endpoint is available at <http://localhost:8000/healthz>.

The production Compose file intentionally does not publish a host port. The development override publishes port 8000 for local use.

## Deploy with Coolify

1. Create a new Coolify resource from this GitHub repository.
2. Select the **Docker Compose** build pack and use `/docker-compose.yml`.
3. Attach the public domain to the `app` service on internal port `8000`.
4. Set any desired `EOLAB_*` environment variables from `.env.example`.
5. Deploy and configure Coolify's health check to use `/healthz` if it is not detected from Compose.

Coolify should provide the reverse proxy and TLS certificate. The Compose stack does not bundle Traefik or publish a production host port.

All values returned by `/api/config` are public browser configuration. Do not put passwords, tokens, or other secrets in `EOLAB_*` variables intended for this endpoint.

## Runtime configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `EOLAB_APP_TITLE` | `EOLab` | Browser and panel title |
| `EOLAB_APP_SUBTITLE` | `Catalog-driven Earth observation` | Short panel description |
| `EOLAB_APP_VERSION` | `dev` | Version shown in the UI and health response |
| `EOLAB_CATALOG_URL` | empty | Optional future STAC API location |
| `EOLAB_BASEMAP_URL` | OpenStreetMap tiles | Leaflet tile URL template |
| `EOLAB_BASEMAP_ATTRIBUTION` | OpenStreetMap attribution | Basemap attribution text |
| `EOLAB_INITIAL_LATITUDE` | `20` | Initial map latitude |
| `EOLAB_INITIAL_LONGITUDE` | `0` | Initial map longitude |
| `EOLAB_INITIAL_ZOOM` | `2` | Initial Leaflet zoom, from 0 to 22 |

Runtime settings are read by FastAPI, so changing them does not require rebuilding the frontend image.

## Develop locally

Install the Python application and test dependencies:

```bash
python -m venv .venv
python -m pip install -e ".[dev]"
```

Start the API:

```bash
uvicorn eolab_app.main:app --reload --port 8000
```

In a second terminal, install and start the frontend:

```bash
cd frontend
npm ci
npm run dev
```

The Vite development server runs at <http://localhost:5173> and proxies API requests to FastAPI.

Run the validation checks with:

```bash
pytest
cd frontend && npm run build
```

## Deliberate first-milestone boundaries

This scaffold does not yet include PgSTAC, GeoServer, authentication, persistent storage, or geoprocessing workers. Those components will be introduced through focused issues after the deployment foundation is proven.
