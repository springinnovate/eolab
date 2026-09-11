FROM python:3.12.14-slim-trixie@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /service

# Same reviewed Python/web-stack wheel resolution as the app, without GIS deps.
COPY services/jobs/requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir --only-binary=:all: --require-hashes -r requirements.txt \
    && python -m pip check \
    && addgroup --system jobs \
    && adduser --system --ingroup jobs --home /service jobs

COPY services/jobs/job_service/ ./job_service/
USER jobs
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/jobs/health', timeout=3)"]
CMD ["uvicorn", "job_service.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--no-server-header"]
