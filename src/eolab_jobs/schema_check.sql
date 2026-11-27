-- Let PostgreSQL resolve the durable fields used for saved jobs, subscriptions,
-- retained inputs and Habitat selection identity without reading any job rows.
SELECT j.operation, j.work_key, j.input_uploads, j.retained_metadata, j.metadata_ttl_seconds,
       j.result_ttl_seconds, s.owner, s.request_key, s.deletion_undo_until,
       h.job_id, h.status, h.artifact, h.retained_outcome, f.parent_id, f.sha256,
       t.expires_at, c.payload, i.owner, i.payload, a.selection
FROM processing.jobs j, processing.job_subscribers s, processing.subscribed_jobs h,
     processing.input_files f, processing.transfers t, processing.calculation_results c,
     processing.inputs i, processing.habitat_preparation_selections a
WHERE false;

-- Only keys and lifecycle hooks that affect correctness participate. An index's
-- name and optional query-performance indexes do not determine compatibility.
WITH version_23 AS (SELECT FROM processing.schema_version WHERE version=23),
required_keys(relation, columns, partial) AS (VALUES
    ('jobs', ARRAY['id'], false), ('jobs', ARRAY['work_key'], true),
    ('job_subscribers', ARRAY['id'], false), ('job_subscribers', ARRAY['owner','request_key'], false),
    ('input_files', ARRAY['artifact_id','job_id','run_id'], false),
    ('transfers', ARRAY['id'], false), ('inputs', ARRAY['id'], false),
    ('calculation_results', ARRAY['cache_key'], false)
    UNION ALL SELECT 'job_turns', ARRAY['job_id','owner'], false FROM version_23
), required_hooks(relation, function_name) AS (VALUES
    ('jobs','retain_terminal_metadata'), ('jobs','release_finished_inputs'),
    ('jobs','notify_job_change'), ('jobs','notify_execution_capacity'),
    ('job_subscribers','notify_subscriber_change')
    UNION ALL SELECT 'jobs', 'record_job_turns' FROM version_23
), job_references(relation, column_name, on_delete) AS (VALUES
    ('job_subscribers','job_id','c'), ('transfers','job_id','c'),
    ('input_files','job_id','c'), ('input_files','parent_id','a')
    UNION ALL SELECT 'job_turns','job_id','c' FROM version_23
)
SELECT 'the subscribed_jobs view' AS problem
WHERE (SELECT relkind FROM pg_class WHERE oid='processing.subscribed_jobs'::regclass)<>'v'
UNION ALL
SELECT 'unexpected unversioned job turns' WHERE NOT EXISTS (SELECT FROM version_23)
    AND to_regclass('processing.job_turns') IS NOT NULL
UNION ALL
SELECT 'the job turn timestamp' FROM version_23 WHERE NOT EXISTS (
    SELECT FROM pg_attribute WHERE attrelid=to_regclass('processing.job_turns')
        AND attname='started_at' AND atttypid='timestamptz'::regtype AND attnotnull
)
UNION ALL
SELECT 'the Habitat selection hash index' WHERE NOT EXISTS (
    SELECT FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_am m ON m.oid=i.relam
    JOIN pg_attribute a ON a.attrelid=x.indrelid AND a.attnum=x.indkey[0]
    WHERE x.indrelid='processing.habitat_preparation_selections'::regclass
      AND m.amname='hash' AND x.indisvalid AND x.indisready AND x.indnkeyatts=1 AND x.indpred IS NULL
      AND a.attname='selection' AND a.atttypid='jsonb'::regtype
)
UNION ALL
SELECT k.relation || ' uniqueness on ' || array_to_string(k.columns, ', ') FROM required_keys k
WHERE NOT EXISTS (
    SELECT FROM pg_index x WHERE x.indrelid=to_regclass('processing.' || k.relation)
      AND x.indisunique AND x.indisvalid AND x.indisready AND (x.indpred IS NOT NULL)=k.partial
      AND k.columns=ARRAY(SELECT a.attname::text FROM unnest(x.indkey) WITH ORDINALITY key(attnum, pos)
                         JOIN pg_attribute a ON a.attrelid=x.indrelid AND a.attnum=key.attnum
                         WHERE key.pos<=x.indnkeyatts ORDER BY a.attname::text COLLATE "C")
)
UNION ALL
SELECT r.relation || '.' || r.column_name || ' job reference' FROM job_references r
WHERE NOT EXISTS (
    SELECT FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname=r.column_name
    JOIN pg_attribute job ON job.attrelid=c.confrelid AND job.attname='id'
    WHERE c.conrelid=to_regclass('processing.' || r.relation) AND c.contype='f' AND c.convalidated
      AND c.confrelid='processing.jobs'::regclass AND c.conkey=ARRAY[a.attnum] AND c.confkey=ARRAY[job.attnum]
      AND c.confdeltype=r.on_delete::"char"
)
UNION ALL
SELECT h.function_name || ' trigger' FROM required_hooks h WHERE NOT EXISTS (
    SELECT FROM pg_trigger t WHERE t.tgrelid=to_regclass('processing.' || h.relation)
      AND t.tgfoid=to_regprocedure('processing.' || h.function_name || '()')
      AND t.tgenabled IN ('O','A') AND NOT t.tgisinternal
)
LIMIT 1;
