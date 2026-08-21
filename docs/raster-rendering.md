# Raster rendering policy and experiment

EOLab's first raster viewer uses GeoServer's core GeoTIFF reader and a
single-band color-map style. The scanner records the storage facts needed to
decide whether that path is a reasonable initial rendering candidate. This is
an advisory structural assessment, not a guarantee that every accepted raster
or request will render successfully.

## Initial policy

The `raster-v2` policy accepts a mounted GeoTIFF when it has exactly one band
with a supported scalar data type (`uint8`, `uint16`, `int16`, `int32`,
`float32`, or `float64`) and one of these conditions is true:

1. Its estimated full-resolution pixel data is no more than 64 MiB.
2. Each base-resolution block is no more than 1024 pixels on either edge, and
   it has a complete internal overview pyramid beginning at 2× with no greater
   than 2× gap between levels. The coarsest overview must reduce the raster to
   no more than 8192 pixels on either edge and 64 MiB decoded.

These are conservative starting bounds on decoded source size, with room for
GeoServer's reprojection and Java overhead. The 8192-pixel overview limit also
accepts common global COG pyramids whose last 2× level is slightly larger than
4096 pixels; the separate 64 MiB limit still bounds its decoded pixel data.
The Coolify experiment below determines whether these limits should be
adjusted.

The scanner reads dimensions, band data types, base-resolution block shapes,
compression, overview factors and storage, and GDAL's `LAYOUT=COG` indicator
without reading raster pixels. It stores standard dimensions and band metadata
in the STAC Projection and Raster extensions, standard `file:size` in the File
Info extension, and the remaining EOLab-local decision in the data Asset's
single `eolab:rendering` foreign member. A GDAL COG indicator changes the Asset
media type to the standard cloud-optimized GeoTIFF profile, but neither a COG
label, compression, filename, nor compressed file size makes a raster eligible
by itself.

The pixel-data estimate is the width × height × sample bytes across bands. It
does not include masks, overviews, decoder buffers, reprojection buffers,
rendered output, or concurrent requests.

Items without a `raster-v2` assessment, including Items assessed under the
earlier 4096-pixel limit, remain searchable and inspectable. **Assess for
visualization** updates only the selected Item. A full mounted-source rescan is
not required for this upgrade.

Before publication, EOLab resolves the authoritative STAC Item and repeats the
same bounded metadata inspection on the current mounted file. This second
inspection is necessary because another system can replace a source file
after a scan even though the container mount is read-only. If the current file
no longer qualifies, EOLab refuses it before making a GeoServer REST request.
The public WMS admits only layers approved by the current EOLab process and
checks the source file identity before every data request. A deployment restart
therefore cannot expose layers left in GeoServer's persistent configuration by
an older policy, and replacing a source invalidates its approval.

## Why this supports bounded reads

GeoServer's core GeoTIFF reader can read the internal tiles intersecting the
requested map region and select an appropriate overview. A large raster with
useful internal tiling and overviews therefore does not require the GeoServer
GDAL extension merely to obtain windowed reads. The GDAL extension primarily
adds other raster formats; GeoServer's COG community module primarily supports
remote object-store range access. Neither repairs an unsuitable local TIFF.

Missing overviews make zoomed-out requests decode much more source data.
Strips retain one-dimensional locality, but an intersecting strip normally
spans the image width. Reprojection can enlarge the source region and adds
resampling work. The current EOLab style uses fixed color-map quantities and
does not request histogram normalization or raster statistics.

GeoWebCache can reduce repeat-request work after a cache hit, but its first
miss still renders from the source. Metatiling increases the first render's
dimensions and memory before splitting it into tiles, so caching does not make
an unsuitable source safe.

Primary references:

