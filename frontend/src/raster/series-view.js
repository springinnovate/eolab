/** Controls and chart presentation for raster formula series. */
import { formatSeriesNumber } from "../charts/series-chart.js";
import { createStatisticSwatch, RasterSeriesPlotsView } from "./series-plots-view.js";

const STATES = { waiting: "Waiting", error: "Unavailable", no_matches: "No matches", no_valid_data: "No valid data", invalid_arithmetic: "Invalid arithmetic", overflow: "Overflow" };

/**
 * @typedef {Object} SeriesValueRow
 * @property {string} label Full raster name.
 * @property {string} statisticLabel Statistic name for the values table.
 * @property {string} state Value, pending or failure state from the owner.
 * @property {number|null} value Numeric plotting value.
 * @property {string|null} rawValue Exact scalar representation.
 * @property {string} [unit] Returned unit.
 * @property {string} [errorMessage] Per-raster status or error explanation.
 * @property {boolean} [cached] Whether the value came from a completed cached calculation.
 */

/**
 * @typedef {Object} SeriesStatistic
 * @property {number} id Stable formula identity.
 * @property {string} label Editable statistic name.
 * @property {string} expression Formula over the current raster.
 * @property {boolean} visible Whether to plot the statistic.
 * @property {number} plotId Assigned plot identity.
 * @property {number} styleIndex Stable line/marker identity.
 * @property {SeriesValueRow[]} rows Current ordered values.
 * @property {SeriesValueRow[]|null} previousRows Retained values for replacement calculations.
 */

/**
 * @typedef {Object} SeriesPresentation
 * @property {boolean} active Whether the panel is open.
 * @property {{key:string,label:string,selected:boolean}[]} sources Available catalog rasters.
 * @property {SeriesValueRow[]} rows Current ordered values for the table.
 * @property {SeriesValueRow[]|null} previousRows Retained values for pending replacements.
 * @property {string} message Progress, guidance or result summary.
 * @property {boolean} busy Whether calculations are running.
 * @property {"line"|"scatter"} chartType Plot geometry.
 * @property {boolean} canDownload Whether current values can be exported.
 * @property {{formulas:SeriesStatistic[],sources:object[],areaChoice:string,area:object|null,areaLabel:string,complete:boolean,hasErrors:boolean,recoverable:boolean}} area Scope and execution availability supplied by the owner; the view does not inspect the sampling descriptor.
 * @property {SeriesStatistic[]} statistics Statistic presentation.
 * @property {{id:number,scale:string}[]} plots Independent plot settings.
 * @property {boolean} showingPrevious Whether plots use retained results.
 */

/** Display Raster series without accessing map, renderer or request state. */
export class RasterSeriesView {
    /**
     * Find the plot's existing markup.
     * @param {Document} [documentContext=document] Owning browser document.
     * @param {Object} [options] Presentation callbacks.
     * @param {(context:{source:string,scope:string})=>void} [options.onContextChange] Display-only chosen source/area context.
     */
    constructor(documentContext = document, { onContextChange = () => {} } = {}) {
        this.document = documentContext;
        this.onContextChange = onContextChange;
        this.root = documentContext.querySelector("#raster-series");
        this.context = documentContext.querySelector("#raster-series-context");
        this.status = documentContext.querySelector("#raster-series-status");
        this.sources = documentContext.querySelector("#raster-series-sources");
        this.sourceSummary = documentContext.querySelector("#raster-series-source-summary");
        this.chartNote = documentContext.querySelector("#raster-series-chart-note");
        this.table = documentContext.querySelector("#raster-series-table-body");
        this.download = documentContext.querySelector("#raster-series-download");
        this.sourceSignature = null;
        this.formulaRows = documentContext.querySelector("#raster-series-formulas");
        /** @type {Map<number, HTMLDivElement>} Retained editor nodes owned by this view. */
        this.formulaNodes = new Map();
        this.frame = null;
        this.pendingState = null;
    }

