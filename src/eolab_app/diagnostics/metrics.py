"""Strict parsing for EOLab's allowlisted JMX exporter metrics."""

import math
import re
from dataclasses import dataclass


_NUMBER_PATTERN = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?"
_METRIC_LINE_PATTERN = re.compile(
    rf"^(?P<name>[a-zA-Z_:][a-zA-Z0-9_:]*)"
    rf"(?P<labels>\{{[^\r\n]*\}})?\s+"
    rf"(?P<value>{_NUMBER_PATTERN})$"
)
_GC_LABEL_PATTERN = re.compile(r'^\{gc="(?:[^"\\]|\\.)+"\}$')
_SINGLETON_METRICS = {
    "eolab_jvm_heap_used_bytes": "heap_used_bytes",
    "eolab_jvm_heap_committed_bytes": "heap_committed_bytes",
    "eolab_jvm_heap_max_bytes": "heap_max_bytes",
    "eolab_jvm_process_cpu_load_ratio": "process_cpu_load_ratio",
    "eolab_jvm_live_threads": "live_threads",
    "eolab_jvm_uptime_seconds": "uptime_seconds",
}
_GC_COUNT_METRIC = "jvm_gc_collection_seconds_count"
_GC_SECONDS_METRIC = "jvm_gc_collection_seconds_sum"


@dataclass(frozen=True)
class JvmMetrics:
    """Validated values parsed from the project-owned exporter contract."""

    heap_used_bytes: int
    heap_committed_bytes: int
    heap_max_bytes: int
    process_cpu_load_ratio: float
    garbage_collection_count: int
    garbage_collection_seconds: float
    live_threads: int
    uptime_seconds: float


class RenderingDiagnosticsError(ValueError):
    """Internal diagnostics did not satisfy the owned input contract."""


def _parse_metric_value(value_text: str) -> float:
    """Parse one finite numeric sample from the JVM metrics document.

    Args:
        value_text: Text representation captured from one metric line.

    Returns:
        The parsed finite floating-point value.

    Raises:
        ValueError: If the text is not numeric.
        RenderingDiagnosticsError: If the parsed value is not finite.
    """
    value = float(value_text)
    if not math.isfinite(value):
        raise RenderingDiagnosticsError("Metric values must be finite")
    return value


def _as_nonnegative_integer(value: float, metric_name: str) -> int:
    """Validate one integer-valued counter or byte quantity.

    Args:
        value: Parsed finite metric value.
        metric_name: Metric description used in contract errors.

    Returns:
        The validated nonnegative integer.

    Raises:
        RenderingDiagnosticsError: If the value is negative or fractional.
    """
    if value < 0 or not value.is_integer():
        raise RenderingDiagnosticsError(
            f"{metric_name} must be a nonnegative integer"
        )
    return int(value)


def parse_jmx_metrics(document: str) -> JvmMetrics:
    """Parse only the metrics emitted by EOLab's owned JMX exporter rules.

    Unknown exporter self-metrics are ignored. Every EOLab singleton must
    appear exactly once, and garbage-collector samples must use only the owned
    ``collector`` label so no upstream label can enter the browser contract.

    Args:
        document: Complete bounded UTF-8 JVM metrics document.

    Returns:
        Validated allowlisted JVM measurements.

    Raises:
        RenderingDiagnosticsError: If a required metric is missing, repeated,
            malformed, nonfinite, mislabeled, or outside its numeric contract.
        ValueError: If a matched numeric sample cannot be converted to float.
    """
    singleton_values: dict[str, float] = {}
    garbage_collection_counts: dict[str, int] = {}
    garbage_collection_seconds: dict[str, float] = {}

    for raw_line in document.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = _METRIC_LINE_PATTERN.fullmatch(line)
        if match is None:
            if line.startswith(("eolab_jvm_", "jvm_gc_collection_seconds_")):
                raise RenderingDiagnosticsError("Malformed required metric line")
            continue

        metric_name = match.group("name")
        labels = match.group("labels")
        if metric_name in _SINGLETON_METRICS:
            field_name = _SINGLETON_METRICS[metric_name]
            if labels is not None or field_name in singleton_values:
                raise RenderingDiagnosticsError(
                    f"{metric_name} must be one unlabeled sample"
                )
            singleton_values[field_name] = _parse_metric_value(
                match.group("value")
            )
            continue

        if metric_name not in {_GC_COUNT_METRIC, _GC_SECONDS_METRIC}:
            continue
        if labels is None or _GC_LABEL_PATTERN.fullmatch(labels) is None:
            raise RenderingDiagnosticsError(
                f"{metric_name} must use exactly one gc label"
            )
        values_by_collector = (
            garbage_collection_counts
            if metric_name == _GC_COUNT_METRIC
            else garbage_collection_seconds
        )
        if labels in values_by_collector:
            raise RenderingDiagnosticsError(
                f"{metric_name} must not repeat a collector"
            )
        metric_value = _parse_metric_value(match.group("value"))
        if metric_name == _GC_COUNT_METRIC:
            values_by_collector[labels] = _as_nonnegative_integer(
                metric_value,
                metric_name,
            )
        else:
            if metric_value < 0:
                raise RenderingDiagnosticsError(
                    f"{metric_name} must be nonnegative"
                )
            values_by_collector[labels] = metric_value

    missing_singletons = set(_SINGLETON_METRICS.values()) - singleton_values.keys()
    if missing_singletons:
        raise RenderingDiagnosticsError("Required JMX metrics are missing")
    if (
        not garbage_collection_counts
        or garbage_collection_counts.keys() != garbage_collection_seconds.keys()
    ):
        raise RenderingDiagnosticsError(
            "Garbage-collection metrics must identify the same collectors"
        )

    heap_used_bytes = _as_nonnegative_integer(
        singleton_values["heap_used_bytes"],
        "heap used bytes",
    )
    heap_committed_bytes = _as_nonnegative_integer(
        singleton_values["heap_committed_bytes"],
        "heap committed bytes",
    )
    heap_max_bytes = _as_nonnegative_integer(
        singleton_values["heap_max_bytes"],
        "heap maximum bytes",
    )
    if not (
        0 < heap_max_bytes
        and 0 <= heap_used_bytes <= heap_committed_bytes <= heap_max_bytes
    ):
        raise RenderingDiagnosticsError("JVM heap values are not ordered")

    process_cpu_load_ratio = singleton_values["process_cpu_load_ratio"]
    if not 0 <= process_cpu_load_ratio <= 1:
        raise RenderingDiagnosticsError("Process CPU load must be from zero to one")
    live_threads = _as_nonnegative_integer(
        singleton_values["live_threads"],
        "live threads",
    )
    uptime_seconds = singleton_values["uptime_seconds"]
    if uptime_seconds < 0:
        raise RenderingDiagnosticsError("JVM uptime must be nonnegative")

    garbage_collection_seconds_total = sum(garbage_collection_seconds.values())
    if not math.isfinite(garbage_collection_seconds_total):
        raise RenderingDiagnosticsError(
            "Garbage-collection time must have a finite total"
        )

    return JvmMetrics(
        heap_used_bytes=heap_used_bytes,
        heap_committed_bytes=heap_committed_bytes,
        heap_max_bytes=heap_max_bytes,
        process_cpu_load_ratio=process_cpu_load_ratio,
        garbage_collection_count=sum(garbage_collection_counts.values()),
        garbage_collection_seconds=garbage_collection_seconds_total,
        live_threads=live_threads,
        uptime_seconds=uptime_seconds,
    )
