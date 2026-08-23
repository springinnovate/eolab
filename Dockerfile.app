FROM alpine:3.21 AS versioner

ARG SOURCE_COMMIT

RUN apk add --no-cache git

WORKDIR /source

RUN if [ "$SOURCE_COMMIT" = "Version cannot be determined outside a Coolify deployment" ]; then \
        printf '%s\n' "$SOURCE_COMMIT" > /version; \
    else \
        test -n "$SOURCE_COMMIT" \
        && git init \
        && git remote add origin https://github.com/springinnovate/eolab.git \
        && git fetch --filter=blob:none --tags origin "$SOURCE_COMMIT" \
        && git checkout --detach FETCH_HEAD \
        && git describe --tags --always > /version; \
    fi \
    && test -s /version


FROM node:22-alpine AS frontend-builder

WORKDIR /build/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build


FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    GDAL_DISABLE_READDIR_ON_OPEN=TRUE

WORKDIR /app

RUN apt-get update \
    && apt-get install --yes --no-install-recommends libexpat1 \
    && rm -rf /var/lib/apt/lists/*

RUN addgroup --system eolab \
    && adduser --system --ingroup eolab --home /app eolab

COPY pyproject.toml README.md LICENSE ./
COPY src/ ./src/
COPY --chmod=0555 deployment/require-read-only-scan-source.sh \
    /usr/local/bin/require-read-only-scan-source
COPY --from=frontend-builder /build/frontend/dist/ ./src/eolab_app/static/
COPY --from=versioner /version /app/version

RUN pip install --no-cache-dir . \
    && python -c "import boto3; import fiona; import rasterio; assert 'ESRI Shapefile' in fiona.supported_drivers" \
    && chown -R eolab:eolab /app

USER eolab

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"]

ENTRYPOINT ["/usr/local/bin/require-read-only-scan-source"]
CMD ["uvicorn", "eolab_app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
