-- Install only in a new Processing namespace under the Processing advisory lock.
CREATE SCHEMA processing;
CREATE TABLE processing.schema_version (version integer PRIMARY KEY);

-- A job owns execution and files. Subscribers own the public handles.
CREATE TABLE processing.jobs (
    id text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('queued', 'running', 'cancelling', 'ready', 'failed', 'cancelled', 'interrupted', 'expired', 'deleted')),
    spec jsonb,
    reserved_bytes bigint NOT NULL CHECK (reserved_bytes >= 0),
    summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    attempt_id text,
    lease_until timestamptz,
    progress jsonb NOT NULL DEFAULT '{}'::jsonb,
    artifact jsonb,
    error jsonb,
    operation text NOT NULL,
    started_at timestamptz,
    work_key text,
    retained_metadata jsonb,
    retained_outcome jsonb,
    metadata_expires_at timestamptz,
    metadata_ttl_seconds bigint NOT NULL DEFAULT 604800 CHECK (metadata_ttl_seconds > 0),
    result_ttl_seconds bigint CHECK (result_ttl_seconds > 0),
    input_uploads jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX jobs_status ON processing.jobs(status, created_at);
CREATE UNIQUE INDEX jobs_active_work ON processing.jobs(work_key)
    WHERE work_key IS NOT NULL AND status IN ('queued','running');

