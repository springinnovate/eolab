# Catalog dataset-handler extension contract

EOLab's mounted-source scanner treats a source dataset and a STAC Item as different units. One discovered source is processed exactly once, but its handler may emit zero, one, or several Items. The coordinator batches every emitted Item by Collection and writes it through the existing bounded bulk-upsert path.

The currently registered formats are GeoTIFF, GeoPackage, mounted Shapefile, ZIP-contained Shapefile, GeoJSON FeatureCollection, and Esri File Geodatabase.

## Registry composition

`create_default_dataset_handler_registry()` in `src/eolab_app/catalog/handlers.py` is the composition root. It returns an ordered `DatasetHandlerRegistry` containing explicit `DatasetHandler` values. Each handler has:

- a stable, unique `name` carried by every `DatasetCandidate` it recognizes;
- a `discover` callable that inspects one deterministic directory listing; and
- a `build_items` callable that receives the mounted root and one candidate, then returns a tuple containing zero or more complete STAC Items.

Discovery and metadata extraction share the same registry instance. Metadata dispatch uses `DatasetCandidate.handler_name`; it does not infer a handler from the candidate's suffix. Format-specific suffix or directory-name recognition belongs only inside that format's discovery callable.

To add a format, implement its discovery and Item-building functions beside its format-specific metadata code, then add exactly one `DatasetHandler` to the default registry. Do not add a switch to discovery, metadata, or the scan coordinator.

## Discovery and containers

A discovery callable receives the current `directory_path`, sorted `directory_names`, and sorted `file_names`. It returns `HandlerDiscovery` with:

- zero or more `DatasetMatch` values, each containing a primary file or container path and optional companion paths; and
- zero or more `pruned_directory_names` drawn from the supplied child-directory listing.

A directory-backed format should return the container directory as a match and return that directory name in `pruned_directory_names`. `FilesystemDatasetDiscovery` then removes it from `os.walk`'s mutable traversal list, so files inside the container cannot become independent GeoTIFF, Shapefile, or other candidates. The registry rejects pruning names that were not in the listing and rejects two handlers claiming the same primary path. Final candidates are sorted by mount-relative POSIX path, independent of configured source-path order or filesystem enumeration order.

File Geodatabase is the directory-container implementation: its handler recognizes `.gdb` child directories case-insensitively, returns the container as one source dataset, and prunes all traversal below it. ZIP/Shapefile is a single-file container and therefore needs no directory pruning. Its handler validates one archive and emits one Item per valid internal Shapefile in deterministic internal-path order. A structurally valid ZIP with no `.shp` member is an unrelated archive and completes successfully with zero Items. Once a `.shp` candidate is present, the handler reads members directly through GDAL's `/vsizip/` filesystem, enforces explicit archive and decompression ceilings before metadata access, and never extracts temporary files. Invalid internal Shapefiles are logged independently so valid siblings remain catalogable; when none are valid, the source archive returns one captured dataset error.

The File Geodatabase handler uses Fiona with an explicit `OpenFileGDB` driver allowlist and verifies that GDAL selected that driver for every layer. It emits one Item per readable spatial feature class, skips nonspatial tables, and isolates a failing layer when another spatial layer remains readable. Each Item ID hashes the mount-relative geodatabase path together with the exact layer name, so rescans and mounts at different host roots preserve identity. Every layer Item points its data Asset at the user-provided `.gdb` location. Because feature classes do not provide a standardized timestamp used by EOLab, all Items from a geodatabase use the latest filesystem modification time among the container directory and its descendants.

## Metadata results and failures

`DatasetMetadataResult.items` is always a tuple:

- an empty tuple means successful processing that intentionally produced no Items;
- a one-element tuple preserves GeoTIFF and mounted Shapefile behavior; and
- a larger tuple represents a multi-layer or otherwise multi-Item source.

If a builder raises, the worker captures one source-dataset error and returns no Items. If any emitted Item has no geometry, the whole source result fails because pgSTAC requires geometry. A failed source does not stop unrelated candidates. A catalog inventory or bulk-write failure remains systemic and stops the scan while cancelling sibling work as before.

The GeoPackage, ZIP/Shapefile, and File Geodatabase handlers perform narrower isolation inside their multi-dataset sources: expected open or spatial-metadata failures for one layer or internal Shapefile are logged and skipped, so valid siblings can still produce Items. If candidates were present but no spatial vector dataset remains catalogable, the handler raises and the worker reports the normal source-dataset error. GeoPackage and File Geodatabase nonspatial attribute tables and valid ZIP archives without `.shp` members are successful zero-Item conditions, not dataset failures. This behavior stays inside each focused handler because the shared result contract intentionally has no partially successful error shape.

