/** DOM presentation for raster values anchored at the last picked location. */
import { formatRasterPixelValue } from "./value-format.js";
import { requireRasterControl } from "./required-control.js";

const POINTER_OFFSET_PIXELS = 14;
const VIEWPORT_EDGE_PIXELS = 8;
const COPY_FEEDBACK_MILLISECONDS = 1200;

/**
 * @typedef {Object} RasterCursorValueSample
 * @property {string} key Stable raster identity.
 * @property {string} label Readable raster name.
 * @property {"loading"|"value"|"nodata"|"outside"|"error"} state Raw result state.
 * @property {number|null} value Finite value only in value state.
 * @property {string} errorMessage Read failure detail.
 * @property {string} [displayValue] Optional owner-prepared value text.
 *
 * @typedef {Object} RasterCursorValueSnapshot
 * @property {Readonly<{latitude:number,longitude:number}>} position Sample point.
 * @property {ReadonlyArray<Readonly<RasterCursorValueSample>>} samples Results.
 * @property {number} omittedCount Participants omitted by the sampling limit.
 */

/**
 * Return whether a keyboard event belongs to an editable control.
 *
 * @param {EventTarget|null} target Event target.
 * @return {boolean} Whether application shortcuts must leave it alone.
 */
function isEditableTarget(target) {
    const tagName = String(target?.tagName ?? "").toLowerCase();
    return target?.isContentEditable === true ||
        ["input", "select", "textarea"].includes(tagName);
}

/**
 * Format the current geographic position for compact on-map presentation.
 *
 * @param {{latitude:number,longitude:number}} position Canonical WGS 84 point.
 * @return {string} Readable latitude and longitude.
 */
function formatPosition(position) {
    return `Lat ${position.latitude.toFixed(5)} · Lng ${position.longitude.toFixed(5)}`;
}

/**
 * Choose the readout position beside the picked pixel, preferring the right.
 * If both sides overlap a tool, try the tool edges and prefer the least overlap.
 * @param {{clientX:number,clientY:number}} anchor Accepted pick in viewport coordinates.
 * @param {{width:number,height:number}} size Rendered readout dimensions in CSS pixels.
 * @param {number} viewportWidth Browser viewport width in CSS pixels.
 * @param {number} viewportHeight Browser viewport height in CSS pixels.
 * @param {ReadonlyArray<DOMRect>} panels Visible tool rectangles in viewport coordinates.
 * @return {{left:number,top:number}} Top-left corner of the readout.
 */
function chooseReadoutPosition(anchor, { width, height }, viewportWidth, viewportHeight, panels) {
    const maxLeft = viewportWidth - width - VIEWPORT_EDGE_PIXELS;
    const maxTop = viewportHeight - height - VIEWPORT_EDGE_PIXELS;
    const leftOfPick = anchor.clientX - width - POINTER_OFFSET_PIXELS;
    const rightOfPick = anchor.clientX + POINTER_OFFSET_PIXELS;
    const belowPick = anchor.clientY + POINTER_OFFSET_PIXELS;
    const preferredLeft = rightOfPick <= maxLeft ? rightOfPick : leftOfPick;
    const preferredTop = belowPick <= maxTop ? belowPick : anchor.clientY - height - POINTER_OFFSET_PIXELS;
    const candidates = [
        [preferredLeft, preferredTop],
        [leftOfPick, preferredTop],
        ...panels.map(panel => [panel.left - width, preferredTop]),
        ...panels.map(panel => [preferredLeft, panel.bottom]),
        ...panels.map(panel => [preferredLeft, panel.top - height]),
    ];
    let bestPosition;
    let leastOverlap = Infinity;
    for (const [x, y] of candidates) {
        const left = Math.max(VIEWPORT_EDGE_PIXELS, Math.min(x, maxLeft));
        const top = Math.max(VIEWPORT_EDGE_PIXELS, Math.min(y, maxTop));
        const overlap = panels.reduce((area, panel) => {
            const overlapWidth = Math.max(0, Math.min(left + width, panel.right) - Math.max(left, panel.left));
            const overlapHeight = Math.max(0, Math.min(top + height, panel.bottom) - Math.max(top, panel.top));
            return area + overlapWidth * overlapHeight;
        }, 0);
        if (overlap === 0) return { left, top };
        if (overlap < leastOverlap) {
            leastOverlap = overlap;
            bestPosition = { left, top };
        }
    }
    return bestPosition;
}

