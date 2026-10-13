# Configure model hydrology

Configure the downstream beneficiaries model's DEM and watershed layer in its
installed Model YAML. Users choose a starting mask, values to summarize and model
parameters. The application loads the model configuration whenever it starts.

## Server configuration

Edit `src/eolab_app/processing/recipes/downstream-beneficiaries.yaml`, then build
and deploy the application and Processing worker together. The complete
[Model YAML example](model-examples/downstream-beneficiaries.model.yaml) matches
the bundled recipe. Use the catalog identities for the mounted data on your
server. The catalog resolves these references to the current files inside the
server's allowed data mounts.

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

This fragment uses the Resilience catalog sources. Other servers must supply
their own catalog IDs and field mappings. The full recipe also declares
parameters, outputs and an execution profile. Give a changed recipe an appropriate
semantic version; its definition checksum captures the configuration in saved
runs. Version 4.0.0 supplies the bundled model's hydrology through this
configuration.

The watershed source is the complete configured layer. The original WWF model
uses integer IDs and the configured downstream and terminal fields. The model
operator chooses suitable data for the intended analysis, including terrain
coverage and watershed connectivity. The original algorithm performs DEM
preparation and pit filling during the calculation.

## Runtime behavior

At submission, ordinary catalog authorization captures the current DEM identity.
The worker opens the current watershed layer when it prepares the run. After a
server restart, new runs use the sources identified in the installed Model YAML.

If a file is missing or unreadable, the run identifies the affected input.
Catalog authorization confines file access to the server's allowed data mounts.
Processing keeps inputs consistent throughout each calculation and manages
cancellation, session ownership and result expiry.
The captured model definition and raster identities are retained in Run YAML;
the calculation provenance also records the current watershed selection.

## Upgrading from registration reports

Transfer the catalog DEM, watershed and topology fields from the old configuration
into the Model YAML fixed binding above. Remove `EOLAB_PREPARED_HYDROLOGY_DIRECTORY`
(or the direct-service `PREPARED_HYDROLOGY_DIRECTORY`) from server configuration,
then deploy both application and worker.

Update deployment scripts to install the configured Model YAML in place of
running the registration CLI or calling `/api/processing/prepared-hydrology`
endpoints. Older saved Run YAML documents retain their embedded reports and
checksums for historical display. Users continue choosing the mask and values
for each new run.
