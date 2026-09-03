/** DOM presentation for transient raster values beneath the map cursor. */
import { formatRasterPixelValue } from "./value-format.js";
import { requireRasterControl } from "./required-control.js";

/** Present immutable cursor snapshots without owning interaction or policy. */
export class RasterCursorValuesView {
    /**
     * Resolve the cursor-value DOM contract.
     *
     * @param {Document} [documentContext=globalThis.document] Owning document.
     */
    constructor(documentContext = globalThis.document) {
        this.documentContext = documentContext;
        this.root = requireRasterControl(
            documentContext,
            "#raster-cursor-values"
        );
        this.list = requireRasterControl(
            documentContext,
            "#raster-cursor-value-list"
        );
        this.limit = requireRasterControl(
            documentContext,
            "#raster-cursor-value-limit"
        );
    }

    /**
     * Render visible results; actual outside responses disappear from the list.
     *
     * @param {{samples:Object[],omittedCount:number}} snapshot Cursor snapshot.
     */
    render(snapshot) {
        if (
            snapshot === null ||
            typeof snapshot !== "object" ||
            !Array.isArray(snapshot.samples) ||
            !Number.isInteger(snapshot.omittedCount) ||
            snapshot.omittedCount < 0
        ) {
            throw new TypeError("Raster cursor snapshot is invalid");
        }
        const samples = snapshot.samples.filter(
            (sample) => sample.state !== "outside"
        );
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
                    ? formatRasterPixelValue(sample.value)
                    : sample.state === "nodata"
                        ? "No data"
                        : `Unavailable: ${sample.errorMessage}`;
            row.append(name, value);
            return row;
        });
        this.list.replaceChildren(...rows);
        this.limit.textContent = snapshot.omittedCount > 0
            ? `${snapshot.omittedCount} additional in-bounds rasters omitted.`
            : "";
        this.limit.hidden = snapshot.omittedCount === 0;
        this.root.setAttribute(
            "aria-busy",
            String(samples.some((sample) => sample.state === "loading"))
        );
        this.root.hidden = false;
    }

    /** Hide and empty the transient cursor readout. */
    clear() {
        this.list.replaceChildren();
        this.limit.textContent = "";
        this.limit.hidden = true;
        this.root.setAttribute("aria-busy", "false");
        this.root.hidden = true;
    }
}
