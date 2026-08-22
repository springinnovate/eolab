# Rendering diagnostics architecture

Issue #91 reviewed rendering diagnostics after the raster, catalog, and HTTP
route boundaries were established. The review selected the issue's focused
split outcome because the merged application has two independent consumers of
previously co-located diagnostics internals:

- the WMS proxy records requests through `diagnostics/tracker.py` without
  needing metrics parsing, response models, or probe transport;
- the diagnostics route declares `diagnostics/models.py` as its public response
  contract without needing the tracker or HTTP implementation.

The former `diagnostics.py` tests also exercised metrics parsing, request
tracking, and probe/cache behavior independently. Those are concrete ownership
and navigation boundaries rather than a reason to split based on line count.

The resulting dependency direction is:

```text
tracker ──────┐
              ├──> models ──┐
metrics ─────────────────────┼──> service
tracker ─────────────────────┘
```

- `metrics.py` owns the allowlisted JMX grammar and validated JVM values.
- `tracker.py` owns bounded, process-local GetMap observations.
- `models.py` owns the strict browser-visible response schema and pure
  ready/busy/degraded classification into that schema.
- `service.py` owns the internal HTTP client, bounded probes, cache and request
  coalescing, and unavailable observations.
- `routes/diagnostics.py` remains the thin FastAPI boundary.

Probe transport stays with the service because both probes share the service's
client, cancellation, cache, and unavailable-observation lifecycle. Extracting
a separate probes module would split that one lifecycle without introducing an
independent consumer. The diagnostics package initializer intentionally does
not re-export a broad API; consumers import the one owned module they require.

Architecture tests keep HTTP transport confined to the service, Pydantic
confined to the models, FastAPI outside the diagnostics package, and the local
import graph acyclic. Focused metrics, tracker, service, and route tests preserve
the existing validation, bounding, cancellation, caching, classification, and
browser-safety contracts.