CREATE TABLE processing.transfers (
    id text PRIMARY KEY,
    job_id text NOT NULL REFERENCES processing.jobs(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX transfers_job ON processing.transfers(job_id, expires_at);

-- Small completed values only: no source paths, polygons or artifact references.
CREATE TABLE processing.calculation_results (
    cache_key text PRIMARY KEY CHECK (cache_key ~ '^[0-9a-f]{64}$'),
    payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 32768),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX calculation_results_expiry
    ON processing.calculation_results(expires_at);

-- Bounded owner-private calculation inputs. Accepted jobs retain their own copy.
CREATE TABLE processing.inputs (
    id text PRIMARY KEY,
    owner text NOT NULL,
    sha256 text NOT NULL,
    payload jsonb NOT NULL,
    bytes integer NOT NULL CHECK (bytes > 0 AND bytes <= 8388608),
    expires_at timestamptz NOT NULL
);
CREATE INDEX inputs_expiry ON processing.inputs(expires_at);

CREATE TABLE processing.job_subscribers (
    id text PRIMARY KEY,
    job_id text NOT NULL REFERENCES processing.jobs(id) ON DELETE CASCADE,
    owner text NOT NULL,
    request_key text NOT NULL,
    request_hash text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    status text CHECK (status IN ('cancelling','cancelled','deleted')),
    presentation jsonb CHECK (octet_length(presentation::text) <= 32768),
    deletion_id text,
    deletion_undo_until timestamptz,
    status_before_deletion text CHECK (status_before_deletion IN ('cancelled','cancelling')),
    UNIQUE(owner,request_key)
);
CREATE INDEX subscribers_job ON processing.job_subscribers(job_id);
CREATE INDEX subscribers_owner ON processing.job_subscribers(owner,created_at DESC);

-- Set each terminal deadline once and retain the published result after scratch cleanup.
CREATE FUNCTION processing.retain_terminal_metadata() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.retained_metadata IS NOT NULL AND NEW.metadata_expires_at IS NULL
       AND NEW.status IN ('ready','failed','cancelled','interrupted') THEN
        NEW.metadata_expires_at := CASE
            WHEN NEW.status='ready' AND NEW.result_ttl_seconds IS NOT NULL
                THEN NEW.expires_at
            ELSE clock_timestamp() + NEW.metadata_ttl_seconds * interval '1 second'
        END;
        NEW.retained_outcome := jsonb_build_object(
            'status', NEW.status, 'artifact', NEW.artifact, 'error', NEW.error);
    END IF;
    IF coalesce(octet_length(NEW.retained_metadata::text),0)
       + coalesce(octet_length(NEW.retained_outcome::text),0) > 262144 THEN
        RAISE EXCEPTION 'Processing retained metadata exceeds its byte limit';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER processing_retained_metadata BEFORE INSERT OR UPDATE ON processing.jobs
FOR EACH ROW EXECUTE FUNCTION processing.retain_terminal_metadata();

CREATE VIEW processing.subscribed_jobs AS
SELECT s.id,s.owner,s.request_key,s.request_hash,s.presentation,s.job_id,
       j.created_at,s.created_at AS subscribed_at,
       greatest(s.updated_at,j.updated_at) AS updated_at,j.expires_at,
       CASE WHEN s.status='cancelling' AND j.status<>'cancelling' THEN 'cancelled'
            ELSE coalesce(s.status,j.status) END AS status,
       j.operation,CASE WHEN j.spec IS NULL THEN NULL ELSE j.summary END AS spec,
       j.reserved_bytes,j.attempt_id,j.lease_until,j.progress,
       CASE WHEN s.status IS NULL THEN j.artifact END AS artifact,
       CASE WHEN s.status IS NULL THEN j.error END AS error,
       j.summary,j.metadata_expires_at,s.deletion_id,s.deletion_undo_until,
       CASE WHEN s.status IS DISTINCT FROM 'deleted'
                 AND (j.metadata_expires_at IS NULL OR j.metadata_expires_at>now())
            THEN j.retained_metadata END AS retained_metadata,
       CASE WHEN s.status IS DISTINCT FROM 'deleted' AND j.metadata_expires_at>now()
            THEN j.retained_outcome END AS retained_outcome
FROM processing.job_subscribers s JOIN processing.jobs j ON j.id=s.job_id;

-- Notifications carry private owner hashes so subscribers can refresh their own handles.
CREATE FUNCTION processing.notify_job_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE subscriber_owner text;
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.progress IS NOT DISTINCT FROM OLD.progress
       AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at THEN RETURN NEW; END IF;
    FOR subscriber_owner IN SELECT DISTINCT owner FROM processing.job_subscribers
        WHERE job_id=NEW.id AND (status IS NULL OR status='cancelling') LOOP
        PERFORM pg_notify('eolab_processing_job_changes', subscriber_owner);
    END LOOP;
    RETURN NEW;
END;
$$;
CREATE TRIGGER processing_job_change AFTER UPDATE OF status, progress, expires_at ON processing.jobs
FOR EACH ROW EXECUTE FUNCTION processing.notify_job_change();
CREATE FUNCTION processing.notify_subscriber_change() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
    PERFORM pg_notify('eolab_processing_job_changes', NEW.owner);
    RETURN NEW;
END $$;
CREATE TRIGGER processing_subscriber_change AFTER INSERT OR UPDATE ON processing.job_subscribers
FOR EACH ROW EXECUTE FUNCTION processing.notify_subscriber_change();

-- Wake claimers after execution stops or cleanup releases retained disk space.
CREATE FUNCTION processing.notify_execution_capacity() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
    IF (OLD.status IN ('running','cancelling') AND NEW.status NOT IN ('running','cancelling'))
       OR NEW.reserved_bytes < OLD.reserved_bytes THEN
        PERFORM pg_notify('eolab_processing_jobs', '');
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER processing_capacity_change AFTER UPDATE OF status,reserved_bytes ON processing.jobs
FOR EACH ROW EXECUTE FUNCTION processing.notify_execution_capacity();

-- Only jobs with retained files need byte accounting.
CREATE INDEX jobs_reserved_bytes ON processing.jobs(reserved_bytes)
    WHERE reserved_bytes>0;
CREATE INDEX jobs_pending_cleanup ON processing.jobs(updated_at)
    WHERE status NOT IN ('queued','running','cancelling','ready')
      AND (reserved_bytes>0 OR spec IS NOT NULL);
CREATE INDEX jobs_cleaned_history ON processing.jobs(updated_at)
    WHERE reserved_bytes=0 AND spec IS NULL
      AND status NOT IN ('queued','running','cancelling','ready');

-- Accepted inputs outlive ordinary parent expiry and deletion until the child
-- stops. The parent records the published byte count once, even when
-- several children retain the same files. These are not download leases.
CREATE TABLE processing.input_files (
    job_id text NOT NULL REFERENCES processing.jobs(id) ON DELETE CASCADE,
    parent_id text NOT NULL REFERENCES processing.jobs(id),
    run_id text NOT NULL,
    artifact_id text NOT NULL,
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    bytes bigint NOT NULL CHECK (bytes > 0),
    PRIMARY KEY(job_id,run_id,artifact_id),
    CHECK (job_id <> parent_id)
);
CREATE INDEX input_files_parent ON processing.input_files(parent_id);
CREATE FUNCTION processing.release_finished_inputs() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.status NOT IN ('queued','running','cancelling') THEN
        DELETE FROM processing.input_files WHERE job_id=NEW.id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER processing_release_inputs AFTER UPDATE OF status ON processing.jobs
FOR EACH ROW EXECUTE FUNCTION processing.release_finished_inputs();

-- Preparation references retain the original Catalog selection, not a new area identity.
-- Exact JSONB equality preserves numeric predicate identity across browser round trips.
CREATE TABLE processing.habitat_preparation_selections (
    selection jsonb NOT NULL CHECK (jsonb_typeof(selection) = 'object')
);
CREATE INDEX habitat_preparation_selections_selection
    ON processing.habitat_preparation_selections USING hash (selection);

INSERT INTO processing.schema_version VALUES (22);
