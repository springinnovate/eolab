CREATE SCHEMA IF NOT EXISTS planning;
CREATE TABLE IF NOT EXISTS planning.tools (
    id uuid PRIMARY KEY,
    owner_hash text NOT NULL,
    definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS planning_tools_owner ON planning.tools (owner_hash, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS planning.scenarios (
    id uuid PRIMARY KEY,
    tool_id uuid NOT NULL REFERENCES planning.tools(id),
    owner_hash text NOT NULL,
    name text NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS planning_scenarios_owner ON planning.scenarios (tool_id, owner_hash, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS planning.scenario_assignments (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scenario_id uuid NOT NULL REFERENCES planning.scenarios(id),
    parcel_id_type text NOT NULL CHECK (parcel_id_type IN ('integer', 'string')),
    parcel_id_value text NOT NULL,
    intervention_id uuid NOT NULL
);
-- Original string IDs have no length limit. Index only the scenario/page key;
-- the scenario row lock serializes exact type/value lookup and insertion.
CREATE INDEX IF NOT EXISTS planning_scenario_assignments_page ON planning.scenario_assignments (scenario_id, id);
