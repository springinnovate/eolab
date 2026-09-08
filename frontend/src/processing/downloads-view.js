/** Accessible Downloads DOM adapter. No map, histogram, or upload implementation knowledge. */
import { ACTIVE_JOB_STATES } from "./downloads-controller.js";
import { processingDownloadUrl } from "./api.js";

/**
 * Summarize an explicit CRS label or root WKT name/authority for display.
 * This reads presentation metadata only; projection remains backend-owned.
 * @param {string} crs Native CRS definition. @return {string} Compact name.
 */
export function describeClipCrs(crs) {
    const name = crs.match(/^(?:PROJCS|GEOGCS|PROJCRS|GEOGCRS|COMPD_CS)\["([^"]+)"/);
    if (!name) return crs;
    const authority = crs.match(/(?:AUTHORITY\["EPSG","(\d+)"\]|ID\["EPSG",(\d+)\])\]$/);
    return authority ? `${name[1]} (EPSG:${authority[1] ?? authority[2]})` : name[1];
}

/** Format file sizes without implying compression precision. @param {number} bytes Byte count. @return {string} Human-readable size. */
export function formatDownloadBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const unit = bytes < 1024 ** 2 ? "KiB" : bytes < 1024 ** 3 ? "MiB" : "GiB";
    const divisor = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[unit];
    return `${(bytes / divisor).toFixed(1)} ${unit}`;
}

/** Describe a public plan/job area. @param {Object|null} area Bounds or AOI summary. @return {string} Explicit geographic description. */
export function describeClipArea(area) {
    if (!area) return "No box or AOI selected. Choose a sampling area first.";
    if (area.kind === "temporaryAoi") return "Uploaded AOI selected; review will show its geographic bounds.";
    const values = area.selectedBounds
        ? [area.selectedBounds.west, area.selectedBounds.south, area.selectedBounds.east, area.selectedBounds.north]
        : area.bounds;
    return `${area.kind === "aoi" ? "Uploaded AOI" : "Box"} · W ${values[0].toFixed(4)}°, S ${values[1].toFixed(4)}°, E ${values[2].toFixed(4)}°, N ${values[3].toFixed(4)}°`;
}

/** Describe measured blocks or a named phase, without invented percentages. @param {Object} job Server job snapshot. @return {string} User-facing progress. */
export function describeJobProgress(job) {
    if (job.status !== "running") return ({ queued: "Queued", cancelling: "Cancelling…", ready: "Ready to download",
        failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted — review a new clip to retry",
        expired: "Expired — create a new clip to download again", deleted: "Deleted" })[job.status] ?? job.status;
    const progress = job.progress;
    if (progress.phase === "clipping") return `Clipping · ${progress.completedBlocks ?? 0} of ${progress.totalBlocks ?? "?"} source blocks`;
    return ({ creating_cog: "Preparing download · creating COG", validating: "Preparing download · validating file",
        checksumming: "Preparing download · verifying checksum" })[progress.phase] ?? "Starting clip…";
}

/** Own fixed controls, review details, and retained job cards. */
export class DownloadsView {
    /** @param {Document} [documentContext=globalThis.document] Owning document. */
    constructor(documentContext = globalThis.document) {
        this.document = documentContext;
        this.elements = Object.fromEntries([
            "source", "area", "area-description", "review", "create", "plan", "message", "jobs", "job-message",
            "pending", "retry-submission", "refresh", "edit-area", "close", "form",
        ].map(name => [name, documentContext.querySelector(`#downloads-${name}`)]));
        this.opener = documentContext.querySelector("#open-downloads");
        this.dockOpener = documentContext.querySelector("#open-downloads-dock");
        this.listeners = [];
        this.sourceSignature = "";
        this.jobSignature = "";
        this.planId = null;
    }

    /** Connect fixed controls to semantic callbacks. @param {Object} handlers User intent handlers. @return {void} */
    bind(handlers) {
        this.handlers = handlers;
        const events = [
            [this.opener, "click", handlers.onOpen],
            [this.dockOpener, "click", handlers.onOpen],
            [this.elements.close, "click", handlers.onClose],
            [this.elements.source, "change", () => handlers.onSource(Number(this.elements.source.value))],
            [this.elements.area, "change", () => handlers.onArea(this.elements.area.value)],
            [this.elements.form, "submit", event => { event.preventDefault(); handlers.onReview(); }],
            ...[["create", "onCreate"], ["retry-submission", "onRetrySubmission"],
                ["refresh", "onRefresh"], ["edit-area", "onEditArea"]]
                .map(([element, handler]) => [this.elements[element], "click", handlers[handler]]),
        ];
        for (const [element, event, handler] of events) element.addEventListener(event, handler);
        this.listeners = events;
    }

