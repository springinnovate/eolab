-- A job can retain a private input beyond its staging deadline. Independent
-- runs that reuse the input refer to the same immutable payload.
ALTER TABLE processing.inputs ADD COLUMN media_type text NOT NULL DEFAULT 'application/json';
ALTER TABLE processing.inputs ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE processing.inputs DROP CONSTRAINT inputs_bytes_check,
    ADD CHECK (bytes > 0 AND bytes <= 67108864);
CREATE TABLE processing.job_inputs (
    job_id text NOT NULL REFERENCES processing.jobs(id) ON DELETE CASCADE,
    input_id text NOT NULL REFERENCES processing.inputs(id),
    PRIMARY KEY (job_id, input_id)
);
CREATE INDEX job_inputs_input ON processing.job_inputs(input_id);

-- Preserve drawing references from runs already accepted with embedded GeoJSON,
-- including runs whose staging row has since been released.
UPDATE processing.inputs SET media_type='application/geo+json'
WHERE payload->>'type'='FeatureCollection';
WITH existing AS (
    SELECT s.owner, e.key::jsonb AS reference, e.value AS payload
    FROM processing.jobs j JOIN processing.job_subscribers s ON s.job_id=j.id
    CROSS JOIN LATERAL jsonb_each(j.spec->'_vectorInputs') e
)
INSERT INTO processing.inputs(id, owner, sha256, payload, bytes, expires_at, media_type)
SELECT reference->>'id', owner, reference->>'sha256', payload,
       octet_length(payload::text), NULL, 'application/geo+json' FROM existing
ON CONFLICT (id) DO NOTHING;
INSERT INTO processing.job_inputs(job_id, input_id)
SELECT j.id, k::jsonb->>'id' FROM processing.jobs j
CROSS JOIN LATERAL jsonb_object_keys(j.spec->'_vectorInputs') k;
UPDATE processing.inputs i SET expires_at=NULL
WHERE EXISTS (SELECT FROM processing.job_inputs r WHERE r.input_id=i.id);
UPDATE processing.jobs SET spec=spec-'_vectorInputs' WHERE spec ? '_vectorInputs';
INSERT INTO processing.schema_version VALUES (24);
