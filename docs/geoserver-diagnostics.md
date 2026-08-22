# GeoServer rendering diagnostics

EOLab's **Rendering diagnostics** disclosure combines two deliberately small
sources. A pinned Prometheus JMX Exporter Java agent reads an allowlist of JVM
MBeans inside GeoServer, while the EOLab WMS proxy records only aggregate
GetMap outcomes. The browser receives neither raw Prometheus text nor request
labels.

The disclosure refreshes every five seconds while it is open, every 60 seconds
while it is closed, and stops while the browser tab is hidden. EOLab's own
`/healthz` remains independent of GeoServer and the metrics exporter.

## Metric meanings

| Displayed value | Source and meaning |
| --- | --- |
| Java heap | `MemoryMXBean.HeapMemoryUsage`; used, committed, and maximum bytes. The maximum comes from the JVM `-Xmx` value configured by `EOLAB_GEOSERVER_MAX_HEAP_SIZE`, not host RAM. |
| GeoServer process CPU | `OperatingSystemMXBean.ProcessCpuLoad`, shown as a percentage of the CPU capacity visible to the JVM. Docker's `EOLAB_GEOSERVER_CPU_LIMIT` controls that visible capacity. |
| Garbage collection | Sum of the Java agent's standard `jvm_gc_collection_seconds_count` and `_sum` series across its bounded `gc` labels, cumulative since GeoServer started. |
| Live threads | Current `ThreadingMXBean.ThreadCount` inside GeoServer's JVM. |
| JVM uptime | Time since the current GeoServer JVM started. |
| Active GetMaps | Valid public GetMap requests currently passing through EOLab. The displayed concurrency limit comes from `EOLAB_GEOSERVER_WMS_RENDER_COUNT`. |
| Completed GetMaps | Process-local cumulative completions since the EOLab app started. |
| Latest GetMap | End-to-end time measured at EOLab's WMS proxy. It includes time queued by GeoServer's control-flow extension, rendering, and response transfer back to EOLab. |
| Recent failures | Non-2xx responses or non-PNG results in the last 100 completed GetMap requests retained in memory. This catches OGC exception documents returned with HTTP 200. The window and cumulative count reset when the EOLab app restarts. |

The server owns the displayed state:

- **Ready** means the WMS readiness probe and all required JVM metrics are
  current and no busy or degraded condition applies.
- **Busy** means a GetMap is active, Java heap is at least 75%, or GeoServer
  process CPU is at least 80%.
- **Degraded** means the most recently completed GetMap failed or Java heap is
  at least 90%.
- **Unavailable** means WMS readiness or the allowlisted metrics cannot be
  fetched and validated. Missing, oversized, malformed, or non-finite metrics
  all fail closed to this same browser-safe state.

These thresholds describe operator attention states; they do not restart a
container or change GeoServer's rendering limits.

## Security boundary

The JMX Exporter listens on port 9404 only inside the Compose network. Compose
does not publish that port, and EOLab does not proxy it. The public diagnostics
endpoint returns a fixed JSON schema containing numeric summaries only: no
GeoServer credentials, metric labels, internal URLs, resource names, paths, or
exception bodies. GeoServer administrative REST and Monitor endpoints remain
private.

GeoServer's Monitor Micrometer community module was evaluated for this
milestone but is not installed. Its raw request metrics include resource and
error-message labels, and its community artifact lifecycle is separate from
the stable GeoServer extension release. EOLab already owns the restricted WMS
boundary, so measuring GetMap there provides bounded request counts, durations,
response outcomes, and failures without adding that cardinality or packaging
risk.

Container RSS, network traffic, restart counts, and OOM-event history are not
JVM metrics. A later host-level Prometheus/cAdvisor deployment can provide
those values without giving EOLab the Docker socket or privileged host mounts.

## Coolify acceptance record

Complete this table against the draft deployment before marking the PR ready.
Use the disclosure in the EOLab UI; the raw metrics port should not be reachable
through the public domain.

| Scenario | State and readings | Observed behavior |
| --- | --- | --- |
| Idle for two expanded refreshes | Pending | Pending |
| Successful GetMap from a small raster | Pending | Pending |
| Expensive GetMap from an eligible large raster | Pending | Pending |
| GeoServer restart and recovery | Pending | Pending |

For the restart check, EOLab's catalog, scanner, map, and `/healthz` must remain
available while rendering diagnostics become **Unavailable**, then return to a
current state after GeoServer is healthy. For the expensive request, record
heap, CPU, active requests, latest duration, recent failures, and whether
GeoServer remained healthy.

## Upstream references

- [Prometheus JMX Exporter Java agent](https://prometheus.github.io/jmx_exporter/deployment/java-agent/)
- [JMX Exporter rule configuration](https://prometheus.github.io/jmx_exporter/configuration/rules/)
- [GeoServer Monitor Micrometer metrics](https://docs.geoserver.org/3.0.x/en/user/community/monitor-micrometer/usage/)
- [GeoServer Monitor Micrometer cardinality settings](https://docs.geoserver.org/3.0.x/en/user/community/monitor-micrometer/configuration/)
