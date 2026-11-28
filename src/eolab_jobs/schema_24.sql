-- Existing durable jobs belong to the Processing deployment. Other supervisors
-- own their restart boundary and only retain tickets until native exit.
ALTER TABLE processing.jobs ADD COLUMN executor_scope text;
CREATE TABLE processing.executor_sessions (
    scope text PRIMARY KEY,
    instance uuid NOT NULL,
    claim_sequence bigint NOT NULL DEFAULT 0,
    stopped_attempt uuid,
    stopped_with_lease boolean NOT NULL DEFAULT false
);
INSERT INTO processing.schema_version VALUES (24);
