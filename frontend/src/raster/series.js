/** Plot Processing formulas across original raster sources. */
import { rasterSourceReference, rasterSourceKey } from "../raster-source.js";
import { vectorSelectionsEqual } from "../selected-area.js";
import { isCanonicalWgs84Position } from "./geometry.js";
import { getTemporalMonthBoundaries, temporalPeriodError } from "../temporal-period.js";
import { csvParse, csvFormat } from "d3";

const SERIES_STATISTICS = Object.freeze({
    pixel: { label: "Pixel value", expression: "pixelValue(a)" },
    mean: { label: "Mean", expression: "mean(a)" },
    stdev: { label: "Standard deviation", expression: "stdev(a)" },
    min: { label: "Minimum", expression: "min(a)" },
    max: { label: "Maximum", expression: "max(a)" },
    sum: { label: "Sum", expression: "sum(a)" },
    area: { label: "Area above zero", expression: "areaha(a > 0)" },
    count: { label: "Count above 10", expression: "count(a > 10)" },
    "area-threshold": { label: "Area above 10", expression: "areaha(a > 10)" },
    "area-class": { label: "Area in class 4", expression: "areaha(a == 4)" },
    percent: { label: "Percent above 10", expression: "100 * count(a > 10) / count(a)" },
    range: { label: "Range", expression: "max(a) - min(a)" },
    custom: { label: "Custom", expression: "" },
});

/**
 * Encode one CSV field, keeping user-supplied text from becoming a spreadsheet formula.
 * @param {string|number|null} value Text, a measured number, or a missing value.
 * @return {string} Quoted CSV field.
 */
function csvField(value) {
    let text = value == null ? "" : String(value);
    if (typeof value === "string") text = spreadsheetText(text);
    return '"' + text.replaceAll('"', '""') + '"';
}

/** Keep a user-entered CSV label from executing as a spreadsheet formula.
 * @param {string} text User label. @return {string} Literal spreadsheet text.
 */
function spreadsheetText(text) { return /^[=+@\-\t\r\n]/.test(text) ? "'" + text : text; }

/** Own raster choices, formulas and presentation settings for Raster series. */
export class RasterSeriesController {
    /**
     * Connect the plot to Processing calculations and its own view.
     * @param {Object} options Collaborators.
     * @param {import("./series-view.js").RasterSeriesView} options.view Plot controls.
     * @param {import("../processing/raster-series-calculations.js").RasterSeriesCalculations} options.areaStatistics Area formulas and Processing client.
     * @param {()=>void} options.onEditArea Open existing sampling controls.
     * @param {()=>void} options.onClose Request that composition close this tool.
     * @param {(choice:"selection"|"vector"|"whole")=>void} [options.onAreaChoice] Start or cancel polygon selection after an explicit area choice.
     * @param {(source:Object)=>Promise<Object>} options.getTemporalItem Read Catalog metadata for a selected dataset.
     * @param {(item:Object,variable:string,month?:string,signal?:AbortSignal)=>Promise<Object>} options.loadTemporalTimes Read available observations for guidance.
     */
    constructor({ view, onClose, areaStatistics, onEditArea, onAreaChoice = () => {}, getTemporalItem, loadTemporalTimes }) {
        this.view = view;
        Object.assign(this, {getTemporalItem, loadTemporalTimes});
        this.areaStatistics = areaStatistics;
        this.onAreaChoice = onAreaChoice;
        this.areaStatistics.setProgressListener(() => this.render());
        this.formulas = [{ id: 1, ...SERIES_STATISTICS.mean }];
        this.formulaSerial = 1;
        this.areaChoice = "selection";
        this.plots = [{ id: 1, scale: "linear" }];
        this.plotSerial = 1;
        this.statisticDisplay = new Map([[1, { plotId: 1, visible: true, styleIndex: 0 }]]);
        this.selectedArea = null;
        this.selectedAreaLabel = "";
        this.vectorArea = null;
        this.vectorAreaLabel = "";
        this.sources = [];
        this.selectedKeys = new Set();
        /** @type {Map<string, boolean>} Explicit checklist choices for retained rasters. */
        this.selectionOverrides = new Map();
        this.position = null;
        this.active = false;
        this.order = "map";
        this.direction = "forward";
        this.chartType = "line";
        this.sourceMode = "layers";
        this.temporal = {datasets: [], datasetKey: "", item: null, variable: "", periodMode: "month",
            startTime: "", endTime: "", choices: null, loading: false, error: "", datesError: ""};
        view.bind({
            onClose, onEditArea,
            onArea: choice => this.chooseArea(choice),
            onAddFormula: preset => this.addFormula(preset),
            onEditFormula: (id, change) => this.editFormula(id, change),
            onRemoveFormula: id => this.removeFormula(id),
            onStatisticDisplay: (id, change) => this.changeStatisticDisplay(id, change),
            onAddPlot: () => this.addPlot(),
            onRemovePlot: id => this.removePlot(id),
            onPlotScale: (id, scale) => this.setPlotScale(id, scale),
            onCalculate: () => this.calculate(),
            onCancel: () => this.areaStatistics.cancelRemainingRasters(),
            onRecover: () => void this.areaStatistics.retryInterruptedCalculations(),
            onSelect: (key, selected) => this.selectRaster(key, selected),
            onSourceMode: mode => { this.sourceMode = mode; this.updateAreaInputs(); },
            onTemporalDataset: key => void this.chooseTemporalDataset(key),
            onTemporalVariable: variable => {
                this.temporal.variable = variable; this.updateAreaInputs(); void this.loadTemporalDates();
            },
            onTemporalEdit: change => { Object.assign(this.temporal, change); this.updateAreaInputs(); },
            onTemporalMonth: month => void this.loadTemporalDates(month),
            onRefreshTemporal: () => void this.loadTemporalDates(undefined, true),
            onUseTemporalMonth: () => {
                Object.assign(this.temporal, {periodMode: "month", ...getTemporalMonthBoundaries(this.temporal.choices.month)});
                this.updateAreaInputs();
            },
            onOrder: (order, direction) => {
                this.order = order; this.direction = direction; this.render();
            },
            onChartType: type => { this.chartType = type; this.render(); },
            onDownload: () => view.downloadCsv(this.exportCsv()),
        });
        this.render();
    }

