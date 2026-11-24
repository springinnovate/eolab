/** Controls and chart presentation for raster formula series. */
import { formatSeriesNumber } from "../charts/series-chart.js";
import { createStatisticSwatch, RasterSeriesPlotsView, STATISTIC_STYLES } from "./series-plots-view.js";
import { TemporalPeriodView } from "../temporal-period-view.js";
import { describeTemporalPeriod } from "../temporal-period.js";

const STATES = { waiting: "Waiting", error: "Unavailable", no_matches: "No matches", no_valid_data: "No valid data", invalid_arithmetic: "Invalid arithmetic", overflow: "Overflow" };

/** Update a result caption only when its displayed text changes.
 * @param {HTMLElement} element Caption or control. @param {string} text Display text. @return {void}
 */
function setCaption(element, text) {
    if (element.textContent !== text) element.textContent = text;
}

/**
 * @typedef {Object} SeriesValueRow
 * @property {string} label Full raster name.
 * @property {number} [xValue] UTC timestamp in milliseconds for a temporal observation.
 * @property {string|null} [method] Precision of a sampling-box mean.
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
 * @property {import("../sampling-box-statistics.js").BoxStatistic} [preview] Built-in statistic eligible for a box preview.
 * @property {boolean} visible Whether to plot the statistic.
 * @property {number} plotId Assigned plot identity.
 * @property {number} styleIndex Stable line/marker identity.
 * @property {string} [color] User-selected CSS hex color; absent uses its default statistic style.
 * @property {SeriesValueRow[]} rows One row per requested raster or returned temporal observation, including unavailable values.
 * @property {SeriesValueRow[]|null} previousRows Retained values for replacement calculations.
 */

/**
 * @typedef {Object} SeriesPlot
 * @property {number} id Stable identity for assignments, settings and retained controls.
 * @property {number} displayNumber Plot number shown in the UI.
 * @property {"linear"|"log"} scale Y-axis scale.
 * @property {[number,number]|null} bounds Custom Y bounds, or null for automatic bounds.
 * @property {[number,number]|null} xBounds Custom UTC bounds, or null for automatic bounds.
 * @property {number} [pointSize] Point size in pixels.
 * @property {number} [xTickCount] Requested X-axis tick count.
 * @property {number} [yTickCount] Requested Y-axis tick count.
 * @property {number} [axisFontSize] Axis font size in pixels.
 */

/**
 * @typedef {Object} SeriesPresentation
 * @property {boolean} active Whether the panel is open.
 * @property {{key:string,label:string,selected:boolean,hasSnapshot?:boolean,temporalDatasetKey?:string,rangeSelected?:boolean}[]} sources Named snapshot choices and temporal-range actions.
 * @property {SeriesValueRow[]} rows Current ordered values for the table.
 * @property {SeriesValueRow[]|null} previousRows Retained values for pending replacements.
 * @property {string} message Progress, guidance or result summary.
 * @property {boolean} busy Whether calculations are running.
 * @property {{completed?:number|null,total?:number|null,unit?:string|null}|null} [workProgress] Measured temporal work; absent before the server reports counts.
 * @property {"line"|"scatter"|"bar"} chartType Plot geometry.
 * @property {boolean} canDownload Whether current values can be exported.
 * @property {{formulas:SeriesStatistic[],sources:object[],areaChoice:string,area:object|null,areaLabel:string,hasPendingVectorArea:boolean,canCalculateExactStatistics?:boolean,hasErrors:boolean,recoverable:boolean}} area Selected scope and retry/recovery availability.
 * @property {SeriesStatistic[]} statistics Statistic presentation.
 * @property {SeriesPlot[]} plots Display numbers and settings in plot order.
 * @property {"forward"|"reverse"} direction Display direction; temporal data and CSV retain observation order.
 * @property {boolean} showingPrevious Whether plots use retained results.
 * @property {{longitude:number,latitude:number}|null} [pixelPoint] Captured point for pixel statistics.
 * @property {number[]|null} [resultBounds] Geographic extent of the result source when supplied.
 * @property {Object|null} [temporal] Dataset, variable and period controls; absent for ordinary raster layers.
 */

