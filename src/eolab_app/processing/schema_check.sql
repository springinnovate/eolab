-- Compare the installed Processing objects with the interfaces used by this worker.
-- An existing schema is read only. Operator grants and unrelated indexes are immaterial.
WITH required_relations(name, kind, columns) AS (VALUES
    ('schema_version', 'r', 'version:int4!'),
    ('jobs', 'r',
     'id:text! created_at:timestamptz! updated_at:timestamptz! expires_at:timestamptz! status:text! '
     'spec:jsonb reserved_bytes:int8! summary:jsonb! attempt_id:text lease_until:timestamptz '
     'progress:jsonb! artifact:jsonb error:jsonb operation:text! started_at:timestamptz work_key:text '
     'retained_metadata:jsonb retained_outcome:jsonb '
     'metadata_expires_at:timestamptz metadata_ttl_seconds:int8! result_ttl_seconds:int8 input_uploads:jsonb!'),
    ('job_subscribers', 'r',
     'id:text! job_id:text! owner:text! request_key:text! request_hash:text created_at:timestamptz! '
     'updated_at:timestamptz! status:text presentation:jsonb deletion_id:text deletion_undo_until:timestamptz status_before_deletion:text'),
    ('subscribed_jobs', 'v',
     'id:text owner:text request_key:text request_hash:text presentation:jsonb job_id:text created_at:timestamptz '
     'subscribed_at:timestamptz updated_at:timestamptz expires_at:timestamptz status:text operation:text spec:jsonb '
     'reserved_bytes:int8 attempt_id:text lease_until:timestamptz progress:jsonb artifact:jsonb '
     'error:jsonb summary:jsonb metadata_expires_at:timestamptz deletion_id:text deletion_undo_until:timestamptz '
     'retained_metadata:jsonb retained_outcome:jsonb'),
    ('transfers', 'r', 'id:text! job_id:text! expires_at:timestamptz!'),
    ('calculation_results', 'r', 'cache_key:text! payload:jsonb! created_at:timestamptz! expires_at:timestamptz!'),
    ('inputs', 'r', 'id:text! owner:text! sha256:text! payload:jsonb! bytes:int4! expires_at:timestamptz!'),
    ('input_files', 'r', 'job_id:text! parent_id:text! run_id:text! artifact_id:text! sha256:text! bytes:int8!'),
    ('habitat_preparation_selections', 'r', 'selection:jsonb!')
),
required_indexes(name, relation, method, columns, is_unique, is_partial) AS (VALUES
    ('schema_version_pkey', 'schema_version', 'btree', 'version', true, false),
    ('jobs_pkey', 'jobs', 'btree', 'id', true, false),
    ('jobs_status', 'jobs', 'btree', 'status created_at', false, false),
    ('jobs_active_work', 'jobs', 'btree', 'work_key', true, true),
    ('jobs_cleaned_history', 'jobs', 'btree', 'updated_at', false, true),
    ('jobs_pending_cleanup', 'jobs', 'btree', 'updated_at', false, true),
    ('jobs_reserved_bytes', 'jobs', 'btree', 'reserved_bytes', false, true),
    ('job_subscribers_pkey', 'job_subscribers', 'btree', 'id', true, false),
    ('job_subscribers_owner_request_key_key', 'job_subscribers', 'btree', 'owner request_key', true, false),
    ('subscribers_job', 'job_subscribers', 'btree', 'job_id', false, false),
    ('subscribers_owner', 'job_subscribers', 'btree', 'owner created_at', false, false),
    ('transfers_pkey', 'transfers', 'btree', 'id', true, false),
    ('transfers_job', 'transfers', 'btree', 'job_id expires_at', false, false),
    ('calculation_results_pkey', 'calculation_results', 'btree', 'cache_key', true, false),
    ('calculation_results_expiry', 'calculation_results', 'btree', 'expires_at', false, false),
    ('inputs_pkey', 'inputs', 'btree', 'id', true, false),
    ('inputs_expiry', 'inputs', 'btree', 'expires_at', false, false),
    ('input_files_pkey', 'input_files', 'btree', 'job_id run_id artifact_id', true, false),
    ('input_files_parent', 'input_files', 'btree', 'parent_id', false, false),
    ('habitat_preparation_selections_selection', 'habitat_preparation_selections', 'hash', 'selection', false, false)
),
required_constraints(relation, names) AS (VALUES
    ('jobs', 'jobs_status_check jobs_reserved_bytes_check jobs_metadata_ttl_seconds_check jobs_result_ttl_seconds_check'),
    ('job_subscribers', 'job_subscribers_job_id_fkey job_subscribers_status_check job_subscribers_presentation_check job_subscribers_status_before_deletion_check'),
    ('transfers', 'transfers_job_id_fkey'),
    ('calculation_results', 'calculation_results_cache_key_check calculation_results_payload_check'),
    ('inputs', 'inputs_bytes_check'),
    ('input_files', 'input_files_job_id_fkey input_files_parent_id_fkey input_files_sha256_check input_files_bytes_check input_files_check'),
    ('habitat_preparation_selections', 'habitat_preparation_selections_selection_check')
),
required_triggers(name, relation, function_name) AS (VALUES
    ('processing_job_change', 'jobs', 'notify_job_change'),
    ('processing_capacity_change', 'jobs', 'notify_execution_capacity'),
    ('processing_retained_metadata', 'jobs', 'retain_terminal_metadata'),
    ('processing_release_inputs', 'jobs', 'release_finished_inputs'),
    ('processing_subscriber_change', 'job_subscribers', 'notify_subscriber_change')
)
SELECT r.name AS incompatible_object FROM required_relations r
WHERE NOT EXISTS (
    SELECT FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
    JOIN pg_type t ON t.oid=a.atttypid
    WHERE c.relnamespace='processing'::regnamespace AND c.relname=r.name
      AND c.relkind=r.kind::"char" AND a.attnum>0 AND NOT a.attisdropped
    HAVING string_to_array(r.columns, ' ') <@ array_agg(
        a.attname || ':' || t.typname || CASE WHEN a.attnotnull THEN '!' ELSE '' END
    )
)
UNION ALL
SELECT i.name FROM required_indexes i WHERE NOT EXISTS (
    SELECT FROM pg_index x JOIN pg_class idx ON idx.oid=x.indexrelid
    JOIN pg_am am ON am.oid=idx.relam
    WHERE idx.relnamespace='processing'::regnamespace AND idx.relname=i.name
      AND x.indrelid=to_regclass('processing.' || i.relation)
      AND am.amname=i.method AND x.indisvalid AND x.indisready
      AND x.indisunique=i.is_unique AND (x.indpred IS NOT NULL)=i.is_partial
      AND string_to_array(i.columns, ' ')=ARRAY(
          SELECT a.attname::text FROM unnest(x.indkey) WITH ORDINALITY key(attnum, pos)
          JOIN pg_attribute a ON a.attrelid=x.indrelid AND a.attnum=key.attnum ORDER BY key.pos
      )
)
UNION ALL
SELECT constraint_name FROM required_constraints expected
CROSS JOIN LATERAL unnest(string_to_array(expected.names, ' ')) AS constraint_name
WHERE NOT EXISTS (
    SELECT FROM pg_constraint c
    WHERE c.conrelid=to_regclass('processing.' || expected.relation)
      AND c.conname=constraint_name AND c.convalidated
)
UNION ALL
SELECT t.name FROM required_triggers t WHERE NOT EXISTS (
    SELECT FROM pg_trigger g
    WHERE g.tgrelid=to_regclass('processing.' || t.relation) AND g.tgname=t.name
      AND g.tgfoid=to_regprocedure('processing.' || t.function_name || '()')
      AND g.tgenabled IN ('O', 'A') AND NOT g.tgisinternal
)
LIMIT 1;