    /** Restore the inputs and results of explicitly started calculations after reload.
     * Automatic requests are cancelled by the calculation owner. Recovered inputs
     * remain selected even if their sources are no longer in Map layers.
     * @return {Promise<void>} Saved jobs and any temporal metadata have been retrieved.
     */
    async start() {
        const area = this.areaStatistics;
        const started = area.start();
        if (area.manual) {
            this.formulas = area.formulas.map(formula => ({...formula}));
            this.formulaSerial = Math.max(...this.formulas.map(formula => formula.id));
            this.statisticDisplay = new Map(this.formulas.map((formula, index) =>
                [formula.id, {plotId: 1, visible: true, styleIndex: index}]));
            this.selectedArea = area.area;
            this.selectedAreaLabel = area.areaLabel;
            this.areaChoice = area.area.kind === "wholeRaster" ? "whole" : "selection";
            this.position = area.pixelPoint;
            this.sources = area.sources;
            this.selectedKeys = new Set(area.sources.map(source => source.key));
            this.selectionOverrides = new Map(area.sources.map(source => [source.key, true]));
            if (area.temporalMode) {
                this.sourceMode = "temporal";
                const source = area.temporalSource;
                const dataset = {key: rasterSourceKey({collectionId: source.collectionId, itemId: source.itemId}),
                    ...source, label: source.itemId};
                Object.assign(this.temporal, {datasets: [dataset], datasetKey: dataset.key, variable: source.variable,
                    periodMode: "times", startTime: source.startTime.replace(/Z$/, ""), endTime: source.endTime.replace(/Z$/, "")});
                try { this.temporal.item = await this.getTemporalItem(dataset); }
                catch (error) { this.temporal.error = `Dataset could not be loaded: ${error.message} Refresh to try again.`; }
            }
        }
        await started;
        this.render();
    }

    /** Start the selected calculations explicitly so they continue while this panel is closed.
     * @return {void} Results arrive through the existing progress listener.
     */
    calculate() {
        this.selectionOverrides = new Map(this.sources.map(source => [source.key, this.selectedKeys.has(source.key)]));
        this.updateAreaInputs();
        this.areaStatistics.calculateRemainingRasters();
    }