    /**
     * Connect controls to the series owner.
     * @param {Object} actions User actions.
     * @param {()=>void} actions.onClose Close the plot.
     * @param {(key:string,selected:boolean)=>void} actions.onSelect Change a raster choice.
     * @param {(order:string,direction:string)=>void} actions.onOrder Change plot order.
     * @param {(type:string)=>void} actions.onChartType Change line/scatter presentation.
     * @param {()=>void} actions.onDownload Download the current values.
     * @param {(choice:string)=>void} actions.onArea Sampling area or whole raster.
     * @param {()=>void} actions.onEditArea Open existing area controls.
     * @param {(preset:string)=>void} actions.onAddFormula Add statistic.
     * @param {(id:number,change:{label?:string,expression?:string})=>void} actions.onEditFormula Update formula/name.
     * @param {(id:number)=>void} actions.onRemoveFormula Remove statistic.
     * @param {(id:number,change:{visible?:boolean,plotId?:number})=>void} actions.onStatisticDisplay Change visibility or plot assignment.
     * @param {()=>void} actions.onAddPlot Add a linear plot.
     * @param {(id:number)=>void} actions.onRemovePlot Remove a secondary plot.
     * @param {(id:number,scale:string)=>void} actions.onPlotScale Change one Y scale.
     * @param {()=>void} actions.onCalculate Calculate remaining sources.
     * @param {()=>void} actions.onCancel Cancel remaining work.
     * @param {()=>void} actions.onRecover Recover uncertain submission.
     * @return {void}
     */
    bind(actions) {
        this.actions = actions;
        this.plotsView = new RasterSeriesPlotsView(this.document, actions);
        this.document.querySelector("#close-raster-series").addEventListener("click", actions.onClose);
        const order = this.document.querySelector("#raster-series-order");
        const direction = this.document.querySelector("#raster-series-direction");
        for (const input of [order, direction]) input.addEventListener("change", () => actions.onOrder(order.value, direction.value));
        this.document.querySelector("#raster-series-chart-type").addEventListener("change", event => actions.onChartType(event.target.value));
        this.download.addEventListener("click", actions.onDownload);
        this.document.querySelector("#raster-series-area").addEventListener("change", event => actions.onArea(event.target.value));
        this.document.querySelector("#raster-series-add-formula").addEventListener("change", event => {
            actions.onAddFormula(event.target.value); event.target.value = "";
        });
        this.document.querySelector("#raster-series-add-plot").addEventListener("click", actions.onAddPlot);
        for (const [id, target] of [["show-plots", "plots"], ["edit-statistics", "statistics-title"],
            ["edit-data", "source-summary"]]) {
            this.document.querySelector("#raster-series-" + id).addEventListener("click", () => {
                if (id === "edit-data") this.document.querySelector("#raster-series-data-settings").open = true;
                const section = this.document.querySelector("#raster-series-" + target);
                section.focus({ preventScroll: true });
                section.scrollIntoView({ block: "start", inline: "nearest" });
            });
        }
        for (const [id, action] of [["edit-area", actions.onEditArea], ["calculate", actions.onCalculate],
            ["cancel", actions.onCancel], ["recover", actions.onRecover]]) {
            this.document.querySelector("#raster-series-" + id).addEventListener("click", action);
        }
    }

    /**
     * Schedule the latest presentation for a browser frame, without drawing in a result callback.
     * Multiple updates before that frame replace its pending snapshot. Results
     * remain in the controller; intermediate drawings may be skipped. Closing
     * the panel cancels pending drawing, and reopening supplies current state.
     * @param {SeriesPresentation} state Plot presentation.
     * @return {void}
     */
    render(state) {
        const sources = state.sources.filter(source => source.selected);
        this.onContextChange({ source: sources.length === 1 ? sources[0].label : `${sources.length} selected rasters`,
            scope: state.area.areaChoice === "whole" ? "Whole extent of each raster" : state.area.areaLabel || "No sampling area selected" });
        this.pendingState = state;
        if (!state.active) {
            if (this.frame !== null) this.document.defaultView.cancelAnimationFrame(this.frame);
            this.frame = null;
            this.pendingState = null;
            return;
        }
        if (this.frame !== null) return;
        this.frame = this.document.defaultView.requestAnimationFrame(() => {
            this.frame = null;
            const latest = this.pendingState;
            this.pendingState = null;
            this.draw(latest);
        });
    }

