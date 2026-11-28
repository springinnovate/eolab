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

INSERT INTO processing.schema_version VALUES (24);