    /** Select an existing view of an original raster, or add the source when it is not listed.
     * @param {Object} source Labeled original-source descriptor, including hidden sources.
     * @param {Object} [area] Explicit histogram area; omission retains the chosen scope.
     * @param {string|null} [viewKey=null] Originating retained view, when the action came from Map layers or its histogram.
     * @return {void}
     */
    selectSource(source, area, viewKey = null) {
        const sourceKey = rasterSourceKey(source);
        const existing = this.sources.find(item => item.key === viewKey) ??
            this.sources.find(item => rasterSourceKey(item) === sourceKey);
        const key = existing?.key ?? sourceKey;
        if (!existing) this.sources.push({key, source, label: source.label});
        this.sourceMode = "layers";
        this.selectedKeys = new Set([key]);
        this.selectionOverrides = new Map(this.sources.map(item => [item.key, item.key === key]));
        if (area !== undefined) {
            this.areaChoice = area?.kind === "wholeRaster" ? "whole" : "selection";
            this.selectedArea = area;
            this.selectedAreaLabel = "Selected histogram area";
        }
        this.updateAreaInputs();
    }

    /** Accept polygon features without replacing a hidden explicit calculation.
     * @param {Object} info Catalog selection or owned polygon-area reference and display label.
     * @return {void}
     */
    setVectorSamplingArea(info) {
        const keepCalculation = this.areaStatistics.manual && (!this.active || this.hasPendingArea);
        this.vectorArea = info.polygonArea ? {kind: "polygonArea", polygonArea: info.polygonArea}
            : {kind: "catalogSelection", catalogSelection: info.selection};
        this.vectorAreaLabel = info.label;
        this.areaChoice = "vector";
        if (keepCalculation) this.render();
        else this.updateAreaInputs();
    }

    /** Clear stale polygon inputs while the chosen Vector area is being read.
     * Hidden explicit calculations retain their captured inputs.
     * @param {{phase:string}} selection Public selection progress.
     * @return {void}
     */
    setVectorSelectionState(selection) {
        if (this.areaChoice === "vector" && selection.phase === "reading") {
            const keepCalculation = this.areaStatistics.manual && (!this.active || this.hasPendingArea);
            this.vectorArea = null;
            if (keepCalculation) this.render();
            else this.updateAreaInputs();
        }
    }

    /** Release changed polygon inputs, preserving captured work in a hidden panel.
     * Active calculations using the invalidated area are cancelled.
     * @param {Object} area Catalog-selection or polygon-area descriptor being invalidated.
     * @return {void}
     */
    invalidateArea(area) {
        const keepCalculation = this.areaStatistics.manual && (!this.active || this.hasPendingArea);
        /** Compare the invalidated vector input with a captured calculation area.
         * @param {Object|null} candidate Captured area. @return {boolean} Same selection identity.
         */
        const matches = candidate => area.kind === "polygonArea" ? candidate?.polygonArea?.id === area.polygonArea.id
            : vectorSelectionsEqual(candidate?.catalogSelection, area.catalogSelection);
        if (matches(this.vectorArea)) this.vectorArea = null;
        if (matches(this.selectedArea)) this.selectedArea = null;
        if (keepCalculation) this.render();
        else this.updateAreaInputs();
    }

    /**
     * Update available rasters and reconcile their default selections.
     * Untouched sources follow map visibility; explicit checklist choices override
     * that default. Explicit calculations retain their captured inputs through map
     * changes; hidden rasters remain selectable.
     * @param {Object[]} sources Ordered map snapshots with original-source references.
     * @param {Object[]} [datasets=[]] Distinct temporal Catalog identities retained in Map layers.
     * @return {void}
     */
    updateAvailableRasters(sources, datasets = []) {
        if (this.areaStatistics.manual) {
            sources = [...sources, ...this.sources.filter(source => this.selectedKeys.has(source.key) && !sources.some(item => item.key === source.key))];
            datasets = [...datasets, ...this.temporal.datasets.filter(dataset => dataset.key === this.temporal.datasetKey && !datasets.some(item => item.key === dataset.key))];
            for (const source of sources) this.selectionOverrides.set(source.key, this.selectedKeys.has(source.key));
        }
        if (!this.sources.length && !this.temporal.datasets.length && !sources.length && datasets.length) this.sourceMode = "temporal";
        this.temporal.datasets = datasets;
        if (this.temporal.datasetKey && !datasets.some(dataset => dataset.key === this.temporal.datasetKey)) {
            this.temporalAbort?.abort();
            Object.assign(this.temporal, {datasetKey: "", item: null, variable: "", choices: null, loading: false, error: ""});
        }
        const newKeys = new Set(sources.map(source => source.key));
        this.selectionOverrides = new Map([...this.selectionOverrides].filter(([key]) => newKeys.has(key)));
        this.selectedKeys = new Set(sources.filter(source => this.selectionOverrides.get(source.key) ?? source.visible)
            .map(source => source.key));
        this.sources = sources.map(source => ({ ...source }));
        if (this.areaStatistics.manual) this.render();
        else this.updateAreaInputs();
    }