/** Display Raster series without accessing map, renderer or request state. */
export class RasterSeriesView {
    /**
     * Find the plot's existing markup.
     * @param {Document} [documentContext=document] Owning browser document.
     * @param {Object} [options] Presentation callbacks.
     * @param {(context:{source:string,scope:string,usesSamplingBox:boolean})=>void} [options.onContextChange] Display-only source, area and box-control context.
     * @param {import("./series-locator.js").RasterResultLocator} [options.locator] Optional geographic thumbnail for a single result.
     */
    constructor(documentContext = document, { onContextChange = () => {}, locator } = {}) {
        this.document = documentContext;
        this.onContextChange = onContextChange;
        this.locator = locator;
        this.root = documentContext.querySelector("#raster-series");
        this.status = documentContext.querySelector("#raster-series-status");
        this.sources = documentContext.querySelector("#raster-series-sources");
        this.sourceSummary = documentContext.querySelector("#raster-series-source-summary");
        this.results = documentContext.querySelector("#raster-series-results");
        this.plots = documentContext.querySelector("#raster-series-plots");
        this.plotArea = documentContext.querySelector("#raster-series-plot-area");
        this.plotHeading = documentContext.querySelector("#raster-series-plot-heading");
        this.plotTitle = documentContext.querySelector("#raster-series-plot-title");
        this.plotContext = documentContext.querySelector("#raster-series-plot-context");
        this.plotProgress = documentContext.querySelector("#raster-series-plot-progress");
        this.plotProgressDetail = documentContext.querySelector("#raster-series-plot-progress-detail");
        this.plotProgressBar = documentContext.querySelector("#raster-series-plot-progress-bar");
        this.addPlot = documentContext.querySelector("#raster-series-add-plot");
        this.chartToolbar = documentContext.querySelector("#raster-series-chart-toolbar");
        this.chartSettings = documentContext.querySelector("#raster-series-data-settings");
        this.chartNote = documentContext.querySelector("#raster-series-chart-note");
        this.table = documentContext.querySelector("#raster-series-table-body");
        this.values = documentContext.querySelector("#raster-series-values");
        this.valueCaption = documentContext.querySelector("#raster-series-value-caption");
        this.download = documentContext.querySelector("#raster-series-download");
        this.sourceSignature = null;
        this.areaChoices = ["selection", "whole", "vector"].map(choice => [choice, documentContext.querySelector("#raster-series-area-" + choice)]);
        this.formulaRows = documentContext.querySelector("#raster-series-formulas");
        /** @type {Map<number, HTMLDivElement>} Retained editor nodes owned by this view. */
        this.formulaNodes = new Map();
        this.frame = null;
        this.pendingState = null;
        this.valuesSelected = false;
        this.resultButton = documentContext.querySelector("#raster-series-result-button");
        this.valuesButton = documentContext.querySelector("#raster-series-values-button");
        this.reading = documentContext.querySelector("#raster-series-reading");
        this.measureChoice = documentContext.querySelector("#raster-series-selected-statistic");
        for (const [button, showValues] of [[this.resultButton, false], [this.valuesButton, true]]) {
            button.addEventListener("click", () => {
                this.valuesSelected = showValues;
                if (this.snapshot?.active) this.draw(this.snapshot);
            });
        }
        this.measureChoice.addEventListener("change", () => {
            this.selectedStatisticId = Number(this.measureChoice.value);
            if (this.snapshot?.active) this.draw(this.snapshot);
        });
        this.resizeObserver = new this.document.defaultView.ResizeObserver(entries => {
            const width = entries[0].contentRect.width;
            if (width === this.width) return;
            this.width = width;
            if (this.snapshot) this.render(this.snapshot);
        });
        this.resizeObserver.observe(this.root);
    }

    /** Update both entry points that create a new map box for the series.
     * @param {boolean} available Whether the viewer can choose a map sampling box.
     * @return {void}
     */
    setMapSamplingBoxAvailable(available) {
        this.document.querySelector("#raster-series-area-selection").disabled = !available;
        this.document.querySelector("#raster-series-pick-selection").disabled = !available;
    }

