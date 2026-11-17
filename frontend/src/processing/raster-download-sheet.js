/** Present one map item's GeoTIFF choices and owned result beside its Download button. */
import { processingDownloadUrl } from "./api.js";
import { ACTIVE_JOB_STATES } from "./jobs.js";
import { describeClipArea, describeJobProgress, formatDownloadBytes } from "./presentation.js";

/** Anchor a nonmodal download dialog to the current button, including after map rows are rebuilt. */
export class RasterDownloadSheet {
    /** Find the file controls and the visible region of the map and its scrollable layer list.
     * @param {{document:Document,map:HTMLElement,list:HTMLElement,scrollContainer:HTMLElement,getButton:(key:string)=>HTMLButtonElement|null}} elements Composed DOM anchors.
     */
    constructor({document, map, list, scrollContainer, getButton}) {
        Object.assign(this, {document, map, list, scrollContainer, getButton});
        this.window = document.defaultView;
        this.elements = Object.fromEntries(["sheet", "source", "areas", "file", "status", "close", "prepare", "cancel", "file-link", "new"]
            .map(name => [name, document.getElementById(`raster-download-${name}`)]));
        this.radios = [...this.elements.areas.querySelectorAll("input")];
        this.key = null;
        this.frame = 0;
    }

    /** Connect local file actions to the session's clip controller.
     * @param {{onChoice:(choice:string)=>void,onClose:(focus:boolean)=>void,onPrepare:()=>Promise<void>,onCancel:()=>Promise<void>,onNew:()=>void}} handlers Download actions.
     * @return {void}
     */
    bind(handlers) {
        this.handlers = handlers;
        this.bindings = new AbortController();
        const options = {signal:this.bindings.signal};
        this.elements.close.addEventListener("click", () => handlers.onClose(true), options);
        this.elements.areas.addEventListener("change", event => handlers.onChoice(event.target.value), options);
        this.elements.prepare.addEventListener("click", () => void handlers.onPrepare(), options);
        this.elements.cancel.addEventListener("click", () => void handlers.onCancel(), options);
        this.elements.new.addEventListener("click", handlers.onNew, options);
    }