    /** Select one dataset without inheriting the observation displayed on the map.
     * @param {string} key Retained Catalog dataset key, or an empty selection.
     * @return {Promise<void>} Metadata and availability guidance have finished loading.
     */
    async chooseTemporalDataset(key) {
        this.temporalAbort?.abort();
        Object.assign(this.temporal, {datasetKey: key, item: null, variable: "", choices: null, loading: false, error: "", datesError: ""});
        this.updateAreaInputs();
        if (key) await this.loadTemporalDates(undefined, true);
    }

    /** Read Catalog guidance while leaving the requested period unchanged.
     * Superseded selections cancel their availability reads; a failed date listing
     * does not prevent the user from entering a period directly.
     * @param {string} [month] UTC month to browse; omission asks for the latest month.
     * @param {boolean} [reloadItem=false] Whether to reload the dataset's Catalog metadata.
     * @return {Promise<void>} Updated guidance or a displayed read error.
     */
    async loadTemporalDates(month, reloadItem = false) {
        const temporal = this.temporal;
        const source = temporal.datasets.find(dataset => dataset.key === temporal.datasetKey);
        if (!source) return;
        if (reloadItem) this.areaStatistics.discardTemporalResults();
        this.temporalAbort?.abort();
        const abort = this.temporalAbort = new AbortController();
        Object.assign(temporal, {loading: true, error: "", datesError: ""}); this.render();
        try {
            if (reloadItem) {
                const item = await this.getTemporalItem(source);
                if (abort.signal.aborted) return;
                temporal.item = item;
                const variables = Object.keys(item.properties["cube:variables"]);
                if (!temporal.variable && variables.length === 1) temporal.variable = variables[0];
            }
            if (!temporal.variable) { temporal.choices = null; return; }
            try {
                const choices = await this.loadTemporalTimes(temporal.item, temporal.variable, month, abort.signal);
                if (!abort.signal.aborted) temporal.choices = choices;
            } catch (error) {
                if (!abort.signal.aborted) {
                    temporal.choices = null;
                    temporal.datesError = `Available dates could not be loaded: ${error.message} You can still enter a period.`;
                }
            }
        } catch (error) {
            if (!abort.signal.aborted) temporal.error = `Dataset could not be loaded: ${error.message} Refresh to try again.`;
        } finally {
            if (!abort.signal.aborted) { temporal.loading = false; this.updateAreaInputs(); }
        }
    }

    /** Explain incomplete temporal input before enabling Calculate.
     * @return {string} User-facing guidance, or an empty string for a complete selection.
     */
    temporalSelectionError() {
        const temporal = this.temporal;
        if (!temporal.datasetKey) return temporal.datasets.length ? "Choose a temporal dataset." : "Add a temporal dataset from Catalog to Map layers.";
        if (temporal.loading) return "Loading available variables and dates…";
        if (temporal.error) return temporal.error;
        if (!temporal.item?.properties["cube:variables"][temporal.variable]) return "Choose a variable.";
        return temporalPeriodError(temporal);
    }

    /**
     * Remember a completed map click and refresh only while this tool is active.
     * Clicks outside the canonical map world clear the point instead of sending an invalid request.
     * @param {{longitude:number,latitude:number}|null} position Map click in WGS 84 degrees, or a cleared click.
     * @return {void}
     */
    setPosition(position) {
        if (!this.active && this.areaStatistics.manual) return;
        if (this.position?.longitude === position?.longitude && this.position?.latitude === position?.latitude) return;
        this.position = isCanonicalWgs84Position(position) ? Object.freeze({ ...position }) : null;
        this.updateAreaInputs();
    }

    /**
     * Start automatic calculations when shown; keep explicit work running when hidden.
     * Completed values and settings remain available when the panel is reopened.
     * @param {boolean} panelVisible Whether Raster series is the visible, active tool.
     * @return {void}
     */
    updateSamplingForPanelVisibility(panelVisible) {
        if (this.active === panelVisible) return;
        this.active = panelVisible;
        this.areaStatistics.updateCalculationForPanelVisibility(panelVisible);
        this.render();
    }