/**
 * Produce a tab-separated clipboard representation of one picker snapshot.
 *
 * @param {Readonly<RasterCursorValueSnapshot>} snapshot
 * Current immutable pixel-picker snapshot.
 * @return {string} Geographic position followed by visible raster values.
 */
export function formatRasterCursorValuesForClipboard(snapshot) {
    const lines = [
        `Latitude\t${snapshot.position.latitude}`,
        `Longitude\t${snapshot.position.longitude}`,
    ];
    for (const sample of snapshot.samples) {
        if (sample.state === "outside") continue;
        const value = sample.state === "value"
            ? sample.displayValue ?? formatRasterPixelValue(sample.value)
            : sample.state === "nodata"
                ? "No data"
                : sample.state === "loading"
                    ? "Reading"
                    : `Unavailable: ${sample.errorMessage}`;
        lines.push(`${sample.label}\t${value}`);
    }
    if (snapshot.omittedCount > 0) {
        lines.push(`Additional rasters omitted\t${snapshot.omittedCount}`);
    }
    return lines.join("\n");
}

/** Present immutable pixel-picker snapshots without owning sampling policy. */
export class RasterCursorValuesView {
    /**
     * Connect the readout to its marker, controls and the map panels it must avoid.
     *
     * @param {Document} [documentContext=globalThis.document] Owning document.
     * @param {{writeText:(text:string)=>Promise<void>}|null} [clipboard=null]
     * Clipboard boundary; null resolves it from the owning window when possible.
     * @param {{setTimeout:Function,clearTimeout:Function}} [clock=globalThis]
     * Injectable timer boundary for copy confirmation.
     * @throws {Error} If a required pixel-picker control is missing.
     */
    constructor(
        documentContext = globalThis.document,
        clipboard = null,
        clock = globalThis
    ) {
        this.documentContext = documentContext;
        this.clipboard = clipboard ??
            documentContext.defaultView?.navigator?.clipboard ?? null;
        this.clock = clock;
        this.root = requireRasterControl(
            documentContext,
            "#raster-cursor-values"
        );
        this.position = requireRasterControl(
            documentContext,
            "#raster-cursor-position"
        );
        this.list = requireRasterControl(
            documentContext,
            "#raster-cursor-value-list"
        );
        this.limit = requireRasterControl(
            documentContext,
            "#raster-cursor-value-limit"
        );
        this.copyFeedback = requireRasterControl(
            documentContext,
            "#raster-cursor-copy-feedback"
        );
        this.restore = requireRasterControl(
            documentContext,
            "#restore-raster-cursor-values"
        );
        this.marker = requireRasterControl(documentContext, "#raster-cursor-marker");
        this.pending = requireRasterControl(documentContext, "#raster-cursor-pending");
        this.placementObstacles = [...documentContext.querySelectorAll("[data-pixel-picker-obstacle]")];
        this.layoutObserver = null;
        this.pointerPosition = null;
        this.anchorPosition = null;
        this.snapshot = null;
        this.copyFeedbackTimeout = null;
        this.handlers = null;
        this.handleKeyDown = this.#handleKeyDown.bind(this);
        this.handleRestoreClick = this.#handleRestoreClick.bind(this);
    }

    /**
     * Bind picker shortcuts and keep the current readout clear as map panels resize.
     *
     * @param {{onHide:()=>void,onShow:()=>void}} handlers Interaction callbacks.
     * @return {void}
     * @throws {TypeError} If a hide or show callback is missing.
     */
    bind(handlers) {
        if (
            typeof handlers?.onHide !== "function" ||
            typeof handlers?.onShow !== "function"
        ) {
            throw new TypeError("Pixel-picker handlers are incomplete");
        }
        this.unbind();
        this.handlers = handlers;
        this.restore.addEventListener("click", this.handleRestoreClick);
        this.documentContext.addEventListener("keydown", this.handleKeyDown);
        if (this.placementObstacles.length) {
            this.layoutObserver = new this.documentContext.defaultView.ResizeObserver(
                () => this.#applyPointerPosition()
            );
            for (const element of [this.documentContext.documentElement, this.root, ...this.placementObstacles]) {
                this.layoutObserver.observe(element, { box: "border-box" });
            }
        }
    }

    /** Stop handling picker controls and layout changes. @return {void} */
    unbind() {
        this.layoutObserver?.disconnect();
        this.layoutObserver = null;
        this.restore.removeEventListener("click", this.handleRestoreClick);
        this.documentContext.removeEventListener("keydown", this.handleKeyDown);
        this.#clearCopyFeedback();
        this.handlers = null;
    }

