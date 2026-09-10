# Application build inputs

`Dockerfile.app` packages both the HTTP application and Processing worker.
The reviewed production target is **Linux amd64, CPython 3.12.14, Debian
trixie**. Other platforms may install the compatible ranges in `pyproject.toml`,
but do not have a reviewed production resolution here.

## Recorded inputs

- `deployment/application-runtime-requirements.txt` records all 37 runtime
  distributions, with one SHA-256 hash per selected compatible Linux wheel.
  Installation requires hashes and binary wheels; it cannot fall back to a
  source build or silently add an unrecorded transitive dependency.
- `deployment/application-build-requirements.txt` records pip and setuptools.
  Setuptools 84 supplies its wheel builder; no separate wheel package is
  required. EOLab is installed with `--no-index --no-build-isolation --no-deps`
  after these tools and runtime dependencies. Build hooks cannot silently
  resolve another build environment. `pip check` checks the installed package
  against the compatible project requirements.
- All three application base images are digest pinned in `Dockerfile.app`.
  The frontend retains `package-lock.json` and `npm ci`. GeoServer and catalog
  image inputs remain owned by their existing Dockerfiles and Compose stack.
- `/app/build-inputs/` in each image retains the requirement files, Dockerfile,
  and actual Node/npm versions. `/app/build-environment.json` records their
  hashes, base references, Python/native versions, NumPy build configuration,
  and installed Debian packages. Retrieve it without starting the app:

  ```sh
  docker run --rm --network none --entrypoint cat IMAGE /app/build-environment.json
  ```

The initial runtime resolution was read on 2026-09-10 from the running WWF
Connectivity application, version `0.5.0-91-gad0d852`, using its application-user
Coolify terminal. It was not resolved afresh from broad ranges. The observed
environment was Python 3.12.14, x86_64, Debian 13.6, glibc 2.41; Fiona 1.10.1
with GDAL 3.9.2; Rasterio 1.5.1 with GDAL 3.12.4 and PROJ 9.8.1; PyProj 3.8.0
with PROJ 9.8.1; Shapely 2.1.2 with GEOS 3.13.1; psycopg 3.3.5 with libpq
180006; and NumPy 2.5.3. The initial fresh builds also recorded Node 22.23.2,
npm 10.9.8, NumPy's OpenBLAS 0.3.34.106.0, and Debian libexpat1
2.8.3-1~deb13u1. Separate GDAL versions are intentional wheel inputs,
not an instruction to consolidate native libraries.

The base digests were queried from the official registry on the same date;
the Python tag matches the observed deployed Python and Debian family. Old
mutable base tags do not prove the exact historical base digest. The former
isolated setuptools version was not retained in the running image; 84.0.0 is
the explicit initial build-tool selection, while pip 25.0.1 preserves the
observed deployed installer.

## Verify a release

Build twice from the same committed checkout with fresh installation layers:

```sh
revision=$(git rev-parse HEAD)
docker build --pull --no-cache --platform linux/amd64 --build-arg SOURCE_COMMIT="$revision" -f Dockerfile.app -t eolab-check:one .
docker build --pull --no-cache --platform linux/amd64 --build-arg SOURCE_COMMIT="$revision" -f Dockerfile.app -t eolab-check:two .
docker run --rm --network none --entrypoint cat eolab-check:one /app/build-environment.json > environment-one.json
docker run --rm --network none --entrypoint cat eolab-check:two /app/build-environment.json > environment-two.json
diff -u environment-one.json environment-two.json
```

The Application build inputs workflow executes this comparison on a disposable
Linux runner, retains both logs/reports/image identities, rejects a deliberately
wrong wheel hash, and runs frontend tests against the pinned Node stage. It also
runs the existing backend/native suite as a non-root user against the installed
application, with only pytest added in a temporary system-site-packages venv.
Pytest's source `pythonpath` override is disabled. Database tests still skip
without the explicit disposable database lane. Reusing content-addressed base layers is
safe; using cached dependency installation layers is not fresh-build evidence.

Before deployment, run the full backend/native fixtures and Processing
PostgreSQL integration suite against the built image, including worker
startup, reuse, cancellation, and shutdown. Issue #375 supplies the disposable
database lane: `python scripts/verify_processing_postgres.py --application-image
eolab-check:two` performs its complete lifecycle acceptance checks. Final combined verification
must follow its merge and #377's development-manifest merge; two matching
inventories alone do not prove application correctness. Keep the draft pending
that verification and coordinated deployment review.

## Intentional updates

1. Start a bounded issue/branch. Retain the previous image and inventory for
   numerical/performance comparisons. Specify the dependency or base to change;
   do not upgrade all packages as a side effect.
2. On the same Linux/Python platform, copy the old runtime pins into a candidate
   constraints file, remove only the pin being updated (and a transitive pin
   only when the resolver demonstrates a required change). Resolve with pip in
   a disposable environment using those constraints and the project metadata.
   Compare the resulting full freeze with the previous inventory; exclude the
   local `eolab` distribution and build/test tools from runtime requirements.
3. Download each selected exact version with `python -m pip download
   --only-binary=:all: --no-deps --dest WHEEL_DIRECTORY -r CANDIDATE_PINS` on
   Linux amd64/Python 3.12. Use `python -m pip hash WHEEL_DIRECTORY/*.whl` to
   obtain SHA-256 hashes and replace the reviewed requirement lines. Use a new,
   empty wheel directory so obsolete artifacts cannot enter the resolution.
   Keep every transitive distribution pinned. Review wheel names, hashes, and
   native library changes, not just top-level package versions.
4. For a build-tool update, download/hash the selected tools separately. Verify
   the backend's declared build requirements and any build-hook requirements
   with the offline, non-isolated EOLab build. For a base update, inspect the
   official registry with `docker buildx imagetools inspect TAG`, record its
   digest in the Dockerfile, and compare Python, OS, Node/npm, and native reports.
5. Run two fresh builds, `pip check`, frontend build/tests, native raster/vector
   fixtures, and the full disposable Processing database lane using the actual
   built image. Record exact commands, commit, and results in the draft PR.
   A deliberately wrong wheel hash must fail installation; restore the
   reviewed hash and repeat the successful build before review.
6. Review changes in inventories alongside test results and existing performance
   baselines. Deploy only as part of coordinated application review; keep the
   PR draft until `richpsharp` verifies deployment behavior.

## Remaining variability

This records application inputs; it does not promise byte-identical OCI images.
Debian's `apt-get` repositories (including `libexpat1`) and Alpine's `apk`
repositories (Git in the version stage) remain mutable. Compare their package
versions and retain images for exact rollback. Mirror/snapshot those repositories
in a separately reviewed change if OS-level reproducibility is required.
Registry availability, wheel availability, Git tag metadata used by
`git describe`, npm lifecycle behavior, timestamps, Docker/BuildKit versions,
host kernel/CPU, and image provenance metadata can also differ. The checked-in
wheel hashes protect artifact identity, not continued availability. Record
hardware and workload separately for performance comparisons. No live source
mount, database, or Processing artifact volume is used by these build checks.
