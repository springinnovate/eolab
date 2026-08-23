# Temporary AOI uploads

EOMap accepts one temporary Area of Interest (AOI) per browser session. This
workflow is deliberately separate from mounted-source discovery: an upload is
never written to `/scan-source`, scanned into a STAC Item, sent to pgSTAC, or
published to GeoServer.

## Accepted inputs and selection

The **Upload AOI** control accepts either:

- one GeoPackage (`.gpkg`) containing at least one usable spatial vector
  layer; or
- one ZIP archive (`.zip`) containing at least one complete ESRI Shapefile.
  A usable Shapefile must include `.shp`, `.shx`, `.dbf`, and `.prj` components
  in the archive. Recognized optional sidecars are extracted with their dataset.

File extensions are case-insensitive. Server-side format and spatial
validation remains authoritative; the browser's file filter is only a hint.
When the container has multiple usable layers or Shapefiles, EOMap presents
their untrusted names as text and requires the user to choose one. The browser
sends back only the opaque choice identifier issued by the server, never a
filesystem path or user-controlled layer name.

The selected dataset must contain features and a usable coordinate reference
system (CRS). EOMap transforms geometry to WGS 84 using traditional GIS axis
order: positions sent to the browser are longitude, then latitude. Uploaded
attributes are discarded; the API returns only an empty-properties GeoJSON
FeatureCollection and its finite bounding box.

## Resource and archive limits

The temporary-AOI boundary applies these fixed ceilings before geometry reaches
the map:

| Resource | Limit |
| --- | ---: |
| Multipart request body | Configured file limit plus 64 KiB multipart framing |
| Uploaded file | `EOLAB_TEMPORARY_AOI_MAX_UPLOAD_BYTES` (25 MiB by default) |
| ZIP entries | 512 |
| One extracted ZIP member | 25 MiB |
| Total extracted ZIP bytes | 100 MiB |
| ZIP compression ratio per member | 100:1 |
| Usable dataset choices | 64 |
| Selected dataset features | 10,000 |
| Browser coordinate positions | 100,000 |
| Nested GeometryCollections | 32 levels |
| Serialized browser geometry | 2 MiB |
| Geometry-processing interval | 15 seconds |

ZIP paths must be unambiguous relative POSIX paths. EOMap rejects absolute,
drive-qualified, traversing, empty-segment, control-character, backslash,
case-duplicate, and symbolic-link paths. It also rejects encrypted entries,
nested ZIP files, unsupported compression methods, malformed archives, and
archives whose declared or actual decompressed sizes exceed the limits.

Container inspection and geometry transformation run in isolated worker
processes. EOLab terminates the worker at the 15-second wall-time deadline, so
an individual native GDAL call cannot keep the request or its temporary files
alive indefinitely.

## Lifecycle and cleanup

Each upload receives a cryptographically opaque identifier and an isolated
directory under the operating system's temporary-file location, outside both
the repository and mounted scan source. Server paths are never returned. A
pending multi-dataset upload retains its files until selection, removal,
replacement, expiration, or application shutdown.

One temporary AOI expires after `EOLAB_TEMPORARY_AOI_TTL_SECONDS`, which
defaults to 1,800 seconds (30 minutes). The application periodically removes
expired records and also purges expiration before lifecycle operations.
Removal deletes both browser state and server files. Replacement is
transactional: the current AOI remains available if the new upload or selection
fails, and its files are deleted only after the replacement becomes ready.
Validation and processing failures delete all files allocated for the failed
upload. Application shutdown removes every remaining temporary-AOI directory.

Temporary AOIs are process-local and intentionally do not survive an
application restart. EOMap does not store their identifiers in browser storage,
so a page reload starts a new page session; the abandoned server record is
removed by its TTL or by shutdown.
