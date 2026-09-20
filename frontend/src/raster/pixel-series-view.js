/** Controls and chart presentation for the pixels at a retained map click. */
import { formatSeriesNumber, renderOrdinalSeriesChart } from "../charts/series-chart.js";

const STATES = { waiting: "Not sampled", loading: "Reading…", nodata: "No data", outside: "Outside raster", error: "Unavailable" };

/** Display Raster series without accessing map, renderer or request state. */
export class RasterPixelSeriesView {
    /**
     * Find the plot's existing markup.
     * @param {Document} [documentContext=document] Owning browser document.
     */
    constructor(documentContext = document) {
        this.document = documentContext;
        this.root = documentContext.querySelector("#raster-series");
        this.context = documentContext.querySelector("#raster-series-context");
        this.status = documentContext.querySelector("#raster-series-status");
        this.sources = documentContext.querySelector("#raster-series-sources");
        this.sourceSummary = documentContext.querySelector("#raster-series-source-summary");
        this.chart = documentContext.querySelector("#raster-series-chart");
        this.chartNote = documentContext.querySelector("#raster-series-chart-note");
        this.table = documentContext.querySelector("#raster-series-table-body");
        this.download = documentContext.querySelector("#raster-series-download");
        this.retry = documentContext.querySelector("#raster-series-retry");
        this.sourceSignature = null;
    }

    /**
     * Connect controls to the series owner.
     * @param {Object} actions User actions.
     * @param {()=>void} actions.onClose Close the plot.
     * @param {(key:string,selected:boolean)=>void} actions.onSelect Change a raster choice.
     * @param {(order:string,direction:string)=>void} actions.onOrder Change plot order.
     * @param {(type:string)=>void} actions.onChartType Change line/scatter presentation.
     * @param {()=>void} actions.onRetry Retry the selected pixels.
     * @param {()=>void} actions.onDownload Download the current values.
     * @return {void}
     */
    bind(actions) {
        this.actions = actions;
        this.document.querySelector("#close-raster-series").addEventListener("click", actions.onClose);
        const order = this.document.querySelector("#raster-series-order");
        const direction = this.document.querySelector("#raster-series-direction");
        for (const input of [order, direction]) input.addEventListener("change", () => actions.onOrder(order.value, direction.value));
        this.document.querySelector("#raster-series-chart-type").addEventListener("change", event => actions.onChartType(event.target.value));
        this.download.addEventListener("click", actions.onDownload);
        this.retry.addEventListener("click", actions.onRetry);
    }

    /**
     * Refresh values while preserving keyboard focus and the raster checklist disclosure.
     * @param {Object} state Plot presentation.
     * @param {Object[]} state.sources Available rasters with their selected flag.
     * @param {Object[]} state.rows Ordered current pixel results.
     * @param {Object[]|null} state.previousRows Previous click's rows while no new value has arrived.
     * @param {{longitude:number,latitude:number}|null} state.position Current click.
     * @param {string} state.message Progress, guidance or result summary.
     * @param {boolean} state.busy Whether pixels are still being read.
     * @param {"line"|"scatter"} state.chartType Plot geometry.
     * @param {boolean} state.canDownload Whether a completed table can be exported.
     * @param {boolean} state.canRetry Whether the current selection can be sampled.
     * @return {void}
     */
    render(state) {
        this.context.textContent = state.position
            ? `Pixel values at ${state.position.latitude.toFixed(5)}, ${state.position.longitude.toFixed(5)}`
            : "Pixel values across raster layers";
        this.status.textContent = state.message;
        this.root.setAttribute("aria-busy", String(state.busy));
        this.sourceSummary.textContent = `Rasters · ${state.sources.filter(source => source.selected).length} selected`;
        const signature = JSON.stringify(state.sources.map(({ key, label, selected }) => [key, label, selected]));
        if (signature !== this.sourceSignature) {
            this.sourceSignature = signature;
            const focusedKey = this.document.activeElement?.dataset?.rasterKey;
            this.sources.replaceChildren(...state.sources.map(source => {
                const label = this.document.createElement("label");
                const checkbox = this.document.createElement("input");
                checkbox.type = "checkbox"; checkbox.checked = source.selected;
                checkbox.dataset.rasterKey = source.key;
                checkbox.addEventListener("change", () => this.actions.onSelect(source.key, checkbox.checked));
                const name = this.document.createElement("span"); name.textContent = source.label;
                label.append(checkbox, name);
                return label;
            }));
            if (focusedKey) {
                for (const input of this.sources.querySelectorAll("input")) {
                    if (input.dataset.rasterKey === focusedKey) input.focus({ preventScroll: true });
                }
            }
        }
        this.chart.replaceChildren();
        const plottedRows = state.previousRows?.some(row => row.state === "value") ? state.previousRows : state.rows;
        const showingPrevious = plottedRows === state.previousRows;
        this.chart.classList.toggle("is-previous", showingPrevious);
        this.chartNote.hidden = !showingPrevious;
        this.chartNote.textContent = showingPrevious ? "Previous plot — reading the new click…" : "";
        this.chart.hidden = !plottedRows.some(row => row.state === "value");
        if (!this.chart.hidden) {
            renderOrdinalSeriesChart({
                documentContext: this.document, chart: this.chart,
                points: plottedRows.map(row => ({ xLabel: row.label, yValue: row.state === "value" ? row.value : null })),
                chartType: state.chartType, xAxisLabel: "Raster", yAxisLabel: "Pixel value",
                ariaLabel: showingPrevious ? "Previous raster pixel series; replacement values are being read" : "Pixel values across selected rasters",
                pointAccessibleLabel: point => `${point.xLabel}: ${formatSeriesNumber(point.yValue)}`,
                pointTooltip: point => `${point.xLabel}\nPixel value: ${formatSeriesNumber(point.yValue)}`,
            });
        }
        this.table.replaceChildren(...state.rows.map(row => {
            const tr = this.document.createElement("tr");
            for (const value of [row.label, row.state === "value" ? formatSeriesNumber(row.value) : "—",
                row.errorMessage || (row.state === "value" ? "Value" : STATES[row.state])]) {
                const cell = this.document.createElement("td"); cell.textContent = value; tr.append(cell);
            }
            return tr;
        }));
        this.download.disabled = !state.canDownload;
        this.retry.disabled = !state.canRetry;
    }

    /**
     * Download the completed table as a UTF-8 CSV file.
     * @param {string} csv CSV content supplied by the series owner.
     * @return {void}
     */
    downloadCsv(csv) {
        if (!csv) return;
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        const link = this.document.createElement("a");
        link.href = url; link.download = "raster-pixel-series.csv";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

