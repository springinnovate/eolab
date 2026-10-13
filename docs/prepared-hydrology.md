# Configure model hydrology

The downstream beneficiaries model gets its DEM and watershed layer from its
installed Model YAML. Users choose a starting mask and values to summarize; there
is no Prepared hydrology selector, registration command or validation report to
install after a restart.

## Server configuration

Edit `src/eolab_app/processing/recipes/downstream-beneficiaries.yaml`, then build
and deploy the application and Processing worker together. The complete
[Model YAML example](model-examples/downstream-beneficiaries.model.yaml) matches
the bundled recipe. Use the catalog identities for the mounted data on your
server. These references resolve through the catalog to the current files; no
filesystem paths appear in the model API or browser.

The fixed binding is under the operation's inputs:

```yaml
steps:
  - id: analysis
    operation: hydrology.downstream_beneficiaries.v1
    inputs:
      starting_mask: {input: starting_mask}
      values: {input: values}
      hydrology:
        value:
          dem:
            collectionId: eolab-mounted-geotiffs
            itemId: geotiff-ee81a7caa68b3a9a23c7540a
          watersheds:
            collectionId: eolab-mounted-vectors
            itemId: geopackage-86eb43d6b974d6a05d8cc30d
          topology:
            idField: HYBAS_ID
            downstreamField: NEXT_DOWN
            idType: integer
            terminal:
              field: NEXT_SINK
              equalsField: HYBAS_ID
            terminalIdField: NEXT_SINK
```

This fragment uses the Resilience catalog sources previously configured in the
standalone hydrology file. Other servers must supply their own catalog IDs and
field mappings. The full recipe also declares parameters, outputs and an execution
profile. Give a changed recipe an appropriate semantic version; its definition
checksum captures the configuration in saved runs. Version 4.0.0 removes the
user-facing hydrology input from the bundled model.

The watershed source is the complete configured layer. The original WWF model
uses integer IDs and the configured downstream and terminal fields. The model
operator is responsible for choosing suitable data. EOlab does not preflight
network connectivity, terrain conditioning, DEM coverage or model suitability.
The original algorithm still performs its own DEM preparation and pit filling.

## Runtime behavior

At submission, ordinary catalog authorization captures the current DEM identity.
The worker opens the current watershed layer when it prepares the run. No source
is compared against a historical registration report. Restarting the server does
not require hydrology re-registration.

Missing or unreadable files fail at the source access boundary with the affected
input identified. Catalog mount confinement and authorization still apply.
Once a run captures its inputs, changes during that calculation are rejected so
the result cannot silently combine different revisions. Cancellation, session
ownership and result expiry continue to use the existing Processing lifecycle.
The captured model definition and raster identities are retained in Run YAML;
the calculation provenance also records the current watershed selection.

## Upgrading from registration reports

Remove `EOLAB_PREPARED_HYDROLOGY_DIRECTORY` (or the direct-service
`PREPARED_HYDROLOGY_DIRECTORY`) from server configuration. The application no
longer reads it. Transfer the catalog DEM, watershed and topology fields from the
old configuration into the Model YAML fixed binding above, and deploy both
application and worker. No `.hydrology.json` report is required.

The registration CLI and `/api/processing/prepared-hydrology` discovery/resolve
endpoints have been removed. Older saved Run YAML documents retain their embedded
reports and checksums for historical display; those reports do not authorize new
runs. The mask and values selections remain explicit user choices.