    /** Update changed controls and figures from one coalesced snapshot.
     * Unchanged presentation leaves existing DOM nodes and attributes intact.
     * @param {SeriesPresentation} state Latest presentation supplied to render().
     * @return {void}
     */
    draw(state) {
        this.renderAreaControls(state);
        const scope = state.area.areaChoice === "whole" ? "Whole extent of each raster" : state.area.areaLabel || "No sampling area selected";
        const selectedCount = state.sources.filter(source => source.selected).length;
        const context = `${scope} · ${selectedCount} ${selectedCount === 1 ? "raster" : "rasters"}`;
        if (this.context.textContent !== context) this.context.textContent = context;
        if (this.status.textContent !== state.message) this.status.textContent = state.message;
        const busy = String(state.busy);
        if (this.root.getAttribute("aria-busy") !== busy) this.root.setAttribute("aria-busy", busy);
        const order = this.document.querySelector("#raster-series-order").value === "name" ? "Layer name" : "Map layer order";
        const direction = this.document.querySelector("#raster-series-direction").value === "reverse" ? "Reverse" : "Forward";
        const chartType = state.chartType === "scatter" ? "Scatter" : "Line";
        const dataSummary = `Data and order · ${selectedCount} selected · ${order} · ${direction} · ${chartType}`;
        if (this.sourceSummary.textContent !== dataSummary) this.sourceSummary.textContent = dataSummary;
        const statisticsLink = this.document.querySelector("#raster-series-edit-statistics");
        const statisticCount = `Statistics (${state.statistics.length})`;
        if (statisticsLink.textContent !== statisticCount) statisticsLink.textContent = statisticCount;
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
        const showingPrevious = state.showingPrevious;
        if (this.chartNote.hidden !== !showingPrevious) this.chartNote.hidden = !showingPrevious;
        const chartNote = showingPrevious ? "Previous results — calculating replacements." : "";
        if (this.chartNote.textContent !== chartNote) this.chartNote.textContent = chartNote;
        this.plotsView.renderPlots(state);
        const tableValues = state.rows.map(row => [row.label, row.statisticLabel,
            row.state === "value" ? (row.rawValue ?? formatSeriesNumber(row.value)) + (row.unit ? " " + row.unit : "") : "-",
            row.errorMessage || (row.state === "value" ? (row.cached ? "Cached" : "Value") : STATES[row.state])]);
        const tableSignature = JSON.stringify(tableValues);
        if (this.tableSignature !== tableSignature) {
            this.tableSignature = tableSignature;
            this.table.replaceChildren(...tableValues.map(values => {
                const tr = this.document.createElement("tr");
                for (const value of values) {
                    const cell = this.document.createElement("td"); cell.textContent = value; tr.append(cell);
                }
                return tr;
            }));
        }
        if (this.download.disabled !== !state.canDownload) this.download.disabled = !state.canDownload;
    }


    /** Update scope, execution actions and compact statistics without losing editor state.
     * @param {SeriesPresentation} state Area-series presentation.
     * @return {void}
     */
    renderAreaControls(state) {
        const area = state.area;
        const signature = area.formulas.map(formula => formula.id).join(",");
        if (this.formulaSignature !== signature) {
            this.formulaSignature = signature;
            const focused = this.document.activeElement;
            const ownedFocus = this.formulaRows.contains(focused);
            const ids = new Set(area.formulas.map(formula => formula.id));
            for (const id of this.formulaNodes.keys()) if (!ids.has(id)) this.formulaNodes.delete(id);
            this.formulaRows.replaceChildren(...state.statistics.map(formula => {
                if (!this.formulaNodes.has(formula.id)) this.formulaNodes.set(formula.id, this.createFormulaRow(formula));
                return this.formulaNodes.get(formula.id);
            }));
            if (this.formulaRows.contains(focused)) focused.focus({ preventScroll: true });
            else if (ownedFocus) this.document.querySelector("#raster-series-add-formula").focus();
        }
        for (const row of this.formulaRows.children) {
            const formula = state.statistics.find(item => item.id === Number(row.dataset.formulaId));
            const name = formula.label || formula.expression || "Custom statistic";
            const caption = row.querySelector("span");
            if (caption.textContent !== name) caption.textContent = name;
            const editor = row.querySelector("summary");
            const editLabel = `Edit ${name}`;
            if (editor.getAttribute("aria-label") !== editLabel) editor.setAttribute("aria-label", editLabel);
            const remove = row.querySelector("button");
            if (remove.disabled !== (area.formulas.length === 1)) remove.disabled = area.formulas.length === 1;
            const removeLabel = `Remove ${name}`;
            if (remove.getAttribute("aria-label") !== removeLabel) remove.setAttribute("aria-label", removeLabel);
            for (const input of row.querySelectorAll("input")) {
                if (input.dataset.field === "visible") {
                    if (input.checked !== formula.visible) input.checked = formula.visible;
                    const label = `Show ${name} on plot`;
                    if (input.getAttribute("aria-label") !== label) input.setAttribute("aria-label", label);
                } else if (input !== this.document.activeElement && input.value !== formula[input.dataset.field]) input.value = formula[input.dataset.field];
            }
            const plot = row.querySelector("select");
            const plotsKey = state.plots.map(item => item.id).join(",");
            if (plot.dataset.optionsKey !== plotsKey) {
                plot.dataset.optionsKey = plotsKey;
                plot.replaceChildren(...state.plots.map(item => {
                    const option = this.document.createElement("option"); option.value = String(item.id);
                    option.textContent = `Plot ${item.id}`; return option;
                }));
            }
            const label = `Plot for ${name}`;
            if (plot.getAttribute("aria-label") !== label) plot.setAttribute("aria-label", label);
            if (plot.value !== String(formula.plotId)) plot.value = String(formula.plotId);
        }
        const areaChoice = this.document.querySelector("#raster-series-area");
        if (areaChoice.value !== area.areaChoice) areaChoice.value = area.areaChoice;
        const addFormula = this.document.querySelector("#raster-series-add-formula");
        if (addFormula.disabled !== (area.formulas.length >= 5)) addFormula.disabled = area.formulas.length >= 5;
        const calculate = this.document.querySelector("#raster-series-calculate");
        const cannotCalculate = state.busy || !area.sources.length || (area.areaChoice !== "whole" && !area.area);
        if (calculate.disabled !== cannotCalculate) calculate.disabled = cannotCalculate;
        const hideCalculate = !!area.complete && !area.hasErrors;
        if (calculate.hidden !== hideCalculate) calculate.hidden = hideCalculate;
        if (calculate.textContent !== "Calculate") calculate.textContent = "Calculate";
        const cancel = this.document.querySelector("#raster-series-cancel");
        if (cancel.hidden !== !state.busy) cancel.hidden = !state.busy;
        const recover = this.document.querySelector("#raster-series-recover");
        if (recover.hidden !== !area.recoverable) recover.hidden = !area.recoverable;
    }

