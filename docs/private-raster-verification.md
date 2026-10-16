# Private raster checksum verification

Private raster statistics and metadata verify the original file before using
the numerical cache or reading metadata. This detects changed output files even
when their previously computed statistics are still cached. Pixel picking keeps
its separate short-read contract described in [raster analysis](raster-analysis.md).

## Decision

Two overlapping checks for the same authorized file share one unfinished
checksum scan. Each request still acquires and renews its own lease, occupies
one of the existing two verification admission slots, and rechecks ownership,
expiry and file metadata before delivery. The sharing key includes the owner,
run, file, resolved path, published size/checksum/media type, and current file
stat identity. A different identity starts an independent check.

Cancelling either caller leaves the other protected by its own lease. The last
departing caller stops and joins the supervised scan before releasing its slot
and lease. Verification retains its 30-second deadline. No additional requests
are admitted and there is no new queue.

Completed verification results are **not cached**. A later request performs a
fresh checksum scan, including a request whose numerical statistics are cached.
Publication metadata or a matching stat tuple alone does not replace the
existing content-integrity check. Each caller also checks current file identity
before starting its consumer read and again before delivery.

The neutral `LeasedSourceFiles` component owns this behavior. Its existing
consumers are raster statistics, raster metadata and GeoJSON previews; its
providers are the injected file authority and supervised-process runner.
Processing continues to supply ownership and lease callbacks through application
composition. No subsystem acquires a dependency on a sibling, and no HTTP or
numerical contract changes.

## Reproduce the measurements

Run in the repository's Python environment:

```powershell
$env:PYTHONPATH = 'src'
python scripts/benchmark_private_raster_verification.py --output data/verification/baseline.json
```

Run the same command against the version being compared, using a different
output filename. The default measures three repetitions for each of 1, 64 and
256 MiB pixel payloads. Each size creates two distinct, uncompressed, tiled,
single-band float32 GeoTIFFs. The actual file sizes, including TIFF metadata,
are recorded separately. Generated files remain under `synthetic-rasters` beside
the JSON report so their location and disk use are explicit.

The script calls the real `RasterStatisticsService`, `RasterSourceAccess` and
`LeasedSourceFiles` boundaries, including numerical readers and supervised native
processes. Only persistent storage is replaced with an in-memory authority that
checks ownership and tracks separate leases. Inside the real verification child,
instrumentation counts bytes passed to SHA-256 and measures the checksum scan;
it does not substitute a successful verification result.

For ordinary and paired statistics, the cases are first access with an empty
result cache, repeated access to that cache, two simultaneous callers with a
warm cache, and two simultaneous callers with an empty cache. Paired statistics
uses two distinct files. Metadata has no result cache; the report labels it
accordingly. Reports include raw samples, medians, actual hash calls and bytes,
elapsed request-group time, summed child/supervisor durations, and authorization
check counts. Concurrent durations overlap and must not be added to wall time.

## Measurement conditions and limits

The baseline is `main` at `6ce5f652169e778d443ae56e43ea3653c693ec2f`.
The local environment is Windows 11, Python 3.12.14, Rasterio 1.5.2 with
GDAL 3.12.2, and NumPy 2.5.4. All measurements use a **warm operating-system
cache** because preparing and publishing the synthetic files reads them first.
An empty numerical cache is not a cold disk cache.

These measurements establish the duplicate bytes and hash work, not production
latency or physical disk traffic. Windows process startup dominates small files;
Linux startup, real output compression, concurrent server load, network latency
and database authorization costs differ. The in-memory authority does not
measure database or HTTP costs. No production speedup is claimed from this
local benchmark.

Sequential cached requests deliberately retain their verification cost. The
change addresses overlapping duplicate scans only; it does not remove integrity
checks or change Processing calculation limits.

## Before and after

All 108 corresponding samples retained the same authorization-check counts.
For every overlapping two-caller case, hash calls and bytes were halved:
ordinary statistics and metadata went from two scans to one; paired statistics
went from four scans to two. First and repeated single-caller requests kept
their original scan counts and bytes. No source leases remained after a group.

For two concurrent paired-statistics requests with 256 MiB per input, verified
bytes fell from **1,073,776,104 to 536,888,052**, with all eight authorization
checks preserved. Those are bytes read into the checksum calculation, not
measured physical-device reads.

Median elapsed seconds for two concurrent callers, before → after:

| Pixel payload per file | Cached statistics | Cached paired statistics | Metadata |
| --- | --- | --- | --- |
| 1 MiB | 0.833 → 0.761 | 1.702 → 1.522 | 1.702 → 1.631 |
| 64 MiB | 0.891 → 0.809 | 1.790 → 1.631 | 1.896 → 1.733 |
| 256 MiB | 1.087 → 1.021 | 2.176 → 1.924 | 1.991 → 1.814 |

The repeatable benefit is avoiding duplicate reads and process launches for
overlapping checks. Local elapsed-time changes are modest and are subject to
the environment limits above; they are not a Resilience performance prediction.