    /** Detach all fixed listeners. @return {void} */
    unbind() {
        for (const [element, event, handler] of this.listeners) element.removeEventListener(event, handler);
        this.listeners = [];
        this.handlers = null;
    }

    /** Create an element with safe text. @param {string} tag HTML tag. @param {string} text Display text. @return {HTMLElement} Detached element. */
    element(tag, text) {
        const element = this.document.createElement(tag);
        element.textContent = text;
        return element;
    }

    /** Render form state without discarding keyboard focus on each poll. @param {Object} state Controller snapshot. @return {void} */
    render(state) {
        const e = this.elements;
        const signature = JSON.stringify(state.sources);
        if (signature !== this.sourceSignature) {
            e.source.replaceChildren(...state.sources.map((source, index) => {
                const option = this.element("option", source.label);
                option.value = String(index);
                return option;
            }));
            this.sourceSignature = signature;
        }
        e.source.value = String(state.sources.findIndex(source => source.collectionId === state.source?.collectionId && source.itemId === state.source?.itemId));
        const selection = this.element("option", "Selected histogram area (captured when opened)");
        selection.value = "selection";
        const uploaded = this.element("option", state.availableAoi
            ? `Uploaded AOI · ${state.availableAoi.filename} · ${state.availableAoi.selectedDataset}`
            : "Uploaded AOI — upload one in Sampling area");
        uploaded.value = "uploaded";
        uploaded.disabled = !state.availableAoi;
        // Replacing options does not replace the focused select itself.
        e.area.replaceChildren(selection, uploaded);
        e.area.value = state.areaChoice;
        const locked = !!state.pending || state.submitting;
        e.source.disabled = locked || state.sources.length === 0;
        e.area.disabled = locked;
        e["edit-area"].disabled = locked;
        e["area-description"].textContent = describeClipArea(state.area);
        e.review.disabled = locked || state.busy || !state.source || !state.area;
        e.review.textContent = state.busy ? "Reading clip metadata…" : "Review clip";
        e.create.hidden = !state.plan || !!state.pending;
        e.create.disabled = state.busy || locked;
        e.message.textContent = state.message;
        e["job-message"].textContent = state.jobMessage;
        e.pending.hidden = !state.pending;
        e.pending.textContent = state.pending ? `${state.submitting ? "Confirming" : "Unconfirmed submission for"} ${state.pending.label}. Its area and raster are fixed until this request is recovered.` : "";
        e["retry-submission"].hidden = !state.pending;
        e["retry-submission"].disabled = state.submitting;
        e.plan.hidden = !state.plan;
        if (state.plan && this.planId !== state.plan.planId) {
            this.renderPlan(state.plan, state.source);
            e.plan.scrollIntoView?.({ block: "nearest" });
        }
        this.planId = state.plan?.planId ?? null;
        const active = state.jobs.filter(job => ACTIVE_JOB_STATES.has(job.status)).length;
        const ready = state.jobs.filter(job => job.status === "ready").length;
        this.opener.textContent = `Downloads${active ? ` · ${active} working` : ready ? ` · ${ready} ready` : ""}${state.pending ? " · unconfirmed" : ""}`;
        this.opener.title = "Open Downloads and recover clips from this browser session";
        this.dockOpener.textContent = `Downloads${active + ready ? ` · ${active + ready}` : ""}`;
        this.dockOpener.title = this.opener.textContent;
        const jobSignature = JSON.stringify([state.jobs, [...state.jobActions], state.sources]);
        if (this.jobSignature !== jobSignature) {
            const focus = this.document.activeElement?.getAttribute("data-download-action");
            const cards = state.jobs.filter(job => job.status !== "deleted").map(job => this.jobCard(job, state));
            e.jobs.replaceChildren(...(cards.length ? cards : [this.element("p", "No clips yet. Choose a raster and area, then review your clip.")]));
            if (focus) e.jobs.querySelector?.(`[data-download-action="${focus}"]`)?.focus();
            this.jobSignature = jobSignature;
        }
    }