    /**
     * Include or exclude one raster explicitly and refresh calculations.
     * The choice overrides the map-visibility default while this source is retained.
     * @param {string} key Available raster identity.
     * @param {boolean} selected Whether to include this raster.
     * @return {void}
     */
    selectRaster(key, selected) {
        if (!this.sources.some(source => source.key === key)) return;
        this.selectionOverrides.set(key, selected);
        if (selected) this.selectedKeys.add(key);
        else this.selectedKeys.delete(key);
        this.updateAreaInputs();
    }

    /**
     * Read selected sources in plot order without changing sampling or source identity.
     * @return {{key:string,label:string,item:Object,visible:boolean}[]} Plot sources.
     */
    orderedSources() {
        const sources = this.sources.filter(source => this.selectedKeys.has(source.key));
        if (this.order === "name") sources.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
        if (this.direction === "reverse") sources.reverse();
        return sources;
    }

    /** Accept an exact area from composition; optional outlines never determine availability.
     * @param {Object|null} area Processing sampling descriptor.
     * @param {string} [label="Current sampling area"] Area description. @return {void}
     */
    setArea(area, label = "Current sampling area") {
        const keepCalculation = this.areaStatistics.manual && (!this.active || this.hasPendingArea);
        this.selectedArea = area; this.selectedAreaLabel = label;
        if (keepCalculation) this.render();
        else this.updateAreaInputs();
    }

    /** Read the latest area selected for the next calculation.
     * @return {Object|null} Whole raster, polygon selection, map area, or no selection.
     */
    getSelectedArea() {
        return this.areaChoice === "whole" ? {kind: "wholeRaster"}
            : this.areaChoice === "vector" ? this.vectorArea : this.selectedArea;
    }

    /** Whether a background calculation uses an earlier area than the controls.
     * @return {boolean} Calculate must apply the latest selection before running.
     */
    get hasPendingArea() {
        return this.areaStatistics.manual && JSON.stringify(this.getSelectedArea()) !== JSON.stringify(this.areaStatistics.area);
    }

    /** Supply the area calculator with chosen original sources, independent of chart order. @return {void} */
    updateAreaInputs() {
        const area = this.getSelectedArea();
        const label = this.areaChoice === "vector" ? this.vectorAreaLabel : this.selectedAreaLabel;
        if (this.sourceMode === "temporal") {
            const temporal = this.temporal;
            const source = this.temporalSelectionError() ? null : {collectionId: temporal.item.collection, itemId: temporal.item.id,
                variable: temporal.variable, startTime: new Date(`${temporal.startTime}Z`).toISOString(), endTime: new Date(`${temporal.endTime}Z`).toISOString()};
            this.areaStatistics.updateTemporalInputs(source, area, label, this.formulas, this.position);
            return;
        }
        this.areaStatistics.updateCalculationInputs(this.sources.filter(source => this.selectedKeys.has(source.key)),
            area, label, this.formulas, this.position);
    }

    /** Choose an area source and ask composition to start or cancel polygon selection.
     * Choosing Vector again retries selection without reusing the previous polygons.
     * @param {"selection"|"vector"|"whole"} choice Area source. @return {void}
     */
    chooseArea(choice) {
        this.areaChoice = choice;
        if (choice === "vector") this.vectorArea = null;
        this.onAreaChoice(choice);
        this.updateAreaInputs();
    }

    /** Add one editable formula, up to the backend's five-calculation limit.
     * @param {string} preset Key in SERIES_STATISTICS. @return {void}
     */
    addFormula(preset) {
        if (!SERIES_STATISTICS[preset] || this.formulas.length === 5) return;
        this.formulas.push({ id: ++this.formulaSerial, ...SERIES_STATISTICS[preset] });
        const usedStyles = new Set([...this.statisticDisplay.values()].map(display => display.styleIndex));
        this.statisticDisplay.set(this.formulaSerial, {
            plotId: 1, visible: true, styleIndex: [0, 1, 2, 3, 4].find(index => !usedStyles.has(index)),
        });
        this.updateAreaInputs();
    }

    /** Edit a formula or its display name; names never change calculation identity.
     * @param {number} id Formula identity.
     * @param {{label?:string,expression?:string}} change Editor values. @return {void}
     */
    editFormula(id, change) {
        const formula = this.formulas.find(item => item.id === id);
        if (!formula) return;
        const oldExpression = formula.expression;
        Object.assign(formula, change);
        if (oldExpression !== formula.expression) this.updateAreaInputs();
        else this.render();
    }