    /**
     * Connect controls to the series owner.
     * @param {Object} actions User actions.
     * @param {()=>void} actions.onClose Close the plot.
     * @param {(key:string,selected:boolean)=>void} actions.onSelect Change a raster choice.
     * @param {(order:string,direction:string)=>void} actions.onOrder Change plot order.
     * @param {(type:string)=>void} actions.onChartType Change line/scatter presentation.
     * @param {()=>void} actions.onDownload Download the current values.
     * @param {(choice:string)=>void} actions.onArea Sampling box, whole raster or polygons.
     * @param {()=>void} actions.onOpenArea Open the floating Sample area tool.
     * @param {(preset:string)=>void} actions.onAddFormula Add statistic.
     * @param {(id:number,change:{label?:string,expression?:string,threshold?:number})=>void} actions.onEditFormula Update formula, threshold or display name.
     * @param {(id:number)=>void} actions.onRemoveFormula Remove statistic.
     * @param {(id:number,change:{visible?:boolean,plotId?:number,color?:string})=>void} actions.onStatisticDisplay Change visibility or plot assignment.
     * @param {()=>void} actions.onAddPlot Add a linear plot.
     * @param {(id:number)=>void} actions.onRemovePlot Remove a secondary plot.
     * @param {(id:number,change:Object)=>void} actions.onPlotOptions Change one plot's validated axes, point size and font settings.
     * @param {()=>void} actions.onExactStatistics Calculate the selected statistics from native pixels in the displayed box.
     * @param {()=>void} actions.onRetry Retry failed sources.
     * @param {()=>void} actions.onCancel Cancel remaining work.
     * @param {()=>void} actions.onRecover Recover uncertain submission.
     * @param {(key:string|null)=>void} actions.onTimeRange Choose a named view or dataset's time range; null restores individual raster choices.
     * @param {(variable:string)=>void} actions.onTemporalVariable Choose its variable.
     * @param {(change:Object)=>void} actions.onTemporalEdit Edit UTC period boundaries.
     * @return {void}
     */
    bind(actions) {
        this.actions = actions;
        this.plotsView = new RasterSeriesPlotsView(this.document, actions);
        const sourceButton = this.document.querySelector("#raster-series-source-button");
        const areaButton = this.document.querySelector("#raster-series-open-area");
        const pickers = [[sourceButton, this.document.querySelector("#raster-series-data-inputs")],
            [areaButton, this.document.querySelector("#raster-series-area-picker")]];
        /** Open one context picker or close both, optionally returning focus to its trigger.
         * @param {HTMLElement|null} button Trigger to expand. @param {boolean} [restoreFocus] Return focus when closing. @return {void}
         */
        const openPicker = (button, restoreFocus = false) => {
            for (const [trigger, panel] of pickers) {
                if (restoreFocus && !panel.hidden) trigger.focus({preventScroll: true});
                panel.hidden = button !== trigger;
                trigger.setAttribute("aria-expanded", String(!panel.hidden));
            }
        };
        for (const [trigger, panel] of pickers) {
            trigger.addEventListener("click", () => openPicker(panel.hidden ? trigger : null));
        }
        this.root.addEventListener("keydown", event => {
            if (event.key === "Escape" && pickers.some(([, panel]) => !panel.hidden)) {
                event.preventDefault(); event.stopPropagation(); openPicker(null, true);
            }
        });
        this.document.querySelector("#raster-series-sources-done").addEventListener("click", () => openPicker(null, true));
        for (const [choice] of this.areaChoices) {
            const pick = this.document.querySelector("#raster-series-pick-" + choice);
            pick.addEventListener("click", () => {
                if (pick.disabled) return;
                openPicker(null, true);
                if (choice === this.snapshot.area.areaChoice && this.snapshot.area.area) return;
                actions.onArea(choice);
                if (choice === "vector" || (choice === "selection" && !this.snapshot.area.area)) actions.onOpenArea();
            });
        }
        this.document.querySelector("#raster-series-adjust-area").addEventListener("click", () => {
            openPicker(null, true); actions.onOpenArea();
        });
        this.document.querySelector("#raster-series-temporal-variable").addEventListener("change", event => actions.onTemporalVariable(event.target.value));
        /** Create a text-only period control element.
         * @param {string} tag HTML tag. @param {string} [text=""] Caption.
         * @param {string} [className=""] CSS class. @return {HTMLElement}
         */
        const element = (tag, text = "", className = "") => {
            const node = this.document.createElement(tag); node.textContent = text; node.className = className; return node;
        };
        /** Associate a caption with one native period field.
         * @param {string} id Unique field ID. @param {string} caption Readable label.
         * @param {HTMLElement} input Native control. @return {HTMLLabelElement}
         */
        const field = (id, caption, input) => {
            input.id = id; const label = element("label", caption); label.htmlFor = id; label.append(input); return label;
        };
        this.period = new TemporalPeriodView({element, field,
            options: (select, choices, value) => this.setOptions(select, choices, value)},
        {onEdit: actions.onTemporalEdit, idPrefix: "raster-series-period", describedBy: "raster-series-status"});
        this.document.querySelector("#raster-series-period").append(this.period.root);
        this.document.querySelector("#close-raster-series").addEventListener("click", actions.onClose);
        const order = this.document.querySelector("#raster-series-order");
        const direction = this.document.querySelector("#raster-series-direction");
        for (const input of [order, direction]) input.addEventListener("change", () => actions.onOrder(order.value, direction.value));
        this.document.querySelector("#raster-series-chart-type").addEventListener("change", event => actions.onChartType(event.target.value));
        this.download.addEventListener("click", actions.onDownload);
        this.document.querySelector("#raster-series-use-current-filter").addEventListener("click", () => {
            if (this.snapshot.area.areaChoice === "vector") {
                actions.onArea("vector");
                this.document.querySelector("#raster-series-open-area").focus({preventScroll: true});
            } else actions.onOpenArea();
        });
        for (const [choice, input] of this.areaChoices) {
            input.addEventListener("change", () => { if (input.checked) actions.onArea(choice); });
        }
        this.document.querySelector("#raster-series-add-formula").addEventListener("change", event => {
            actions.onAddFormula(event.target.value); event.target.value = "";
        });
        this.document.querySelector("#raster-series-write-formula").addEventListener("click", () => {
            this.focusNewFormula = true;
            actions.onAddFormula("custom");
        });
        this.document.querySelector("#raster-series-add-plot").addEventListener("click", actions.onAddPlot);
        for (const [id, action] of [["retry", actions.onRetry], ["exact-statistics", actions.onExactStatistics],
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
        this.snapshot = state;
        const sources = state.sources.filter(source => source.selected);
        this.onContextChange({ source: state.temporal ? state.temporal.item?.properties.title || "Temporal dataset" : sources.length === 1 ? sources[0].label : `${sources.length} selected rasters`,
            scope: state.area.areaChoice === "whole" ? "Whole raster" : state.area.areaLabel || "No sample area selected",
            usesSamplingBox: state.area.areaChoice === "selection" && !["catalogSelection", "polygonArea"].includes(state.area.area?.kind) });
        this.pendingState = state;
        if (!state.active) {
            this.locator?.render(null, "");
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
     * One result position shows a scalar and its geographic context. Pending
     * temporal calculations open the plot area with measured progress; completed failures
     * and NoData remain available in the values table without an empty chart.
     * Pending raster comparisons can set up plots before numeric values arrive.
     * Previous-area values remain plotted while replacements are calculated.
     * Source columns keep individual checkmarks visible but disabled during time-range analysis.
     * @param {SeriesPresentation} state Latest presentation supplied to render().
     * @return {void}
     */
    draw(state) {
        const resultPositions = state.statistics[0].rows.length;
        const singleResult = resultPositions === 1;
        if (this.singleResult !== singleResult) {
            this.singleResult = singleResult;
            this.root.classList.toggle("raster-series-single-result", singleResult);
            this.valuesSelected = false;
        }
        const valueCaption = singleResult ? state.statistics[0].rows[0].label : "";
        if (this.valueCaption.textContent !== valueCaption) this.valueCaption.textContent = valueCaption;
        this.renderAreaControls(state);
        this.renderTemporalControls(state.temporal);
        if (this.status.textContent !== state.message) this.status.textContent = state.message;
        const busy = String(state.busy);
        if (this.root.getAttribute("aria-busy") !== busy) this.root.setAttribute("aria-busy", busy);
        const timeRange = Boolean(state.temporal);
        const signature = JSON.stringify([timeRange, state.sources.map(({ key, label, selected, hasSnapshot, temporalDatasetKey, rangeSelected }) =>
            [key, label, selected, hasSnapshot, temporalDatasetKey, rangeSelected])]);
        if (signature !== this.sourceSignature) {
            this.sourceSignature = signature;
            const focusedKey = this.document.activeElement?.dataset?.rasterKey;
            const focusedChoice = this.document.activeElement?.dataset?.sourceChoice;
            const hasTemporal = state.sources.some(source => source.temporalDatasetKey);
            const explanation = "Turn off time-range analysis to select individual rasters.";
            this.sources.classList.toggle("raster-series-source-columns", hasTemporal);
            this.sources.replaceChildren();
            if (hasTemporal) {
                const headings = this.document.createElement("div"); headings.className = "raster-series-source-headings";
                for (const caption of ["Include in raster statistics", "Analyze a time range"]) {
                    const heading = this.document.createElement("span"); heading.textContent = caption; headings.append(heading);
                }
                headings.children[0].setAttribute("aria-disabled", String(timeRange));
                headings.children[0].title = timeRange ? explanation : "";
                this.sources.append(headings);
            }
            this.sources.append(...state.sources.map(source => {
                const row = this.document.createElement("div"); row.className = "raster-series-source";
                const label = this.document.createElement(source.hasSnapshot === false ? "span" : "label");
                label.className = "raster-series-source-name";
                label.setAttribute("aria-disabled", String(timeRange)); label.title = timeRange ? explanation : "";
                const name = this.document.createElement("span"); name.textContent = source.label;
                if (source.hasSnapshot !== false) {
                    const checkbox = this.document.createElement("input");
                    checkbox.type = "checkbox"; checkbox.checked = source.selected; checkbox.disabled = timeRange;
                    checkbox.dataset.rasterKey = source.key; checkbox.dataset.sourceChoice = "raster";
                    checkbox.setAttribute("aria-label", `Include ${source.label} in raster statistics`);
                    if (timeRange) checkbox.setAttribute("aria-describedby", "raster-series-source-help");
                    checkbox.addEventListener("change", () => this.actions.onSelect(source.key, checkbox.checked));
                    label.append(checkbox);
                }
                label.append(name); row.append(label);
                if (source.temporalDatasetKey) {
                    const choice = this.document.createElement("label"); choice.className = "raster-series-range-choice";
                    const range = this.document.createElement("input"); range.type = "checkbox"; range.checked = source.rangeSelected;
                    range.dataset.rasterKey = source.key; range.dataset.sourceChoice = "range";
                    range.setAttribute("aria-label", `Analyze a time range for ${source.label}`);
                    if (timeRange) range.setAttribute("aria-describedby", "raster-series-source-help");
                    range.addEventListener("change", () => this.actions.onTimeRange(range.checked ? source.key : null));
                    choice.append(range); row.append(choice);
                }
                return row;
            }));
            if (timeRange) {
                const help = this.document.createElement("p"); help.id = "raster-series-source-help";
                help.className = "visually-hidden"; help.textContent = explanation; this.sources.append(help);
            }
            if (focusedKey) {
                for (const input of this.sources.querySelectorAll("input")) {
                    if (input.dataset.rasterKey === focusedKey && input.dataset.sourceChoice === focusedChoice) input.focus({ preventScroll: true });
                }
            }
        }
        const showingPrevious = state.showingPrevious && !singleResult;
        const hasPlotValues = state.statistics.some(statistic =>
            (showingPrevious ? statistic.previousRows : statistic.rows).some(row => row.state === "value"));
        const hasResultRows = state.rows.some(row => row.state !== "waiting");
        const calculating = this.renderCalculationProgress(state);
        const hidePlots = this.valuesSelected || singleResult || !hasPlotValues;
        const preparingComparison = !hasPlotValues && !timeRange && state.busy &&
            Boolean(state.area.area) && resultPositions > 1;
        const noObservations = timeRange && !state.busy && state.canDownload && !resultPositions;
        const hideResults = !hasPlotValues && !hasResultRows && !calculating && !preparingComparison && !noObservations;
        if (this.results.hidden !== hideResults) this.results.hidden = hideResults;
        if (this.plots.hidden !== hidePlots) this.plots.hidden = hidePlots;
        const hideAddPlot = singleResult || (!hasPlotValues && !preparingComparison);
        if (this.addPlot.hidden !== hideAddPlot) this.addPlot.hidden = hideAddPlot;
        const hideToolbar = hideAddPlot && !calculating;
        if (this.chartToolbar.hidden !== hideToolbar) this.chartToolbar.hidden = hideToolbar;
        const hideHeading = this.valuesSelected || (hidePlots && !calculating);
        if (this.plotHeading.hidden !== hideHeading) this.plotHeading.hidden = hideHeading;
        const contextualHeading = Boolean(state.temporal || showingPrevious);
        if (this.plotHeading.classList.contains("visually-hidden") === contextualHeading) {
            this.plotHeading.classList.toggle("visually-hidden", !contextualHeading);
        }
        this.renderPlotHeading(state);
        const hideValues = !this.valuesSelected || !state.rows.length;
        if (this.values.hidden !== hideValues) this.values.hidden = hideValues;
        const hideSettings = singleResult || (!hasPlotValues && !preparingComparison);
        if (this.chartSettings.hidden !== hideSettings) this.chartSettings.hidden = hideSettings;
        const retainedPlot = showingPrevious && !this.valuesSelected;
        if (this.chartNote.hidden !== !retainedPlot) this.chartNote.hidden = !retainedPlot;
        const chartNote = retainedPlot ? "Previous results — calculating replacements." : "";
        if (this.chartNote.textContent !== chartNote) this.chartNote.textContent = chartNote;
        const pendingPlot = !hidePlots && this.plotsView.renderPlots(state);
        if (this.plotProgress.classList.contains("is-summary") !== Boolean(pendingPlot)) {
            this.plotProgress.classList.toggle("is-summary", Boolean(pendingPlot));
        }
        this.renderResult(state, singleResult, hasPlotValues, noObservations);
        this.renderValuesTable(state.rows);
        if (this.download.disabled !== !state.canDownload) this.download.disabled = !state.canDownload;
    }

    /** Show the statistic, source, precision and optional location for the selected result.
     * Geometry and result-view choices never submit a calculation.
     * @param {SeriesPresentation} state Current presentation.
     * @param {boolean} single One requested raster or returned observation.
     * @param {boolean} hasPlotValues At least one numerical value is available.
     * @param {boolean} noObservations A completed temporal period returned no rows.
     * @return {void}
     */
    renderResult(state, single, hasPlotValues, noObservations) {
        /** @param {string} id Result element's ID suffix. @return {HTMLElement} Mounted result element. */
        const find = id => this.document.querySelector("#raster-series-" + id);
        const statistic = state.statistics.find(item => item.id === this.selectedStatisticId) ?? state.statistics[0];
        const selected = state.sources.filter(source => source.selected);
        const source = state.temporal ? state.temporal.item?.properties.title || "Temporal dataset"
            : selected.length === 1 ? selected[0].label : selected.length ? selected.length + " rasters" : "Choose rasters";
        setCaption(this.sourceSummary, source);
        const name = statistic.label || statistic.expression || "Custom statistic";
        const variable = state.temporal?.item?.properties["cube:variables"]?.[state.temporal.variable];
        const measure = single || state.statistics.length === 1 ? name : "Selected statistics";
        setCaption(find("measure"), single && variable ? measure + " · " + (variable.description || state.temporal.variable) : measure);
        const chooseMeasure = single && !this.valuesSelected && state.statistics.length > 1;
        const choice = find("measure-choice");
        if (choice.hidden === chooseMeasure) choice.hidden = !chooseMeasure;
        if (chooseMeasure) this.setOptions(this.measureChoice, state.statistics.map(item => ({
            value: String(item.id), label: item.label || item.expression || "Custom statistic"
        })), String(statistic.id));
        const row = single && statistic.rows[0];
        const showReading = Boolean(row && !this.valuesSelected && row.state !== "waiting");
        if (this.reading.hidden === showReading) this.reading.hidden = !showReading;
        if (showReading) {
            const number = row.state === "value" ? formatSeriesNumber(row.value) : row.errorMessage || STATES[row.state];
            setCaption(find("number"), number);
            setCaption(find("unit"), row.state === "value" ? row.unit || "" : "");
            setCaption(find("method"), ({estimated: "Estimated", exact: "Exact"})[row.method] || "");
            setCaption(find("observation"), state.temporal ? row.label : "");
            if (this.reading.classList.contains("is-message") !== (row.state !== "value")) {
                this.reading.classList.toggle("is-message", row.state !== "value");
            }
        }
        const exact = find("exact-statistics");
        const exactContainer = showReading && row.method && row.method !== "exact" ? find("precision") : find("run-actions");
        if (exact.parentElement !== exactContainer) exactContainer.append(exact);
        this.locator?.render(showReading ? state : null, statistic.expression);
        setCaption(this.resultButton, single ? "Result" : "Plot");
        for (const [button, pressed] of [[this.resultButton, !this.valuesSelected], [this.valuesButton, this.valuesSelected]]) {
            if (button.getAttribute("aria-pressed") !== String(pressed)) button.setAttribute("aria-pressed", String(pressed));
        }
        const empty = noObservations ? "No observations in this period."
            : !single && !hasPlotValues && !state.busy && state.rows.length && !this.valuesSelected
                ? "No values to plot. Open Values for each result." : "";
        setCaption(find("empty"), empty);
        if (find("empty").hidden !== !empty) find("empty").hidden = !empty;
    }

    /** Populate Values on demand, including every row received since it was last displayed.
     * @param {SeriesValueRow[]} rows Latest ordered result values.
     * @return {void}
     */
    renderValuesTable(rows) {
        if (!this.valuesSelected) return;
        const showStatus = rows.some(row => row.state !== "value" || row.errorMessage || row.cached);
        if (this.values.classList.contains("has-status") !== showStatus) this.values.classList.toggle("has-status", showStatus);
        const tableValues = rows.map(row => [row.label, row.statisticLabel,
            row.state === "value" ? (row.rawValue ?? formatSeriesNumber(row.value)) + (row.unit ? " " + row.unit : "") : "-",
            row.errorMessage || (row.state === "value" ? (row.cached ? "Cached" : "Value") : STATES[row.state])]);
        const tableSignature = JSON.stringify(tableValues);
        if (this.tableSignature !== tableSignature) {
            this.tableSignature = tableSignature;
            this.table.replaceChildren();
            for (const values of tableValues) {
                const tr = this.document.createElement("tr");
                for (const value of values) {
                    const cell = this.document.createElement("td"); cell.textContent = value; tr.append(cell);
                }
                this.table.append(tr);
            }
        }
    }

    /** Identify the plotted source, sample area and period beside its legend.
     * Retained previous results keep their last heading while replacements run.
     * Inputs disclosure state never changes this context or starts a calculation.
     * @param {SeriesPresentation} state Current source choices and result ownership.
     * @return {void}
     */
    renderPlotHeading(state) {
        if (state.showingPrevious) {
            if (!this.plotTitle.textContent) this.plotTitle.textContent = "Previous results";
            return;
        }
        const selected = state.sources.filter(source => source.selected);
        const variable = state.temporal?.item?.properties["cube:variables"][state.temporal.variable];
        const title = state.temporal ? variable?.description || state.temporal.variable || "Temporal dataset"
            : selected.length === 1 ? selected[0].label : "Raster comparison";
        const scope = state.area.areaChoice === "whole" ? "Whole raster" : state.area.areaLabel || "No sample area selected";
        const context = state.temporal ? [state.temporal.item?.properties.title, scope, describeTemporalPeriod(state.temporal)].filter(Boolean).join(" · ") : scope;
        if (this.plotTitle.textContent !== title) this.plotTitle.textContent = title;
        if (this.plotContext.textContent !== context) this.plotContext.textContent = context;
    }

    /** Show prominent temporal progress in the plot area without redrawing retained charts.
     * Preparation remains indeterminate until the server supplies measured work.
     * Counts retain the server's unit; block counts are not relabelled as points or used to guess an ETA.
     * @param {SeriesPresentation} state Current calculation and measured progress.
     * @return {boolean} Whether the plot area is displaying an active temporal calculation.
     */
    renderCalculationProgress(state) {
        const calculating = Boolean(state.temporal && state.busy && state.area.area && !state.temporal.selectionError);
        if (this.plotProgress.hidden !== !calculating) this.plotProgress.hidden = !calculating;
        const hideStatus = !state.message || (calculating && !this.valuesSelected);
        if (this.status.hidden !== hideStatus) this.status.hidden = hideStatus;
        if (this.plotArea.hidden !== this.valuesSelected) this.plotArea.hidden = this.valuesSelected;
        if (this.plotArea.classList.contains("is-calculating") !== calculating) this.plotArea.classList.toggle("is-calculating", calculating);
        if (!calculating) return false;
        const total = state.workProgress?.total;
        const completed = state.workProgress?.completed ?? 0;
        const detail = state.message + (total > 0 ? ` · ${(total - completed).toLocaleString()} remaining` : "");
        if (this.plotProgressDetail.textContent !== detail) this.plotProgressDetail.textContent = detail;
        if (total > 0) {
            for (const [name, value] of [["max", total], ["value", completed]]) {
                if (this.plotProgressBar.getAttribute(name) !== String(value)) this.plotProgressBar.setAttribute(name, String(value));
            }
        } else if (this.plotProgressBar.getAttribute("value") !== null) this.plotProgressBar.removeAttribute("value");
        return true;
    }

    /** Update select choices only when their contents change, preserving focused controls.
     * @param {HTMLSelectElement} select Native choice control.
     * @param {{value:string,label:string}[]} choices Available values and labels.
     * @param {string} value Selected value.
     * @return {void}
     */
    setOptions(select, choices, value) {
        const signature = JSON.stringify(choices);
        if (select.dataset.options !== signature) {
            select.dataset.options = signature;
            select.replaceChildren(...choices.map(choice => {
                const option = this.document.createElement("option"); option.value = choice.value; option.textContent = choice.label; return option;
            }));
        }
        if (select.value !== value) select.value = value;
    }

    /** Show the chosen dataset's variable and period below its direct source action.
     * @param {Object|null|undefined} temporal Current temporal draft, or ordinary-layer mode.
     * @return {void}
     */
    renderTemporalControls(temporal) {
        const controls = this.document.querySelector("#raster-series-temporal");
        if (controls.hidden !== !temporal) controls.hidden = !temporal;
        for (const id of ["order"]) {
            const label = this.document.querySelector("#raster-series-" + id).parentElement;
            if (label.hidden !== !!temporal) label.hidden = !!temporal;
        }
        const heading = this.document.querySelector("#raster-series-value-source"), caption = temporal ? "Time (UTC)" : "Raster";
        if (heading.textContent !== caption) heading.textContent = caption;
        if (!temporal) return;
        this.document.querySelector("#raster-series-temporal-title").textContent = temporal.item?.properties["cube:variables"][temporal.variable]?.description ?? "Choose a variable";
        const variable = this.document.querySelector("#raster-series-temporal-variable");
        variable.parentElement.hidden = !!temporal.variableBound;
        this.setOptions(variable, [{value: "", label: "Choose a variable…"}, ...Object.entries(temporal.item?.properties["cube:variables"] ?? {})
            .map(([value, metadata]) => ({value, label: `${metadata.description} (${metadata.unit})`}))], temporal.variable);
        variable.disabled = !temporal.item;
        this.period.render(temporal, {roundToHour: false});
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
            if (this.focusNewFormula) {
                this.focusNewFormula = false;
                this.formulaNodes.get(area.formulas.at(-1).id).querySelector('input[data-field="expression"]').focus();
            }
        }
        for (const row of this.formulaRows.children) {
            const formula = state.statistics.find(item => item.id === Number(row.dataset.formulaId));
            const name = formula.label || formula.expression || "Custom statistic";
            const caption = row.querySelector("span");
            if (caption.textContent !== name) caption.textContent = name;
            const swatch = row.querySelector("svg");
            const color = formula.color ?? STATISTIC_STYLES[formula.styleIndex].color;
            if (swatch.dataset.color !== color) {
                swatch.querySelector("line").setAttribute("stroke", color);
                swatch.querySelector("text").setAttribute("fill", color);
                swatch.dataset.color = color;
            }
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
                } else if (input.dataset.field === "threshold") {
                    const threshold = formula.preview?.percentAbove;
                    input.parentElement.hidden = threshold === undefined;
                    if (input !== this.document.activeElement && threshold !== undefined) input.value = String(threshold);
                } else {
                    const value = input.dataset.field === "color" ? color : formula[input.dataset.field];
                    if (input !== this.document.activeElement && input.value !== value) input.value = value;
                }
            }
            const plot = row.querySelector("select");
            const hideAssignment = state.plots.length === 1;
            if (plot.hidden !== hideAssignment) plot.hidden = hideAssignment;
            const plotsKey = state.plots.map(item => item.id).join(",");
            if (plot.dataset.optionsKey !== plotsKey) {
                plot.dataset.optionsKey = plotsKey;
                plot.replaceChildren(...state.plots.map(item => {
                    const option = this.document.createElement("option"); option.value = String(item.id);
                    option.textContent = `Plot ${item.displayNumber}`; return option;
                }));
            }
            const label = `Plot for ${name}`;
            if (plot.getAttribute("aria-label") !== label) plot.setAttribute("aria-label", label);
            if (plot.value !== String(formula.plotId)) plot.value = String(formula.plotId);
        }
        for (const [choice, input] of this.areaChoices) {
            if (input.checked !== (choice === area.areaChoice)) input.checked = choice === area.areaChoice;
        }
        const summary = this.document.querySelector("#raster-series-area-summary");
        const label = area.areaChoice === "whole" ? "Whole raster" : area.areaLabel || "No area selected";
        if (summary.textContent !== label) summary.textContent = label;
        const action = this.document.querySelector("#raster-series-open-area");
        const actionLabel = `Change sample area: ${label}`;
        if (action.getAttribute("aria-label") !== actionLabel) action.setAttribute("aria-label", actionLabel);
        const adopt = this.document.querySelector("#raster-series-use-current-filter");
        if (adopt.hidden !== !area.hasPendingVectorArea) adopt.hidden = !area.hasPendingVectorArea;
        const adoptLabel = area.areaChoice === "vector" ? "Use current polygon filter" : "Choose polygon layer";
        if (adopt.textContent !== adoptLabel) adopt.textContent = adoptLabel;
        const vector = this.document.querySelector("#raster-series-vector-area");
        if (vector.hidden !== (area.areaChoice !== "vector")) vector.hidden = area.areaChoice !== "vector";
        const addFormula = this.document.querySelector("#raster-series-add-formula");
        if (addFormula.disabled !== (area.formulas.length >= 5)) addFormula.disabled = area.formulas.length >= 5;
        const writeFormula = this.document.querySelector("#raster-series-write-formula");
        if (writeFormula.disabled !== addFormula.disabled) writeFormula.disabled = addFormula.disabled;
        for (const [choice] of this.areaChoices) {
            const button = this.document.querySelector("#raster-series-pick-" + choice);
            const pressed = String(choice === area.areaChoice);
            if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
        }
        const exact = this.document.querySelector("#raster-series-exact-statistics");
        if (exact.hidden !== !area.canCalculateExactStatistics) exact.hidden = !area.canCalculateExactStatistics;
        const retry = this.document.querySelector("#raster-series-retry");
        const hideRetry = state.busy || !area.hasErrors || area.recoverable;
        if (retry.hidden !== hideRetry) retry.hidden = hideRetry;
        const cancel = this.document.querySelector("#raster-series-cancel");
        const hideCancel = !state.busy && !area.recoverable;
        if (cancel.hidden !== hideCancel) cancel.hidden = hideCancel;
        const recover = this.document.querySelector("#raster-series-recover");
        if (recover.hidden !== !area.recoverable) recover.hidden = !area.recoverable;
    }

    /** Create a retained statistic row with visibility, assignment and a native editor disclosure.
     * Blank custom expressions start expanded; subsequent snapshots leave disclosure state alone.
     * @param {SeriesStatistic} formula Statistic identity and presentation.
     * @return {HTMLDivElement} Row whose input events use the existing owner callbacks.
     */
    createFormulaRow(formula) {
        const row = this.document.createElement("div"); row.className = "raster-series-formula";
        row.dataset.formulaId = String(formula.id);
        const legend = this.document.createElement("label"); legend.className = "raster-series-formula-legend";
        const visible = this.document.createElement("input"); visible.type = "checkbox"; visible.dataset.field = "visible";
        visible.addEventListener("change", () => this.actions.onStatisticDisplay(formula.id, { visible: visible.checked }));
        const name = this.document.createElement("span");
        legend.append(visible, createStatisticSwatch(this.document, formula.styleIndex, formula.color), name);
        for (const event of ["pointerenter", "focusin"]) legend.addEventListener(event, () => this.plotsView.highlightStatistic(formula.id));
        for (const event of ["pointerleave", "focusout"]) legend.addEventListener(event, () => this.plotsView.highlightStatistic(null));
        const plot = this.document.createElement("select"); plot.dataset.field = "plotId";
        plot.addEventListener("change", () => this.actions.onStatisticDisplay(formula.id, { plotId: Number(plot.value) }));
        const editor = this.document.createElement("details"); editor.className = "raster-series-formula-editor";
        editor.open = !formula.expression;
        const summary = this.document.createElement("summary"); summary.textContent = "Edit"; editor.append(summary);
        if (typeof formula.preview === "object") {
            const label = this.document.createElement("label"); label.textContent = "Threshold";
            const input = this.document.createElement("input");
            input.type = "number"; input.step = "any"; input.required = true; input.dataset.field = "threshold";
            input.setAttribute("aria-label", "Threshold");
            input.addEventListener("change", () => {
                if (input.reportValidity()) this.actions.onEditFormula(formula.id, {threshold: input.valueAsNumber});
            });
            label.append(input); editor.append(label);
        }
        for (const [field, label, limit] of [["label", "Statistic name", 80], ["expression", "Formula", 4096]]) {
            const fieldLabel = this.document.createElement("label"); fieldLabel.textContent = label;
            const input = this.document.createElement("input");
            input.dataset.field = field; input.setAttribute("aria-label", label); input.placeholder = label; input.maxLength = limit;
            input.addEventListener("input", () => this.actions.onEditFormula(formula.id, { [field]: input.value }));
            fieldLabel.append(input); editor.append(fieldLabel);
        }
        const colorLabel = this.document.createElement("label"); colorLabel.textContent = "Color";
        const color = this.document.createElement("input"); color.type = "color"; color.dataset.field = "color";
        color.setAttribute("aria-label", "Statistic color");
        color.addEventListener("input", () => this.actions.onStatisticDisplay(formula.id, {color: color.value}));
        colorLabel.append(color); editor.append(colorLabel);
        editor.append(this.document.querySelector("#raster-series-formula-help").content.cloneNode(true));
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
