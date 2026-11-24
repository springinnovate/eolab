# Build the reviewed OGR Python bindings against the application's GDAL version.
FROM python:3.12.14-slim-trixie@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea AS gdal-builder

WORKDIR /build
RUN apt-get update \
    && apt-get install --yes --no-install-recommends g++ libgdal-dev=3.10.3+dfsg-1 \
    && rm -rf /var/lib/apt/lists/*
COPY deployment/application-build-requirements.txt deployment/application-runtime-requirements.txt deployment/application-gdal-requirements.txt ./
RUN python -m pip install --no-cache-dir --only-binary=:all: --require-hashes \
        -r application-build-requirements.txt \
    && sed -n '/^numpy==/p' application-runtime-requirements.txt > numpy-requirements.txt \
    && test -s numpy-requirements.txt \
    && python -m pip install --no-cache-dir --only-binary=:all: --require-hashes \
        -r numpy-requirements.txt \
    && test "$(gdal-config --version)" = "3.10.3" \
    && python -m pip wheel --no-cache-dir --no-deps --no-build-isolation \
        --require-hashes --wheel-dir /wheels -r application-gdal-requirements.txt


FROM python:3.12.14-slim-trixie@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /service

# Installed vector work reuses the application's reviewed GIS wheel resolution.
RUN apt-get update && apt-get install --yes --no-install-recommends libexpat1 libgdal36=3.10.3+dfsg-1 \
    && rm -rf /var/lib/apt/lists/*
COPY deployment/application-runtime-requirements.txt /build-inputs/deployment/application-runtime-requirements.txt
COPY services/jobs/requirements.txt /build-inputs/services/jobs/requirements.txt
COPY --from=gdal-builder /wheels/ /tmp/gdal-wheels/
RUN python -m pip install --no-cache-dir --only-binary=:all: --require-hashes -r /build-inputs/services/jobs/requirements.txt \
    && python -m pip install --no-cache-dir --no-index --no-deps /tmp/gdal-wheels/*.whl \
    && rm -rf /tmp/gdal-wheels \
    && python -m pip check \
    && addgroup --system jobs \
    && adduser --system --ingroup jobs --home /service jobs

COPY services/jobs/job_service/ ./job_service/
COPY src/eolab_app/ ./eolab_app/
COPY src/eolab_jobs/ ./eolab_jobs/
COPY --chmod=0555 deployment/require-read-only-scan-source.sh /usr/local/bin/require-read-only-scan-source
COPY --chown=jobs:jobs services/jobs/smoke.py /tmp/eolab-jobs-smoke.py
USER jobs
RUN PYTHONPATH=/service python /tmp/eolab-jobs-smoke.py --native \
    && rm /tmp/eolab-jobs-smoke.py
ENTRYPOINT ["/usr/local/bin/require-read-only-scan-source"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/jobs/health', timeout=3)"]
# One ASGI worker is required: each process would otherwise create its own queue.
# Port 8080 is the internal proxy/healthcheck contract; host ports are configured
# by deployment. Do not turn worker count into a scaling knob before shared state.
CMD ["uvicorn", "job_service.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--no-server-header"]