Each emitted Item must use a Collection from `SCAN_COLLECTION_IDENTIFIERS`. A future vector handler should normally use `eolab-mounted-vectors`; adding a new Collection requires an explicit catalog ownership and reconciliation decision rather than an implicit handler side effect. Item IDs must be stable functions of the mount-relative source identity and, for multi-Item datasets, the layer identity. Existing GeoTIFF and Shapefile ID functions must not change.

## Progress and batching

The scan response exposes these unambiguous counters:

- `sourceDatasetsDiscovered`: logical candidates recognized by handlers;
- `sourceDatasetsProcessed`: metadata results consumed, including zero-Item successes and failures;
- `catalogItemsProduced`: Items emitted by successful metadata results; and
- `catalogItemsWritten`: Items successfully bulk-upserted.

`catalogItemsAlreadyPresent` classifies written Items against the pre-scan `(collection, item ID)` inventory. The older `discovered`, `processed`, `indexed`, and `alreadyInCatalog` fields remain compatibility aliases. Produced Items can temporarily exceed written Items while bounded writes are pending, and a completed zero-Item source increments only the source processed count.

Items are buffered independently by Collection. Multiple Items from one source may fill a batch or span batches, and the configured writer limit, cancellation, and final partial-batch flush apply unchanged.

## Shared vector conventions

Vector handlers should use `build_vector_table_properties()` and `build_bbox_polygon()` from `src/eolab_app/catalog/vector.py`. They provide the shared bounding-box footprint and record:

- `table:row_count` for feature count;
- `table:columns` with the shared `geometry` column followed by real attribute fields; and
- `table:primary_geometry` naming that geometry column.

Handlers should include the published STAC Table Extension URL and Projection Extension metadata that the source can actually provide. They must not emit empty format-specific properties for unavailable values. The Catalog inspector reads these Table and Projection Extension fields data-first: feature count, declared geometry type, and attribute rows appear only when present. This preserves current Shapefile presentation while allowing another vector handler to reuse the same inspector without format checks.

Format-specific Assets, media types, timestamps, layer selection, and ID rules remain in the focused handler. The GeoPackage handler records the exact layer name as `eolab:geopackage_layer` on both the Item and its container Asset; its Item title combines the mount-relative container path and layer name so existing text search and inspector presentation identify both. The File Geodatabase handler records the exact layer name as `eolab:layer_name` on the Item and Asset and adds `eolab:layer_alias` to the Item only when GDAL exposes an alias. Shared vector conventions are not permission to flatten distinct container or multi-layer semantics into a broad utility.

After format metadata extraction, scanner finalization normalizes every vector Item into the closed `eolab:vector_source` contract and records the deployed rendering decision in `eolab:vector_rendering`. A new handler must provide an unambiguous primary Asset and exact native layer identity that this finalizer can validate. Publication capabilities and extension steps are documented in [Catalog vector publication contract](vector-publication.md); catalog support by itself never implies browser rendering support.

### GeoJSON streaming and CRS contract

The GeoJSON handler recognizes only `.geojson` files and treats one FeatureCollection as one source and one Item. It incrementally parses the document and materializes at most one feature at a time. Aggregate memory is therefore independent of feature count and file size except for the current feature, while the retained schema is capped at 1,024 property names of at most 1,024 characters each. Exceeding either schema limit produces one isolated dataset error rather than unbounded memory growth.

RFC 7946 defines GeoJSON coordinates as WGS 84 longitude and latitude. A missing or null legacy `crs` member follows that standard. For compatibility, the handler also accepts a legacy named CRS only when it unambiguously identifies EPSG:4326 or OGC CRS84. Any projected, linked, unknown, or malformed legacy CRS declaration is rejected; the scanner never guesses or silently reprojects GeoJSON coordinates. Coordinate positions must contain finite numeric axes within longitude and latitude ranges.

Property columns preserve every observed JSON type in deterministic union strings, so mixed scalar types and explicit nulls are not narrowed to an inaccurate inferred type. A property omitted from some features does not invent a null value. Geometry types use the same union convention. The handler computes the footprint from streamed coordinates instead of trusting an optional source `bbox` member.

## Required tests for a new handler

A focused format PR should cover its recognition and pruning behavior, deterministic mount-relative identity, zero/one/multi-Item cardinality as applicable, mixed valid and invalid sources, stable rescan IDs, STAC metadata and Assets, and absence of empty optional fields. It must also run the full Python suite, frontend tests when inspector/status behavior is affected, and the frontend production build.