    /** Remove a formula while keeping at least one statistic.
     * @param {number} id Formula identity. @return {void}
     */
    removeFormula(id) {
        if (this.formulas.length === 1) return;
        this.formulas = this.formulas.filter(formula => formula.id !== id);
        this.statisticDisplay.delete(id);
        this.updateAreaInputs();
    }

    /** Change only where a statistic is displayed, without requesting calculations.
     * @param {number} id Statistic identity.
     * @param {{visible?:boolean,plotId?:number}} change Visibility or destination plot.
     * @return {void}
     */
    changeStatisticDisplay(id, change) {
        const display = this.statisticDisplay.get(id);
        if (!display || (change.plotId !== undefined && !this.plots.some(plot => plot.id === change.plotId))) return;
        Object.assign(display, change);
        this.render();
    }

    /** Add an empty plot with a linear Y axis; retain all calculation results. @return {void} */
    addPlot() {
        this.plots.push({ id: ++this.plotSerial, scale: "linear" });
        this.render();
    }

    /** Remove a secondary plot and move its statistics to Plot 1.
     * @param {number} id Plot identity; Plot 1 cannot be removed. @return {void}
     */
    removePlot(id) {
        if (id === 1) return;
        this.plots = this.plots.filter(plot => plot.id !== id);
        for (const display of this.statisticDisplay.values()) if (display.plotId === id) display.plotId = 1;
        this.render();
    }

    /** Change a plot's Y scale without changing its data or other plots.
     * @param {number} id Plot identity.
     * @param {"linear"|"log"} scale Axis scale. @return {void}
     */
    setPlotScale(id, scale) {
        const plot = this.plots.find(item => item.id === id);
        if (!plot || !["linear", "log"].includes(scale)) return;
        plot.scale = scale;
        this.render();
    }

    /** Present every statistic, keeping previous-area plots separate from current results. @return {void} */
    render() {
        const area = this.areaStatistics;
        if (this.sourceMode === "temporal") { this.renderTemporalResults(); return; }
        const sources = this.orderedSources();
        /** Join one result set to plot order without mixing current and previous areas.
         * @param {Map<string,Object>} results Per-source calculation outcomes.
         * @param {{id:number,label:string,expression:string}} formula Statistic to match.
         * @return {Object[]} Ordered chart/table rows.
         */
        const rowsFor = (results, formula) => sources.map(source => {
            const result = results.get(source.key);
            const row = result?.job?.result?.rows.find(row => row.label === "stat-" + formula.id);
            const sameFormula = result?.calculationInputs.calculations.some(item => item.label === "stat-" + formula.id && item.expression === formula.expression.trim());
            return { key: source.key, label: source.label, statisticId: formula.id, statisticLabel: formula.label || formula.expression || "Custom statistic",
                state: row?.state === "ok" && sameFormula ? "value" : result?.error ? "error" : sameFormula ? row?.state ?? "waiting" : "waiting",
                value: !sameFormula || row?.value == null ? null : Number(row.value), rawValue: sameFormula ? row?.value : null, unit: row?.unit ?? "",
                errorMessage: area.commonError ? "Not calculated. See the message above." : result?.error ?? area.progress.get(source.key)?.message ?? (!result ? "Waiting" : ""), cached: !!result?.job?.result?.cacheHit };
        });
        const statistics = this.formulas.map(formula => ({ ...formula, ...this.statisticDisplay.get(formula.id), rows: rowsFor(area.results, formula) }));
        const rows = sources.flatMap((source, index) => statistics.map(statistic => statistic.rows[index]));
        const showingPrevious = !!(area.busy && !rows.some(row => row.state === "value") && area.previousResults);
        for (const statistic of statistics) statistic.previousRows = showingPrevious ? rowsFor(area.previousResults, statistic) : null;
        this.view.render({
            active: this.active, area: { formulas: this.formulas, sources: area.sources, areaChoice: this.areaChoice,
                area: this.getSelectedArea(), areaLabel: this.areaChoice === "vector" ? this.vectorAreaLabel : this.selectedAreaLabel,
                results: area.results, complete: area.complete, pendingArea: this.hasPendingArea,
                recoverable: area.needsRecovery, hasErrors: area.hasErrors }, statistics, plots: this.plots,
            sources: this.sources.map(source => ({ ...source, selected: this.selectedKeys.has(source.key) })),
            rows, previousRows: showingPrevious ? statistics.flatMap(statistic => statistic.previousRows) : null,
            showingPrevious, busy: area.busy, chartType: this.chartType,
            message: area.results.size + " of " + sources.length + " rasters complete. " + area.message +
                (this.hasPendingArea ? " Results use the previous selection. Calculate to update." : ""),
            canDownload: area.results.size > 0 && !area.busy,
        });
    }

