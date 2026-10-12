# Naming and documentation review

This review implements [issue #705](https://github.com/springinnovate/eolab/issues/705)
against `main` at `de9bad09832649ba97b5fbfa7f7c14c825178969`. The approved scope is
behavior-preserving naming and documentation improvements. No other pull request
was open when the work began. The model implementation issues that preceded this
review had already merged; their current implementations are the baseline.

The acceptance question is: **Can someone unfamiliar with this implementation
understand the name and first sentence together?** A longer name is useful when
it identifies an action, scientific meaning, mask polarity, unit or lifecycle
that would otherwise require tracing the implementation. Established terms and
clear local names do not need expansion simply to make them longer.

## Findings implemented

These findings are ordered by the misunderstanding they could cause. They do
not infer who or what originally wrote the code.

### Scientific meaning and units

| Location and former name | Revised name or documentation | Why it matters; callers checked |
| --- | --- | --- |
| `processing/area_coverage.py`: `AreaCoverage.mask` | `FractionalAreaCoverage.calculate_cell_coverage` | Returns cell fractions from zero to one, not a Boolean inclusion mask. `ground_area.py` and fractional-area tests consume those fractions. |
| `processing/downstream_runner.py`: `summarize_upstream_values` | `summarize_downstream_covered_values` | “Upstream” meant the original software repository, but suggests the opposite flow direction. The runner summarizes the WWF model's downstream-covered values and preserves its exact `sum(a)` result. |
| Same runner: `mask`, `coverage`, `masked`, `flow`, `total` | `starting_mask_path`, `downstream_coverage_path`, `downstream_covered_values_path`, `flow_direction_path`, `original_model_sum` | Distinguishes starting cells, routed coverage, masked values, routing directions and the original calculation result. Calls into `wwf_es_beneficiaries` retain their order and arguments. |
| Same runner: partition and merged-file locals | Names distinguish partition starting masks, partition coverage, combined coverage and final outputs | A path's role is visible where it is passed to rasterization, routing, stitching or summarization. Output filenames and provenance fields stay unchanged. |
| `raster/source_contract.py`, `sample_grid.py`, `paired_statistics.py`: generic masks | `valid_pixel_mask`, `invalid_pixel_mask`, `invalid_sample_mask`, `samples_outside_selected_polygons`, `invalid_pair_mask` | Makes True's meaning explicit. The source reader, sampled statistics and paired statistics preserve their existing masks and array operations. |
| `raster/categorical_statistics.py`: `sample_cell_ground_weights`, `weights`, `areas` | `estimate_sample_cell_areas_hectares`, `sample_areas_hectares`, `category_areas_hectares` | These are physical areas in hectares, not arbitrary weights or pixel counts. Category totals and percentages retain their calculations. |
| `processing/raster_expression.py`: `Reduction.valid`, `.matched`, `.invalid`, `base` | `valid_pixel_count`, `matched_pixel_count`, `invalid_arithmetic_pixel_count`, `valid_source_pixels` | Separates counts from arrays and source validity from formula validity. `Calculation.result`, direct tests and monkeypatch references were traced; serialized result keys are preserved. |
| `processing/aggregate_windows.py`: `block_extent`, `execution_plan` | `find_raster_block_bounds`, `plan_raster_read_windows` | Names block-index bounds and planning separately from the existing `iter_raster_read_windows` iterator. The planner and iterator use the bounds helper; `raster_aggregate.py` consumes their unchanged read sizes and evaluation tiles. |

Python locations in this section are relative to `src/eolab_app/`.

### Actions, ownership and lifecycle

| Location and former name | Revised name or documentation | Why it matters; callers checked |
| --- | --- | --- |
| `processing/raster_operations.py`, `downstream_operation.py`: `queue_summary`, `queue_clip`, `queue_downstream` | `build_summary_submission`, `build_clip_submission`, `build_downstream_submission` | These construct submission plans; they do not enqueue jobs. Registered operation callbacks and their consumers retain the same interfaces. |
| `processing/service.py`: `public_job` | `serialize_processing_job` | Names the serialization action. The first sentence and arguments make clear that callers must already have authorized the job. All service call sites preserve their authorization order. |
| `processing/raster_input.py`: `native_work` | `estimate_native_raster_reads` | Describes the estimate returned to resource-budget planning. It does not execute a read. |
| `processing/statistics_csv.py`: `csv_text` | `escape_spreadsheet_text` | Identifies the spreadsheet-formula protection applied while producing statistics CSVs. Escaping rules are unchanged. |
| `raster/pixel_service.py`: `_get`, `_read_current` | `_read_with_concurrency_limit`, `_read_authorized_pixel` | Identifies the admission and source-reading responsibilities without moving authorization or adding another pixel reader. |
| `vector/publication.py`: `_filter_context`, `candidate`, `base` | `_prepare_published_filter`, `validated_filter`, `published_layer_name` | Distinguishes filter validation from the resulting published layer. Filtering and GeoServer publication keep their existing owners. |
| `source_files.py`: `_acquire`, `lost`, `heartbeat`, `consumer` | `_acquire_read_lease`, `lease_lost`, `lease_renewal_task`, `reader_task` | Explains which task protects a source from cleanup and which task loses access. Renewal, cancellation, checksum checks and release behavior are preserved. |
| `execution/reusable_process.py`: `_Result`, `_Child`, `_invoke`, `_worker`, `_exchange`, `_retire`, `_ready` | `_CapturedProcessResult`, `_ProcessConnection`, `_run_target_and_collect_result`, `_serve_process_requests`, `_exchange_process_request`, `_stop_child_process`, `_wait_until_child_ready` | Distinguishes a process connection from its result and names the operations on both. Public executor methods, subprocess targets, pipe messages and lifecycle tests were checked. |
| `services/jobs/job_service/manager.py`: `Record`, `_owned`, `_maintain` | `JobRecord`, `_get_owned_job`, `_expire_queued_jobs_and_remove_old_records` | Makes the record type, ownership check and retention cleanup explicit. Cleanup removes entire terminal records and retry reservations, including jobs with no result. |
| `frontend/src/main.js`: `clipSource`, `mapBounded` | `describeCalculationSource`, `mapWithConcurrencyLimit` | The source descriptor also serves models, statistics and vectors. The mapping helper limits concurrent transformations. Internal callers and the dynamic test binding were updated. |
| `frontend/src/models/view.js`: `s`, `usesMask` | `setupControls`, `usesStartingMask` | Makes the controls and the scientific input identifiable while reading a long setup function. DOM keys, labels and interactions are unchanged. |
| Frontend raster and preview helpers: `normalizeParticipants`, `normalizePixel`, `check`, `opaqueId` | Action/object names such as `validatePointSampleRasters`, `selectCursorSampleRasters`, `normalizePointSampleResult`, `validatePreviewCoordinates`, `validateProcessingId` | Distinguishes selection, validation and presentation. Exported interfaces, request shapes, ownership checks and UI messages are preserved. |
| GeoServer `CategoricalRasterFunction` private helpers | `buildColorMap`, `replaceReadParameter`, `parseOpacity`, `parseColor` and descriptive range locals | Explains map construction and parsing without changing function registration, color boundaries, NoData handling or the GeoTools interface. |

Python locations without another prefix are relative to `src/eolab_app/`.

### Incorrect or incomplete documentation

- `processing/job_events.py`, `Subscription.wait`: a closed subscription raises
  `ProcessingError`; the previous documentation incorrectly described it as a
  successful wake-up. Timeout and notification behavior are now distinguished.
- `diagnostics/metrics.py`, `parse_jmx_metrics`: garbage-collection metrics use
  the `gc` label, not the previously documented `collector` label. The parser is
  unchanged.
- `routes/rasters.py` and raster source documentation: reads can address catalog
  rasters or authorized run outputs. Descriptions that implied catalog-only
  access no longer contradict the source contract.
- `services/jobs/job_service/app.py`, `models.py`, and `routes/jobs_proxy.py`:
  documentation describes the currently supported operations and the HTTP 501
  responses for unsupported file/event routes, instead of a future implementation
  plan or a diagnostic-only service.
- `catalog/geojson.py`: validator and bounds-accumulator names explain their
  purpose. Bounds are longitude/latitude minima and maxima; documentation does
  not claim a shortest rectangle across the antimeridian.
- `vector/fields.py` and `bounded_geometry.py`: documentation identifies the
  checks actually performed and their position in feature reading. It does not
  claim that the field loop owns the caller's timeout or that geometry validation
  precedes reading the feature.
- Module, class and function openings across Processing, rendering, source access,
  browser controllers and the Jobs client now explain behavior before detailing
  resource limits, authorization or architectural relationships. Relevant limits,
  cancellation, exceptions and expiry details remain documented.

## Contracts and architecture

The existing components retain ownership of their behavior. They are **used by**
the same routes, workers and browser composition code; **depend on** the same
source readers, storage, execution mechanisms and external libraries; and
**coordinate with** the same peers through the existing interfaces. No subsystem
acquires knowledge of a sibling. There are no new, removed or redirected
cross-subsystem dependency relationships, services, rendering paths or readers.

Internal Python imports and operation callback references follow the renamed
symbols. No compatibility aliases were added. HTTP operation identities, schema
fields, YAML keys and model IDs, database fields, CLI arguments, environment
settings, JavaScript exports, DOM/storage keys and external-library signatures
are retained. Docstrings used as OpenAPI descriptions change; schema structure
and request/response behavior do not.

The existing implementation checksum includes application Python source bytes.
These edits therefore change that checksum even though calculation behavior is
preserved. API and worker deployments must use the same build, as already
required by model execution. The checksum policy itself is unchanged.

## No change recommended

- Scientific and library terms such as raster, grid, window, NoData, SLD, CRS,
  `sum`, `mean` and `stdev` remain appropriate. Local coordinate names such as
  `x`, `y`, row and column retain their established meaning.
- Public fields such as `mask`, `upstreamTotal`, operation IDs and upstream WWF
  argument names remain compatible where they are part of persisted or external
  contracts. Private callers can clarify their meaning without changing them.
- The original WWF package and its calculations remain unchanged. The wrapper's
  variable names now identify their scientific roles more precisely.
- Existing validation, polling, leases, cancellation and resource limits retain
  their owners and behavior. Repetition alone was not treated as removable debt.
- Existing clear names such as `discover_models`, `download_model_yaml` and
  `compute_implementation_checksum` require no replacement.

## Coverage and verification

The review screened signatures, module/class/function documentation and naming
patterns across the handwritten backend, Processing, standalone Jobs service,
browser source, relevant scripts and GeoServer extension. It inventoried all
140 browser source modules, searched their tests and support files, and traced
implementations, consumers and tests for every changed symbol. Backend review
included 41 Processing modules plus the hydrology CLI, 85 raster/vector/rendering/catalog modules and
the remaining routes, execution, configuration, diagnostics, source utilities,
service and client code. README and component documentation were consulted for
the supported contracts; current implementation determined each finding.

This is not a claim that every untouched local variable or test fixture was
manually reviewed line by line. Generated bundles, lockfiles, vendored code,
third-party packages and old generated artifacts are outside the review. No
style-only issue was opened for an unchanged name that already conveys its role.

Verification combines existing component and integration tests with comparisons
of executable syntax after reversing explicit, reviewed internal renames and
removing documentation. The comparisons preserve production literals, operators,
control flow and public keys; added type annotations and the same-buffer mask
alias are separately reviewed. Java executable tokens receive the same check.
Independent reviews specifically check mask polarity, scientific units,
dynamic references, cleanup, cancellation and serialization.

The pull request records the exact test commands, results, environmental skips
and final-commit CI runs. Numerical checks include all seven existing direct
WWF CLI versus EOlab-wrapper output comparisons. Full Linux application, native
GeoServer and disposable PostgreSQL checks complement local Windows tests.
