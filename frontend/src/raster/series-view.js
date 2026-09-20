/** Controls and chart presentation for raster pixel and area series. */
import { formatSeriesNumber, renderOrdinalSeriesChart } from "../charts/series-chart.js";

const STATES = { waiting: "Not sampled", loading: "Reading…", nodata: "No data", outside: "Outside raster", error: "Unavailable", no_matches: "No matches", no_valid_data: "No valid data", invalid_arithmetic: "Invalid arithmetic", overflow: "Overflow" };

/** Display Raster series without accessing map, renderer or request state. */
export class RasterSeriesView {
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
        this.areaControls = documentContext.querySelector("#raster-series-area-controls");
        this.formulaRows = documentContext.querySelector("#raster-series-formulas");
        this.statistic = documentContext.querySelector("#raster-series-statistic");
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
     * @param {(mode:string)=>void} actions.onMode Pixel or area statistics.
     * @param {(choice:string)=>void} actions.onArea Sampling area or whole raster.
     * @param {()=>void} actions.onEditArea Open existing area controls.
     * @param {(preset:string)=>void} actions.onAddFormula Add statistic.
     * @param {(id:number,change:Object)=>void} actions.onEditFormula Update formula/name.
     * @param {(id:number)=>void} actions.onRemoveFormula Remove statistic.
     * @param {(id:number)=>void} actions.onStatistic Choose plotted statistic.
     * @param {()=>void} actions.onCalculate Calculate remaining sources.
     * @param {()=>void} actions.onCancel Cancel remaining work.
     * @param {()=>void} actions.onRecover Recover uncertain submission.
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
        for (const [id, action] of [["mode", actions.onMode], ["area", actions.onArea]]) {
            this.document.querySelector("#raster-series-" + id).addEventListener("change", event => action(event.target.value));
        }
        this.document.querySelector("#raster-series-add-formula").addEventListener("change", event => {
            actions.onAddFormula(event.target.value); event.target.value = "";
        });
        this.statistic.addEventListener("change", event => actions.onStatistic(Number(event.target.value)));
        for (const [id, action] of [["edit-area", actions.onEditArea], ["calculate", actions.onCalculate],
            ["cancel", actions.onCancel], ["recover", actions.onRecover]]) {
            this.document.querySelector("#raster-series-" + id).addEventListener("click", action);
        }
    }

    /**
     * Refresh values while preserving keyboard focus and the raster checklist disclosure.
     * @param {Object} state Plot presentation.
     * @param {Object[]} state.sources Available rasters with their selected flag.
     * @param {Object[]} state.rows Ordered current pixel or statistic results.
     * @param {Object[]|null} state.previousRows Previous input's rows while no new value has arrived.
     * @param {{longitude:number,latitude:number}|null} state.position Current click.
     * @param {string} state.message Progress, guidance or result summary.
     * @param {boolean} state.busy Whether the current workflow is still running.
     * @param {"line"|"scatter"} state.chartType Plot geometry.
     * @param {boolean} state.canDownload Whether a completed table can be exported.
     * @param {boolean} state.canRetry Whether the current selection can be sampled.
     * @param {"pixel"|"area"} state.mode Series mode.
     * @param {Object} [state.area] Area calculation presentation.
     * @param {string} [state.axisLabel] Selected statistic and its unit.
     * @param {number} [state.selectedStatistic] Formula identity.
     * @return {void}
     */
    render(state) {
        const areaMode = state.mode === "area";
        this.areaControls.hidden = !areaMode;
        this.document.querySelector("#raster-series-mode").value = state.mode ?? "pixel";
        this.retry.hidden = areaMode;
        if (!areaMode) this.status.classList.remove("raster-series-confirmation");
        this.document.querySelector("#raster-series-value-heading").textContent = areaMode ? state.axisLabel : "Pixel value";
        if (areaMode) this.renderAreaControls(state);
        this.context.textContent = areaMode ? (state.area.areaChoice === "whole" ? "Whole extent of each raster" : state.area.areaLabel || "No sampling area selected") : state.position
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
        this.chartNote.textContent = showingPrevious ? (areaMode ? "Previous results — calculating replacements." : "Previous plot — reading the new click.") : "";
        this.chart.hidden = !plottedRows.some(row => row.state === "value");
        if (!this.chart.hidden) {
            renderOrdinalSeriesChart({
                documentContext: this.document, chart: this.chart,
                points: plottedRows.map(row => ({ xLabel: row.label, yValue: row.state === "value" ? row.value : null })),
                chartType: state.chartType, xAxisLabel: "Raster", yAxisLabel: state.axisLabel ?? "Pixel value",
                ariaLabel: showingPrevious ? "Previous raster series; replacements are pending" : (state.axisLabel ?? "Pixel values") + " across selected rasters",
                pointAccessibleLabel: point => `${point.xLabel}: ${formatSeriesNumber(point.yValue)}`,
                pointTooltip: point => `${point.xLabel}\n${state.axisLabel ?? "Pixel value"}: ${formatSeriesNumber(point.yValue)}`,
            });
        }
        this.table.replaceChildren(...state.rows.map(row => {
            const tr = this.document.createElement("tr");
            for (const value of [row.label, row.state === "value" ? (row.rawValue ?? formatSeriesNumber(row.value)) + (row.unit ? " " + row.unit : "") : "—",
                row.errorMessage || (row.state === "value" ? (row.cached ? "Cached" : "Value") : STATES[row.state])]) {
                const cell = this.document.createElement("td"); cell.textContent = value; tr.append(cell);
            }
            return tr;
        }));
        this.download.disabled = !state.canDownload;
        this.retry.disabled = !state.canRetry;
    }


    /** Update formula controls without replacing focused inputs during progress.
     * @param {Object} state Area-series presentation. @return {void}
     */
    renderAreaControls(state) {
        const area = state.area;
        const signature = area.formulas.map(formula => formula.id).join(",");
        if (this.formulaSignature !== signature) {
            this.formulaSignature = signature;
            this.formulaRows.replaceChildren(...area.formulas.map(formula => {
                const row = this.document.createElement("div"); row.className = "raster-series-formula";
                row.dataset.formulaId = String(formula.id);
                for (const [field, label, limit] of [["label", "Statistic name", 80], ["expression", "Formula", 4096]]) {
                    const input = this.document.createElement("input");
                    input.dataset.field = field; input.setAttribute("aria-label", label); input.placeholder = label; input.maxLength = limit;
                    input.addEventListener("input", () => this.actions.onEditFormula(formula.id, { [field]: input.value }));
                    row.append(input);
                }
                const remove = this.document.createElement("button"); remove.type = "button"; remove.textContent = "×";
                remove.setAttribute("aria-label", "Remove statistic"); remove.className = "secondary-button";
                remove.disabled = area.formulas.length === 1;
                remove.addEventListener("click", () => this.actions.onRemoveFormula(formula.id));
                row.append(remove); return row;
            }));
        }
        for (const row of this.formulaRows.children) {
            const formula = area.formulas.find(item => item.id === Number(row.dataset.formulaId));
            for (const input of row.querySelectorAll("input")) if (input !== this.document.activeElement) input.value = formula[input.dataset.field];
        }
        const optionsKey = JSON.stringify(area.formulas.map(({id,label,expression})=>[id,label,expression]));
        if (this.statisticOptions !== optionsKey) {
            this.statisticOptions = optionsKey;
            this.statistic.replaceChildren(...area.formulas.map(formula => {
                const option = this.document.createElement("option"); option.value = String(formula.id);
                option.textContent = formula.label || formula.expression || "Custom statistic"; return option;
            }));
        }
        this.statistic.value = String(state.selectedStatistic);
        this.document.querySelector("#raster-series-area").value = area.areaChoice;
        this.document.querySelector("#raster-series-add-formula").disabled = area.formulas.length >= 5;
        const calculate = this.document.querySelector("#raster-series-calculate");
        calculate.disabled = (state.busy && !area.confirmation) || !area.sources.length || area.sources.length > 50 || (area.areaChoice !== "whole" && !area.area);
        calculate.hidden = area.complete && !area.hasErrors;
        calculate.textContent = area.confirmation ? "Calculate remaining " + (area.sources.length - area.results.size) + " rasters" : "Calculate";
        this.document.querySelector("#raster-series-cancel").hidden = !state.busy;
        this.document.querySelector("#raster-series-recover").hidden = !area.recoverable;
        this.status.classList.toggle("raster-series-confirmation", area.confirmation);
        const performance = this.document.querySelector("#raster-series-performance");
        const completedKey = JSON.stringify([area.elapsedSeconds, [...area.results].map(([key, result]) => [key, result.job?.jobId, result.error])]);
        if (this.performanceKey !== completedKey) {
            this.performanceKey = completedKey;
            performance.replaceChildren(...[...area.results].filter(([,result]) => result.job).map(([key, result]) => {
                const details = this.document.createElement("details");
                const summary = this.document.createElement("summary");
                summary.textContent = (area.sources.find(source => source.key === key)?.label ?? key) + " — " + result.elapsedSeconds.toFixed(3) + " s";
                details.append(summary);
                const timing = this.document.createElement("p");
                timing.textContent = "Time for this raster from its planning request to received result, including server queueing; excludes earlier formula debounce and validation.";
                details.append(timing);
                for (const line of result.performanceLines) {
                    const p = this.document.createElement("p"); p.textContent = line; details.append(p);
                }
                return details;
            }));
            if (area.elapsedSeconds != null) {
                const total = this.document.createElement("p");
                total.textContent = "Whole series: " + area.elapsedSeconds.toFixed(3) +
                    " s from requesting the series to the last result or error, including debounce, validation and any confirmation or recovery pauses.";
                performance.prepend(total);
            }
        }
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
        link.href = url; link.download = "raster-series.csv";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}