    /** Show the sheet for a row and follow its replacement button, scrolling and viewport changes until dismissed.
     * @param {string} key Persistent map item key.
     * @return {void}
     */
    open(key) {
        this.close(false);
        this.key = key;
        const button = this.getButton(key);
        if (!button) { this.handlers.onClose(false); return; }
        const sheet = this.elements.sheet;
        sheet.showPopover({source:button});
        this.openEvents = new AbortController();
        const options = {signal:this.openEvents.signal, capture:true};
        this.window.addEventListener("keydown", event => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopImmediatePropagation();
                this.handlers.onClose(true);
            }
        }, options);
        this.document.addEventListener("pointerdown", event => {
            if (!sheet.contains(event.target) && !this.getButton(key)?.contains(event.target)) this.handlers.onClose(false);
        }, options);
        const reposition = () => {
            if (!this.frame) this.frame = this.window.requestAnimationFrame(() => { this.frame = 0; this.position(); });
        };
        this.document.addEventListener("scroll", reposition, options);
        this.window.addEventListener("resize", reposition, options);
        this.window.visualViewport?.addEventListener("resize", reposition, options);
        this.window.visualViewport?.addEventListener("scroll", reposition, options);
        this.resize = new this.window.ResizeObserver(reposition);
        for (const element of [sheet, this.map, this.scrollContainer, this.list]) this.resize.observe(element);
        this.changes = new this.window.MutationObserver(reposition);
        this.changes.observe(this.list, {childList:true});
        this.position();
        if (this.key !== null) {
            sheet.querySelector(".raster-download-scroll").scrollTop = 0;
            this.elements.close.focus({preventScroll:true});
        }
    }

    /** Fit the sheet beside the current row or above/below its button, keeping the footer inside the visible map.
     * @return {void}
     */
    position() {
        if (this.key === null) return;
        const button = this.getButton(this.key);
        const anchor = button?.getBoundingClientRect();
        const list = this.scrollContainer.getBoundingClientRect();
        const map = this.map.getBoundingClientRect();
        const viewport = this.window.visualViewport;
        const top = (viewport?.offsetTop ?? 0), left = (viewport?.offsetLeft ?? 0);
        const bottom = Math.min(map.bottom, top + (viewport?.height ?? this.window.innerHeight)) - 8;
        const right = Math.min(map.right, left + (viewport?.width ?? this.window.innerWidth)) - 8;
        const upper = Math.max(map.top, top) + 8;
        if (!anchor?.width || !anchor.height || anchor.bottom <= Math.max(list.top, top) ||
            anchor.top >= Math.min(list.bottom, bottom + 8) || bottom <= upper) {
            this.handlers.onClose(false);
            return;
        }
        button.setAttribute("aria-controls", this.elements.sheet.id);
        button.setAttribute("aria-expanded", "true");
        const nextToList = Math.max(list.right + 10, map.left + 8);
        const beside = right - nextToList >= 250;
        const rows = this.list.getBoundingClientRect();
        let above = Math.max(list.top, rows.top) - 6;
        let below = Math.min(list.bottom, rows.bottom) + 6;
        if (Math.max(above - upper, bottom - below) < 170) {
            above = anchor.top - 6;
            below = anchor.bottom + 6;
        }
        const roomAbove = above - upper, roomBelow = bottom - below;
        const side = beside ? "right" : roomAbove > roomBelow ? "above" : "below";
        const availableHeight = beside ? bottom - upper : Math.max(roomAbove, roomBelow);
        const width = Math.min(350, beside ? right - nextToList : right - left - 8);
        const sheet = this.elements.sheet;
        sheet.dataset.side = side;
        sheet.style.width = `${width}px`;
        sheet.style.maxHeight = `${Math.max(0, availableHeight)}px`;
        const height = sheet.getBoundingClientRect().height;
        const center = (Math.max(anchor.top, list.top) + Math.min(anchor.bottom, list.bottom)) / 2;
        const desired = beside ? center - 25 : side === "above" ? above - height : below;
        const y = Math.max(upper, Math.min(desired, bottom - height));
        sheet.style.top = `${y}px`;
        sheet.style.left = `${beside ? nextToList : Math.max(left + 8, Math.min(anchor.right - width, right - width))}px`;
        sheet.style.setProperty("--download-arrow-y", `${Math.max(9, Math.min(center - y, height - 9))}px`);
    }

    /** Show the selected layer, actual area choices, file status and the owned GeoTIFF link.
     * @param {{source:Object,choice:string,areas:Object,viewportError:string,jobId:string|null}} draft Captured map-item context.
     * @param {Object|null} job Job accepted for this row, when present in session history.
     * @param {{pending:Object|null,blocked:boolean,submitting:boolean,cancelling:boolean,error:string}} state Shared submission state as applicable to this row.
     * @return {void}
     * @throws {Error} If the server supplies an invalid result URL.
     */
    render(draft, job, {pending, blocked, submitting, cancelling, error}) {
        const e = this.elements;
        e.source.textContent = draft.source.label;
        const ready = job?.status === "ready" && !!job.result;
        const working = job && ACTIVE_JOB_STATES.has(job.status);
        e.areas.hidden = !!draft.jobId || !!pending;
        for (const radio of this.radios) {
            const area = draft.areas[radio.value];
            radio.checked = radio.value === draft.choice;
            radio.disabled = !area || !!pending || blocked;
            const detail = radio.parentElement.querySelector("small");
            if (radio.value === "box") detail.textContent = area ? describeClipArea(area) : "Set a sampling box on the map";
            if (radio.value === "polygons") detail.textContent = area ? area.catalogSelection.layerName : "Select a polygon layer in the sampling controls";
            if (radio.value === "viewport") detail.textContent = draft.viewportError || "The view when you opened Download";
        }
        e.file.textContent = ready ? `${job.result.filename} · ${formatDownloadBytes(job.result.bytes)}` : "GeoTIFF · Original pixel values and resolution";
        const status = blocked ? "Another download is awaiting confirmation. Choose Download raster clip in Tools to check it."
            : error || (pending ? submitting ? "Preparing your download…" : "The request is unconfirmed. Retry to check the original download."
            : job ? job.error?.detail || (ready ? "File ready" : describeJobProgress(job))
            : draft.jobId ? "This download is no longer available." : "");
        if (e.status.textContent !== status) e.status.textContent = status;
        e.prepare.hidden = !!draft.jobId;
        e.prepare.disabled = blocked || submitting || (!pending && !draft.areas[draft.choice]);
        e.prepare.textContent = pending ? submitting ? "Preparing…" : "Retry download" : "Prepare GeoTIFF";
        e.cancel.hidden = !working;
        e.cancel.disabled = cancelling || job?.status === "cancelling";
        e.new.hidden = !draft.jobId || !!working;
        e["file-link"].hidden = !ready;
        if (ready) {
            e["file-link"].href = processingDownloadUrl(job.result.url, job.jobId, "result");
            e["file-link"].download = job.result.filename;
        } else e["file-link"].removeAttribute("href");
        this.position();
    }

    /** Release positioning listeners and dismiss the sheet without affecting the job.
     * @param {boolean} returnFocus Restore keyboard focus to the latest row button.
     * @return {void}
     */
    close(returnFocus) {
        if (this.key === null) return;
        const button = this.getButton(this.key);
        this.key = null;
        this.openEvents?.abort();
        this.resize?.disconnect();
        this.changes?.disconnect();
        this.window.cancelAnimationFrame(this.frame);
        this.frame = 0;
        button?.setAttribute("aria-expanded", "false");
        this.elements.sheet.hidePopover();
        if (returnFocus) button?.focus({preventScroll:true});
    }

    /** Detach the sheet and its file actions when the map workspace is destroyed. @return {void} */
    destroy() { this.close(false); this.bindings?.abort(); }
}