    /** Present saved temporal values through the same statistic, chart and table contract.
     * Plot-only edits never resubmit a calculation or reread its source rasters.
     * @return {void}
     */
    renderTemporalResults() {
        const area = this.areaStatistics, result = area.temporalResult;
        const observations = result?.observations ?? [];
        const statistics = this.formulas.map(formula => ({...formula, ...this.statisticDisplay.get(formula.id), previousRows: null,
            rows: observations.map(({time, rows}) => {
                const row = rows.find(value => value.label === "stat-" + formula.id);
                return {key: time, xValue: Date.parse(time), label: new Date(time).toISOString().replace("T", " ").replace(/(\.000)?Z$/, " UTC"),
                    statisticId: formula.id, statisticLabel: formula.label || formula.expression, state: row.state === "ok" ? "value" : row.state,
                    value: row.value === null ? null : Number(row.value), rawValue: row.value, unit: row.unit ?? ""};
            })}));
        this.view.render({active: this.active, temporal: {...this.temporal, selectionError: this.temporalSelectionError()},
            area: {formulas: this.formulas, sources: [], areaChoice: this.areaChoice, area: this.getSelectedArea(),
                areaLabel: this.areaChoice === "vector" ? this.vectorAreaLabel : this.selectedAreaLabel, pendingArea: this.hasPendingArea,
                results: area.results, complete: area.complete, recoverable: area.needsRecovery, hasErrors: area.hasErrors},
            statistics, plots: this.plots, sources: [], rows: observations.flatMap((_, index) => statistics.map(statistic => statistic.rows[index])),
            previousRows: null, showingPrevious: false, busy: area.busy, chartType: this.chartType,
            message: (this.temporalSelectionError() || area.message) +
                (this.hasPendingArea ? " Results use the previous selection. Calculate to update." : ""),
            canDownload: !!result && !area.busy});
    }

    /** Export every statistic with its exact scalar text, unit, source and area provenance.
     * @return {string} CSV document, or an empty string before results are available.
     */
    exportCsv() {
        const area = this.areaStatistics;
        if (this.sourceMode === "temporal") {
            if (area.busy || !area.temporalResult) return "";
            const rows = csvParse(area.temporalResult.csv);
            const labels = new Map(this.formulas.map(formula => ["stat-" + formula.id, formula.label || formula.expression]));
            for (const row of rows) row.calculation = spreadsheetText(labels.get(row.calculation));
            return csvFormat(rows) + "\r\n";
        }
        if (area.busy || !area.results.size) return "";
        const lines = [["raster", "collection_id", "item_id", "statistic", "formula", "value", "unit", "status", "error", "area", "job_id", "cached", "pixel_point", "source"]];
        for (const source of this.orderedSources()) {
            const result = area.results.get(source.key);
            const reference = rasterSourceReference(source);
            for (const formula of this.formulas) {
                const row = result?.job?.result?.rows.find(row => row.label === "stat-" + formula.id);
                // Values are validated decimal strings from Processing, not user text.
                const scalar = row?.value == null ? "" : { scalar: row.value };
                lines.push([source.label, reference.collectionId ?? "", reference.itemId ?? "", formula.label, formula.expression,
                    scalar, row?.unit ?? "", row?.state ?? (result?.error ? "error" : "waiting"), result?.error ?? "",
                    JSON.stringify(result?.calculationInputs.area ?? (this.areaChoice === "whole" ? {kind:"wholeRaster"} : area.area)),
                    result?.job?.jobId ?? "", result?.job?.result?.cacheHit ? "true" : "false",
                    result?.calculationInputs.pixelPoint ? JSON.stringify(result.calculationInputs.pixelPoint) : "", JSON.stringify(reference)]);
            }
        }
        return lines.map(line => line.map(value => typeof value === "object" && value !== null ? '"' + value.scalar + '"' : csvField(value)).join(",")).join("\r\n") + "\r\n";
    }

}
