"""Shared JMX exporter document for diagnostics contract tests."""


VALID_METRICS = """
# HELP exporter_self_metric ignored
jmx_scrape_duration_seconds 0.001
eolab_jvm_heap_used_bytes 2.68435456E8
eolab_jvm_heap_committed_bytes 5.36870912E8
eolab_jvm_heap_max_bytes 1.073741824E9
eolab_jvm_process_cpu_load_ratio 0.125
jvm_gc_collection_seconds_count{gc="G1 Concurrent GC"} 10
jvm_gc_collection_seconds_sum{gc="G1 Concurrent GC"} 0.056
jvm_gc_collection_seconds_count{gc="G1 Old Generation"} 0
jvm_gc_collection_seconds_sum{gc="G1 Old Generation"} 0.0
jvm_gc_collection_seconds_count{gc="G1 Young Generation"} 32
jvm_gc_collection_seconds_sum{gc="G1 Young Generation"} 0.305
eolab_jvm_live_threads 42.0
eolab_jvm_uptime_seconds 3600.5
""".strip()
