# Raster clips and downloads

Download one single-band numeric GeoTIFF clipped to an explicit sampling box or
filtered [vector selection](vector-sampling.md). The clip keeps the source's
**native resolution, CRS, pixel grid and datatype**. Map colors and histogram
sampling resolution do not change the exported pixels. Reprojection and implicit
whole-raster exports are not offered.

## Browser workflow

Use **Download clip** on a raster in Map layers or an individual 1D histogram.
The 2D histogram has separate **Download X clip** and **Download Y clip** actions.
Use **Tools → Download raster clip** to return to the current download while other
tools are open. Opening this tool alone does not submit or cancel work.

**Download raster clip** leads with the chosen raster and captured area. The 1D and
2D selections remain distinct; whole-raster and whole-overlap sampling do not
become export areas. **Change** reveals the raster selector and **Change sampling
area**, which opens the existing box/vector controls. Returning to the download
review captures the new area and keeps the chosen raster. Reopen from a histogram
to review that histogram's source and selection. Histogram results need not be
ready or successful before reviewing a clip.

**Prepare download** submits the chosen raster and area. The current download
replaces the review with measured progress, cancellation, errors or the ready
**Download GeoTIFF** action and an actual expiry deadline in local time. Later
map/filter changes do not change accepted work. **Prepare another download** opens
a new review; it does not cancel the existing download. Other active or available
downloads are listed under a collapsed **Recent downloads** disclosure only when
relevant. Selecting one inspects its original source/area without submitting work;
active entries retain Cancel even while another submission is unconfirmed.
The original Catalog sources must remain available and unchanged until execution
and publication finish. **Download details** holds native grid/CRS, size estimates,
provenance and the explicit Delete result action. Closing or switching tools leaves
accepted work running. Downloads go directly through the browser, support resuming,
and avoid a JavaScript Blob buffer.

Owned jobs recover through the session cookie after reload, including when their
map layers have been removed. The current/recent surfaces use their saved catalog
identities and job metadata. Expired jobs cannot offer download links; expiration
and active-transfer cleanup remain server-owned. The default availability is still
24 hours after completion, and the ready download shows its actual server deadline.
The per-tab session storage contains the unconfirmed source and area, idempotency
key, and display label;
it is saved before dispatch. Reload or **Recover submission** retries that same
request. No cookie, geometry, result file, or processing job is placed in a shared
map link. Disabled session storage prevents submission with a clear explanation.
The existing `/docs#/processing` API page also remains available.

## Raster correctness

The worker reauthorizes the Catalog Item at execution. Raster inputs are immutable;
execution does not recheck file timestamps or rebuild the grid to detect changes.
The scanned source identity remains in saved plans and result provenance.
Existing signed-source restrictions remain: one supported numeric band, bounded
native blocks, embedded georeferencing and nodata, and no unsigned sidecars,
alpha, or input dataset masks. Supported datatypes are uint8, uint16, int16,
int32, float32, and float64, matching the neutral reader contract.

Bounds edges and polygon selection polygon edges are densified and transformed to the source
CRS using the shared bounded-window mechanisms. The output is an integer native
window with the existing conservative one-pixel envelope padding. Each intersecting
native source block is decoded once, intersected with the window, masked, and
written. Polygon components are unioned; holes are preserved unless another
component covers them. The mask includes cells touched by the selected geometry; numeric summaries instead use cell centers.
The export does not use histogram overviews, percentiles, or approximate grids.

The output preserves valid zero, signed nodata, scale, offset, units, band
description, and supported descriptive metadata. Non-finite data and cells
outside the selected geometry are invalid. An internal mask represents validity
without inventing a nodata value or promoting the datatype. Full-source statistics
are not copied. A lossless DEFLATE COG with nearest-neighbor overviews is reopened
to verify COG layout, native grid/type/CRS/nodata, overviews, and validity count;
then it is checksummed. TIFF tags and the separate JSON document record operation,
Catalog source/signature, geometry, grid, inclusion rule, and result provenance.
No private source or artifact paths are included.

Exported internal-mask COGs are downloads, not automatically published Catalog
assets. Future re-ingestion of those files needs an explicit input-mask policy;
this feature does not weaken the existing source reader to enable that path.

## Storage and limits

Results expire 24 hours after completion. Keep the same browser session to inspect,
cancel, delete or download your jobs; knowing a job ID is not sufficient.
Downloads support resume. An accepted job can continue after the browser closes;
recover it through **Tools → Raster clips**. A failed job does not expose a partial TIFF.
Deployments and worker restarts interrupt unfinished jobs; submit them again.
Completed results remain available until expiry.

| Resource | Limit |
| --- | --- |
| Active native jobs | Configurable shared capacity for clips and calculations; default 1. Stop the old worker container before deploying another. |
| Waiting jobs | 128 globally; 32 queued per browser session; running work is counted separately |
| Retained job records | 4,096, including finished jobs and seven-day idempotency records |
| Retained job inputs | 128 MiB of specifications and summaries awaiting cleanup |
| Preparation | Runs inside the claimed job's native process and memory reservation |
| Native output estimate, including validity | 1 GiB |
| Decoded native source work | 4 GiB; at most 65,536 blocks; existing 64 MiB per-block ceiling |
| Retained feature / projected-coordinate buffer | 500,000 positions |
| Clip execution and finalization | 10 minutes |
| Temporary result/scratch reservations | 20 GiB globally |
| Physical free-space floor | 2 GiB, checked again before execution |
| Result lifetime | 24 hours after completion |
| Transfers | 4 per result, 64 globally; renewable 120-second leases; 1-hour response ceiling |

Operators must preserve the separate Processing artifact volume and enough free
disk space. The 20 GiB reservation budget is an admission limit, not a disk quota
or allocated filesystem size. Prepared jobs wait in the existing queue when
other jobs reserve the remaining disk budget, retaining their prepared inputs.
A job larger than the entire budget fails with an explanation. A physical
filesystem-full error fails the job instead of publishing a partial file.
Active downloads delay cleanup within bounded transfer leases. See
[deployment and operations](deployment-and-operations.md) for mounts and recovery.

For scripted use, the deployed application's `/docs#/processing` page provides
request schemas. Use HTTPS, retain the session cookie and retry uncertain
submissions with the same plan/request key to avoid duplicate jobs. Cookie jars
grant access to private results and must not be shared or committed.