- [GeoServer production raster guidance](https://docs.geoserver.org/3.0.x/en/user/production/data/)
- [GeoServer GeoTIFF reader](https://docs.geoserver.org/3.0.x/en/user/data/raster/geotiff/)
- [GeoServer raster symbolizer](https://docs.geoserver.org/3.0.x/en/user/styling/sld/reference/rastersymbolizer/)
- [GDAL COG layout](https://gdal.org/en/stable/drivers/raster/cog.html)
- [GeoServer GDAL extension](https://docs.geoserver.org/3.0.x/en/user/data/raster/gdal/)
- [GeoServer COG community module](https://docs.geoserver.org/3.0.x/en/user/community/cog/cog/)
- [GeoWebCache defaults and metatiling](https://docs.geoserver.org/3.0.x/en/user/geowebcache/webadmin/defaults/)
- [GeoServer WMS resource limits](https://docs.geoserver.org/3.0.x/en/user/services/wms/configuration/)
- [GeoServer control-flow extension](https://docs.geoserver.org/3.0.x/en/user/extensions/controlflow/)
- [STAC Item foreign members](https://github.com/radiantearth/stac-spec/blob/v1.0.0/item-spec/item-spec.md)
- [STAC File Info extension](https://github.com/stac-extensions/file/tree/v2.1.0)

## Runtime safeguards

The public EOLab WMS boundary permits only selected read operations and inert
formats, and rejects image dimensions above 2048 pixels. Its upstream HTTP
operations have a 30-second timeout; this is not a GeoServer rendering-time
limit. GeoServer exits and restarts after a Java out-of-memory error,
while EOLab's health and catalog remain independent of rendering availability.
The eligibility gate prevents known unsuitable sources from entering this path
through the normal UI.

The pinned GeoServer image includes its matching control-flow extension.
`EOLAB_GEOSERVER_WMS_RENDER_COUNT` limits active GetMap renders and queues the
remaining Leaflet tiles. `EOLAB_GEOSERVER_MAX_HEAP_SIZE` sets the Java heap
ceiling, and `EOLAB_GEOSERVER_CPU_LIMIT` applies Docker's CPU quota. The
defaults are two renders, a 4 GiB maximum heap, and four CPUs. Java 21 detects
the Docker quota, so EOLab does not set `ActiveProcessorCount` separately.

GeoServer also supports workspace WMS limits. A sensible experiment starting
point is 16 MiB request memory, 120 seconds rendering time, and 100 rendering
errors. The request-memory estimate does not include all source decoding, so
it cannot replace the policy or concurrency bound above. These workspace WMS
settings remain recommendations to validate during the experiment rather than
configuration silently imposed by this change.

## Coolify acceptance experiment

Use the same 512×512 transparent PNG GetMap request for a full-extent view and
a regional view. Run each request once cold and once again unchanged. Record
HTTP status, response bytes, `curl` wall time, sampled peak GeoServer memory and
CPU from `docker stats`, and whether `/healthz` remains healthy.

Also verify the browser contract directly: an unassessed Item shows **Assess for
visualization**; afterward the same location either shows **View on map** or the
scanner's exact unavailable explanation.

The three production representatives are:

| Class | Mounted source | Pre-policy observation | Expected `raster-v2` result |
| --- | --- | --- | --- |
| Small conventional GeoTIFF | `bck_archive/cnc_project/optimization/prioritzr_output_country_allscales/solution_can_tar_100_res_1km.tif` | Rendered quickly; elapsed time and peak memory were not captured | Eligible through the decoded-size limit |
| Cloud Optimized GeoTIFF | `eolab_catalog_data/hmi_2022/cog_HMv20240801_2022s_AA_300.tif` | A zoomed-out view rendered, then a zoom produced enough concurrent tiles to exhaust the former 1 GiB heap and restart GeoServer | Eligible; rerun with the new runtime bounds |
| Previously failing large raster | `bck_archive/ndr_sdr_global/data/Kfac_SoilGrid1km_GloSEM_v1.1_md5_e1c74b67ad7fdaf6f69f1f722a5c7dfb.tif` | A map request exhausted the GeoServer Java heap | Unavailable unless its actual layout contains suitable tiles and overviews |

Record the deployment run here before marking the draft pull request ready:

| Dataset class | Assessment and reason | Cold full extent: seconds / peak memory / status | Cold regional: seconds / peak memory / status | Repeat behavior | GeoServer remained healthy |
| --- | --- | --- | --- | --- | --- |
| Small GeoTIFF | Pending | Pending | Pending | Pending | Pending |
| Well-formed COG | Pending | Pending | Pending | Pending | Pending |
| Large failing raster | Pending | Not requested when ineligible | Not requested when ineligible | Not applicable | Pending |

The recommended large-raster path is both bounded direct rendering and offline
preparation: serve structurally suitable tiled GeoTIFFs with complete internal
overviews directly, and convert rejected sources offline to COGs with useful
overview pyramids. EOLab must not modify the read-only source during scanning.