    /**
     * Retain the next pointer position while keeping the current pick anchored.
     *
     * @param {{clientX:number,clientY:number}} position Viewport coordinates.
     * @return {void}
     */
    move(position) {
        if (
            !Number.isFinite(position?.clientX) ||
            !Number.isFinite(position?.clientY)
        ) {
            return;
        }
        this.pointerPosition = { ...position };
        if (this.snapshot !== null) {
            this.pending.hidden = false;
            this.root.setAttribute("aria-busy", "true");
        }
    }

    /**
     * Present the picker and its restore prompt for the current map mode.
     *
     * @param {boolean} enabled Whether pointer sampling is enabled.
     * @param {boolean} [canRestore=true] Whether a hidden picker can resume in this mode.
     * @return {void}
     */
    setEnabled(enabled, canRestore = true) {
        if (typeof enabled !== "boolean") {
            throw new TypeError("Pixel-picker enabled state must be boolean");
        }
        this.restore.hidden = enabled || !canRestore;
        if (!enabled) this.clear();
    }

    /**
     * Render visible results beside their picked location. Keep the prior pick
     * during replacement loading, then commit the new position and values
     * together on the first available result. Initial loading stays hidden;
     * outside-only results disappear.
     *
     * @param {Readonly<RasterCursorValueSnapshot>} snapshot Pixel-picker
     * snapshot with optional owner-prepared display text for value results.
     * @return {void}
     * @throws {TypeError} If position, sample list, or omitted count is invalid.
     */
    render(snapshot) {
        if (
            snapshot === null ||
            typeof snapshot !== "object" ||
            !Number.isFinite(snapshot.position?.latitude) ||
            !Number.isFinite(snapshot.position?.longitude) ||
            !Array.isArray(snapshot.samples) ||
            !Number.isInteger(snapshot.omittedCount) ||
            snapshot.omittedCount < 0
        ) {
            throw new TypeError("Raster cursor snapshot is invalid");
        }
        const samples = snapshot.samples.filter(
            (sample) => sample.state !== "outside"
        );
        if (samples.length > 0 &&
            samples.every((sample) => sample.state === "loading")) {
            if (this.snapshot !== null) {
                this.pending.hidden = false;
                this.root.setAttribute("aria-busy", "true");
            }
            return;
        }
        if (samples.length === 0) {
            this.clear();
            return;
        }
        const rows = samples.map((sample) => {
            const row = this.documentContext.createElement("div");
            row.className = "raster-cursor-value-row";
            row.setAttribute("data-state", sample.state);
            const name = this.documentContext.createElement("dt");
            name.textContent = sample.label;
            name.title = sample.label;
            const value = this.documentContext.createElement("dd");
            value.textContent = sample.state === "loading"
                ? "Reading…"
                : sample.state === "value"
                    ? sample.displayValue ?? formatRasterPixelValue(sample.value)
                    : sample.state === "nodata"
                        ? "No data"
                        : `Unavailable: ${sample.errorMessage}`;
            row.append(name, value);
            return row;
        });
        const changedPosition = this.snapshot === null ||
            this.snapshot.position.latitude !== snapshot.position.latitude ||
            this.snapshot.position.longitude !== snapshot.position.longitude;
        if (changedPosition) {
            this.anchorPosition = this.pointerPosition;
            this.#clearCopyFeedback();
        }
        this.snapshot = snapshot;
        this.pending.hidden = true;
        this.position.textContent = formatPosition(snapshot.position);
        this.list.replaceChildren(...rows);
        this.limit.textContent = snapshot.omittedCount > 0
            ? `${snapshot.omittedCount} additional rasters omitted.`
            : "";
        this.limit.hidden = snapshot.omittedCount === 0;
        this.root.setAttribute(
            "aria-busy",
            String(samples.some((sample) => sample.state === "loading"))
        );
        this.root.hidden = false;
        this.#applyPointerPosition();
    }