    /** Render the metadata-only plan for explicit confirmation. @param {Object} plan Native-grid review. @param {Object} source Captured catalog label. @return {void} */
    renderPlan(plan, source) {
        const grid = plan.grid;
        const resolutionX = Math.hypot(grid.transform[0], grid.transform[3]);
        const resolutionY = Math.hypot(grid.transform[1], grid.transform[4]);
        const details = this.element("dl", "");
        const rows = [
            ["Raster", source.label], ["Area", describeClipArea(plan.area)],
            ["Output", "Cloud Optimized GeoTIFF · native values and validity mask"],
            ["Native CRS", describeClipCrs(grid.crs)],
            ["Pixel size", `${resolutionX.toPrecision(6)} × ${resolutionY.toPrecision(6)} in native CRS units`],
            ["Dimensions", `${grid.width.toLocaleString()} × ${grid.height.toLocaleString()} pixels · ${grid.dtype}`],
            ["Estimated size", `${formatDownloadBytes(grid.estimatedRawBytes)} uncompressed; downloaded size depends on compression`],
            ["Estimate expires", new Date(plan.expiresAt).toLocaleString()],
        ];
        for (const [label, value] of rows) details.append(this.element("dt", label), this.element("dd", value));
        this.elements.plan.replaceChildren(this.element("h3", "Review clip"), details,
            this.element("p", "The clip keeps the original pixel grid. Cells outside the box or polygon, including polygon holes, are masked. Map colors and histogram sampling do not change the downloaded values."));
        if (describeClipCrs(grid.crs) !== grid.crs) {
            const definition = this.element("details", "");
            definition.append(this.element("summary", "Full native CRS definition"), this.element("pre", grid.crs));
            this.elements.plan.append(definition);
        }
    }

    /** Build one owned lifecycle card. @param {Object} job Public job. @param {Object} state Current presentation state. @return {HTMLElement} Job card. */
    jobCard(job, state) {
        const card = this.element("article", "");
        card.className = "download-job";
        const source = state.sources.find(item => item.collectionId === job.source?.collectionId && item.itemId === job.source?.itemId);
        card.append(this.element("h3", source?.label ?? job.result?.filename ?? job.source?.itemId ?? "Raster clip"),
            this.element("p", describeJobProgress(job)));
        if (job.area) card.append(this.element("p", describeClipArea(job.area)));
        if (job.status === "running" && job.progress.phase === "clipping" && job.progress.totalBlocks > 0) {
            const progress = this.element("progress", "");
            progress.max = job.progress.totalBlocks;
            progress.value = job.progress.completedBlocks ?? 0;
            progress.setAttribute("aria-label", "Source blocks clipped");
            card.append(progress);
        }
        if (job.grid) card.append(this.element("p", `${job.grid.width} × ${job.grid.height} pixels · ${describeClipCrs(job.grid.crs)}`));
        if (job.error) card.append(this.element("p", `${job.error.detail} (${job.error.code})`));
        if (job.result && job.status === "ready") {
            card.append(this.element("p", `${formatDownloadBytes(job.result.bytes)} · expires ${new Date(job.expiresAt).toLocaleString()}`));
            for (const [kind, label, url] of [["result", "Download COG", job.result.url], ["provenance", "Provenance", job.result.provenanceUrl]]) {
                const link = this.element("a", label);
                link.className = "secondary-button";
                link.href = processingDownloadUrl(url, job.jobId, kind);
                link.setAttribute("download", "");
                link.setAttribute("data-download-action", `${job.jobId}-${kind}`);
                card.append(link);
            }
        }
        const active = ACTIVE_JOB_STATES.has(job.status);
        const action = active ? "cancel" : "delete";
        const button = this.element("button", active ? "Cancel clip" : "Delete clip");
        button.type = "button";
        button.className = "secondary-button";
        button.disabled = state.jobActions.has(job.jobId) || job.status === "cancelling";
        button.setAttribute("data-download-action", `${job.jobId}-${action}`);
        button.addEventListener("click", () => active ? this.handlers?.onCancel(job.jobId) : this.handlers?.onDelete(job.jobId));
        card.append(button);
        return card;
    }
}
