# Disposable Processing PostgreSQL tests

From a clean checkout, with Python 3.12+ and a running Linux Docker engine:

```sh
python scripts/test_processing_postgres.py
```

No local Python packages, PostgreSQL installation, environment file, database
credentials or application deployment are needed. Docker pulls PostgreSQL 16 and
builds a separate Python 3.12 test image using the checkout's application metadata.
The first run needs internet access to fetch images and Python packages. Runtime
test containers use a private internal network without published ports.

The launcher supplies a fresh `eolab_processing_test_<uuid>` database and runs all
30 current database tests in `test_processing_jobs.py`,
`test_processing_calculations.py`, `test_processing_events_postgres.py`,
`test_processing_area_limits.py` and `test_processing_ground_area.py`, plus
the database safety regressions. Collection must include all five database
modules, each database test must retain its real `store` fixture, and any skip
(including xfail) makes the command fail. Future tests in these modules join the
lane automatically. No manually supplied DSN or production `PG*` settings are
accepted by the launcher.

Coverage includes migration reruns and legacy schema upgrades, commit-only
notifications, rollback silence, unchanged-state silence, owner isolation,
idempotent admission, concurrent claims, stale-attempt fencing, cancellation,
catalog descriptors, historical polygon-job compatibility, source reauthorization and result cleanup. The fixture
continues to check the connected database name before migrations or truncation;
it additionally rejects a missing or unsafe explicit database name before opening
a connection. Manually using `pytest --processing-dsn=...` still requires a
separately provisioned disposable test database and is not the automated lane.

## CI and lifecycle verification

`.github/workflows/processing-postgres.yml` calls:

```sh
python scripts/verify_processing_postgres.py
```

This Linux-only acceptance command runs two complete suites simultaneously and
checks their distinct database identities. It then runs an intentionally failing
pytest test and interrupts a running suite with SIGTERM. Every run must report
cleanup, and the verifier independently checks that no containers or networks
with that exact run label remain. Failed tests and infrastructure failures return
nonzero; the injected failure must return 1 and interruption must return 130.
The normal launcher also handles Ctrl+C on Windows with Docker's Linux engine.

Every run has its own network, PostgreSQL container, runner and temporary image.
Database storage and runner `/tmp` are disposable tmpfs; no source, data, Docker
socket, production credentials or artifact directories are mounted. PostgreSQL
has a 512 MiB memory limit; each runner has a 2 GiB memory limit and a 4 GiB
temporary filesystem capacity (allocated on demand). That capacity preserves
Processing's existing 2 GiB free-space floor without weakening the guard.
Concurrent verification therefore requires sufficient Docker capacity
for two runs and image builds. Docker build cache and pulled base images remain
available for later runs; no shared resource pruning is performed.

Cleanup uses only generated exact names and verifies resource removal, including
on ordinary exceptions, timeouts, SIGINT and SIGTERM. SIGKILL, daemon failure or
host power loss cannot execute Python cleanup. On such a failure, inspect the
printed run name with `docker ps -a --filter label=org.eolab.processing-test=NAME`
and `docker network ls --filter label=org.eolab.processing-test=NAME`, then remove
only that run's containers/network. GitHub's hosted job VM is also disposable.

## Validate an installed application image

Packaging verification can use its locally built image:

```sh
python scripts/test_processing_postgres.py --application-image eolab-application:test
python scripts/verify_processing_postgres.py --application-image eolab-application:test
```

This builds a test-only derivative containing the tests and pytest in a separate
system-site-packages virtual environment. It does not copy application source or
reinstall runtime dependencies. The runner clears pytest's source `pythonpath`
override and uses the application's installed package. It replaces the deployment
entrypoint and healthcheck only in the disposable derivative and runs as an
unprivileged UID. No frontend build or production startup occurs in this lane.

These database tests complement the full Python/browser suites; they do not
replace them or the Linux-only native memory/resource tests. A green default
pytest run with PostgreSQL tests skipped is not evidence of real database
coverage. Local checks of the tooling itself are:

```sh
python -m pytest tests/test_processing_database_safety.py tests/test_processing_postgres_lane.py
```

## Architecture impact

Owner: Processing verification. **Used by:** developers, CI and packaging
validation. **Depends on:** Docker, disposable PostgreSQL, existing application
packages and pytest. **Coordinates with:** packaging through the optional image
argument. Changed components are test launchers, test fixture/assertions, CI and
this documentation. Only test runner → disposable PostgreSQL is added; no runtime
dependency edge is added, removed or redirected. No subsystem learns about a
sibling, and production services, scheduling, SQL schema and public API contracts
are unchanged. The test-image build still resolves the checkout's declared ranges
unless an already-built application image is supplied; production build resolution
remains owned by the packaging work.