    /**
     * Re-present the retained pick without accepting a newer pending position.
     * Composition supplies only a display projection of the same raw results.
     * The accepted geographic point, marker, pending indicator, and busy state
     * remain intact; subsequent clipboard writes use the updated presentation.
     * A cleared picker is a no-op and does not invoke the callback.
     *
     * @param {(snapshot:Readonly<RasterCursorValueSnapshot>)=>Readonly<RasterCursorValueSnapshot>}
     * projectSnapshot Pure projection preserving point, participants and values.
     * @return {void}
     * @throws {TypeError} If the projection changes the retained sample identity.
     * @throws {Error} If the injected projection fails.
     */
    refreshPresentation(projectSnapshot) {
        if (this.snapshot === null) return;
        const snapshot = projectSnapshot(this.snapshot);
        if (
            snapshot?.position?.latitude !== this.snapshot.position.latitude ||
            snapshot?.position?.longitude !== this.snapshot.position.longitude ||
            snapshot.omittedCount !== this.snapshot.omittedCount ||
            !Array.isArray(snapshot.samples) ||
            snapshot.samples.length !== this.snapshot.samples.length ||
            snapshot.samples.some((sample, index) => {
                const previous = this.snapshot.samples[index];
                return sample?.key !== previous.key || sample?.state !== previous.state ||
                    sample?.value !== previous.value;
            })
        ) {
            throw new TypeError("Pixel presentation must preserve the retained sample");
        }
        const pendingHidden = this.pending.hidden;
        const busy = this.root.getAttribute("aria-busy");
        this.render(snapshot);
        this.pending.hidden = pendingHidden;
        this.root.setAttribute("aria-busy", busy);
    }

    /** Hide and empty the transient pixel-picker readout. @return {void} */
    clear() {
        this.#clearCopyFeedback();
        this.snapshot = null;
        this.anchorPosition = null;
        this.marker.hidden = true;
        this.pending.hidden = true;
        this.position.textContent = "";
        this.list.replaceChildren();
        this.limit.textContent = "";
        this.limit.hidden = true;
        this.root.setAttribute("aria-busy", "false");
        this.root.hidden = true;
    }

    /** Remove any pending clipboard confirmation and its visual emphasis. */
    #clearCopyFeedback() {
        if (this.copyFeedbackTimeout !== null) {
            this.clock.clearTimeout(this.copyFeedbackTimeout);
            this.copyFeedbackTimeout = null;
        }
        this.copyFeedback.hidden = true;
        this.root.classList.remove("is-copy-confirmed");
    }

    /** Briefly confirm a successful clipboard write without a live announcement. */
    #showCopyFeedback() {
        this.#clearCopyFeedback();
        this.copyFeedback.hidden = false;
        this.root.classList.add("is-copy-confirmed");
        this.copyFeedbackTimeout = this.clock.setTimeout(() => {
            this.copyFeedbackTimeout = null;
            this.copyFeedback.hidden = true;
            this.root.classList.remove("is-copy-confirmed");
        }, COPY_FEEDBACK_MILLISECONDS);
    }

    /** Copy the current resolved presentation and confirm only after success. */
    async #copyCurrentValues() {
        if (this.snapshot === null || typeof this.clipboard?.writeText !== "function") {
            return;
        }
        try {
            await this.clipboard.writeText(
                formatRasterCursorValuesForClipboard(this.snapshot)
            );
        } catch {
            return;
        }
        this.#showCopyFeedback();
    }

    /** Anchor the marker and prefer a readout to its right when clear of map panels and viewport edges. @return {void} */
    #applyPointerPosition() {
        if (this.anchorPosition === null || this.root.hidden) return;
        const { clientX, clientY } = this.anchorPosition;
        this.marker.style.left = `${clientX}px`;
        this.marker.style.top = `${clientY}px`;
        this.marker.hidden = false;
        const panels = this.placementObstacles.map(element => element.getBoundingClientRect())
            .filter(panel => panel.right > panel.left && panel.bottom > panel.top);
        const { left, top } = chooseReadoutPosition(this.anchorPosition, this.root.getBoundingClientRect(),
            this.documentContext.defaultView?.innerWidth ?? 1024,
            this.documentContext.defaultView?.innerHeight ?? 768, panels);
        this.root.style.left = `${left}px`;
        this.root.style.top = `${top}px`;
    }

    /** Restore pointer sampling when the on-map prompt is available. @return {void} */
    #handleRestoreClick() {
        if (!this.restore.hidden) this.handlers?.onShow();
    }

    /**
     * Handle only picker-specific shortcuts outside editable controls.
     *
     * @param {KeyboardEvent} event Keyboard input.
     * @return {void}
     */
    #handleKeyDown(event) {
        if (isEditableTarget(event.target)) return;
        const key = String(event.key ?? "").toLowerCase();
        if (key === "escape" && !this.root.hidden) {
            event.preventDefault();
            this.handlers?.onHide();
            return;
        }
        if (key === "p" && this.restore.hidden === false &&
            !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            this.handlers?.onShow();
            return;
        }
        if (key === "c" && (event.ctrlKey || event.metaKey) &&
            !event.altKey && !this.root.hidden && this.snapshot !== null) {
            event.preventDefault();
            void this.#copyCurrentValues();
        }
    }
}