    /** Create a retained statistic row with visibility, assignment and a native editor disclosure.
     * Blank custom expressions start expanded; subsequent snapshots leave disclosure state alone.
     * @param {{id:number,label:string,expression:string,styleIndex:number}} formula Statistic identity and presentation.
     * @return {HTMLDivElement} Row whose input events use the existing owner callbacks.
     */
    createFormulaRow(formula) {
        const row = this.document.createElement("div"); row.className = "raster-series-formula";
        row.dataset.formulaId = String(formula.id);
        const legend = this.document.createElement("label"); legend.className = "raster-series-formula-legend";
        const visible = this.document.createElement("input"); visible.type = "checkbox"; visible.dataset.field = "visible";
        visible.addEventListener("change", () => this.actions.onStatisticDisplay(formula.id, { visible: visible.checked }));
        const name = this.document.createElement("span");
        legend.append(visible, createStatisticSwatch(this.document, formula.styleIndex), name);
        for (const event of ["pointerenter", "focusin"]) legend.addEventListener(event, () => this.plotsView.highlightStatistic(formula.id));
        for (const event of ["pointerleave", "focusout"]) legend.addEventListener(event, () => this.plotsView.highlightStatistic(null));
        const plot = this.document.createElement("select"); plot.dataset.field = "plotId";
        plot.addEventListener("change", () => this.actions.onStatisticDisplay(formula.id, { plotId: Number(plot.value) }));
        const editor = this.document.createElement("details"); editor.className = "raster-series-formula-editor";
        editor.open = !formula.expression;
        const summary = this.document.createElement("summary"); summary.textContent = "Edit"; editor.append(summary);
        for (const [field, label, limit] of [["label", "Statistic name", 80], ["expression", "Formula", 4096]]) {
            const fieldLabel = this.document.createElement("label"); fieldLabel.textContent = label;
            const input = this.document.createElement("input");
            input.dataset.field = field; input.setAttribute("aria-label", label); input.placeholder = label; input.maxLength = limit;
            input.addEventListener("input", () => this.actions.onEditFormula(formula.id, { [field]: input.value }));
            fieldLabel.append(input); editor.append(fieldLabel);
        }
        const remove = this.document.createElement("button"); remove.type = "button"; remove.textContent = "×";
        remove.className = "summary-text-button";
        remove.addEventListener("click", () => this.actions.onRemoveFormula(formula.id));
        row.append(legend, plot, editor, remove);
        return row;
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
