/** Ordered numeric analysis for bounded vector feature-inspection results. */

import {
    renderOrdinalSeriesChart,
    renderStackedSeriesChart,
} from "../charts/series-chart.js";
import { labelVectorPlotValues, VectorPlotFields, VectorPlotPanel, vectorFeatureLabel } from "./plot-panel.js";
import { VectorPlotStatistics } from "./plot-statistics.js";
/** @typedef {import("./inspection-observation.js").VectorInspectionObservation} VectorInspectionObservation */

export const VECTOR_TIME_SERIES_LAYER_LABEL = "__eolab_layer_label__";

const NATURAL_TEXT = new Intl.Collator("en", {
    numeric: true,
    sensitivity: "base",
});

/**
 * @typedef {Object} VectorTimeSeriesSettings
 * @property {string} xField Layer-label sentinel or inspected attribute name.
 * @property {string[]} yFields Numeric fields in display order.
 * @property {"ascending"|"descending"} direction Sort direction.
 * @property {"line"|"scatter"|"bar"|"stacked"} [chartType] Choose feature rows or X coordinates.
 */

/**
 * Return whether an attribute can label and order a chart observation.
 *
 * @param {unknown} value Candidate inspected attribute.
 * @return {boolean} Whether the value is a supported scalar X value.
 */
function isOrderableValue(value) {
    return (
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
    );
}

/**
 * Summarize usable X and numeric Y fields without requiring a common schema.
 *
 * @param {ReadonlyArray<VectorInspectionObservation>} observations Immutable inspector records.
 * @return {{xFields:{name:string,count:number,total:number}[],
 * numericFields:{name:string,count:number,total:number}[]}} Field names and coverage.
 */
export function summarizeVectorTimeSeriesFields(observations) {
    const xCoverage = new Map();
    const numericCoverage = new Map();
    for (const observation of observations) {
        for (const [name, value] of Object.entries(observation.properties)) {
            if (isOrderableValue(value)) {
                xCoverage.set(name, (xCoverage.get(name) ?? 0) + 1);
            }
            if (typeof value === "number" && Number.isFinite(value)) {
                numericCoverage.set(name, (numericCoverage.get(name) ?? 0) + 1);
            }
        }
    }
    const summarize = (coverage) => [...coverage]
        .sort(([left], [right]) => NATURAL_TEXT.compare(left, right))
        .map(([name, count]) => ({ name, count, total: observations.length }));
    return {
        xFields: summarize(xCoverage),
        numericFields: summarize(numericCoverage),
    };
}

/**
 * Format one supported scalar as an axis or table label.
 *
 * @param {string|number|boolean} value Scalar chart value.
 * @return {string} Stable user-facing label.
 */
function formatScalar(value) {
    if (typeof value === "boolean") {
        return value ? "True" : "False";
    }
    return String(value);
}

/**
 * Select continuous spacing only when every plotted X value is finite numeric data.
 *
 * Mixed and textual values retain ordinal spacing so each inspected observation
 * remains visible without coercing feature attributes.
 *
 * @param {{xValue:unknown}[]} points Feature rows with an available X value.
 * @return {"ordinal"|"numeric"} Shared chart X-scale mode.
 */
function vectorTimeSeriesXScale(points) {
    return points.every((point) =>
        typeof point.xValue === "number" && Number.isFinite(point.xValue)
    ) ? "numeric" : "ordinal";
}


/**
 * @typedef {Object} ComparisonRow
 * @property {number} sourceIndex Position in this inspection, independent of feature IDs.
 * @property {VectorInspectionObservation} observation Original feature and zoom target.
 * @property {string|number|boolean|null} xValue Raw X coordinate, or null when unavailable.
 * @property {string} xLabel Exact display value of the X coordinate.
 */

/** @typedef {{field:string,points:(ComparisonRow & {yValue:number|null})[],finiteCount:number}} ComparisonPlot */

/**
 * Order every inspected feature once for the values table and all comparison plots.
 * Missing X values sort last and stay in the table and stacked chart. Missing
 * measurements keep their slots, and equal X values retain the inspection order.
 * @param {ReadonlyArray<VectorInspectionObservation>} observations Features from the map click.
 * @param {VectorTimeSeriesSettings} settings Selected axes and sort direction.
 * @return {{rows:ComparisonRow[],xScale:"numeric"|"ordinal",plots:ComparisonPlot[]}} Aligned plots and table rows.
 */
export function buildVectorFeatureComparison(observations, settings) {
    const rows = observations.map((observation, sourceIndex) => {
        const raw = settings.xField === VECTOR_TIME_SERIES_LAYER_LABEL
            ? observation.layerLabel : observation.properties[settings.xField];
        const xValue = isOrderableValue(raw) ? raw : null;
        return {observation, sourceIndex, xValue, xLabel: xValue === null ? "No value" : formatScalar(xValue)};
    });
    const xScale = vectorTimeSeriesXScale(rows.filter(row => row.xValue !== null));
    rows.sort((left, right) => {
        if (left.xValue === null || right.xValue === null) return Number(left.xValue === null) - Number(right.xValue === null);
        const order = xScale === "numeric" ? left.xValue - right.xValue : NATURAL_TEXT.compare(left.xLabel, right.xLabel);
        return (settings.direction === "ascending" ? order : -order) || left.sourceIndex - right.sourceIndex;
    });
    const positions = settings.chartType === "stacked" ? rows : rows.filter(row => row.xValue !== null);
    const plots = settings.yFields.map(field => {
        const points = positions.map(row => {
            const value = row.observation.properties[field];
            return {...row, yValue: Number.isFinite(value) ? value : null};
        });
        return {field, points, finiteCount: points.filter(point => point.yValue !== null).length};
    });
    return {rows, plots, xScale};
}

/**
 * Describe the sources behind the comparison and identify its dock tab.
 * @param {ReadonlyArray<VectorInspectionObservation>} observations Features at this map click.
 * @param {string[]} fields Selected comparison measurements.
 * @return {{heading:string, context:string, label:string, title:string}|null} Plot identity, or null before inspection.
 */
export function vectorTimeSeriesPresentation(observations, fields) {
    if (!observations.length) return null;
    const sources = new Map(observations.map(item => [item.sourceId, item.layerLabel]));
    const names = [...sources.values()];
    const measure = fields.length === 1 ? fields[0] : "Compare features";
    const count = observations.length + (observations.length === 1 ? " feature" : " features");
    return {
        heading: names.length === 1 ? names[0] : "Features at map click",
        context: names.join(", "),
        label: measure + " · " + count,
        title: measure + " · " + count + " · " + names.join(", "),
    };
}

/** Plot selected numeric fields across the features returned by one map click. */
export class VectorTimeSeriesController {
    /**
     * @param {Object} configuration Browser composition callbacks.
     * @param {(visible:boolean,moveFocus:boolean)=>void} configuration.onVisibilityChange Show or close the dock view.
     * @param {(identity:{label:string,title:string}|null)=>void} configuration.onPresentationChange Update the dock tab.
     * @param {(focus:VectorInspectionObservation["focus"],index:number)=>boolean} configuration.onFeatureZoom
     * Highlight the inspected result at this index and return whether the map could fit its bounds.
     * @param {(index:number|null)=>void} configuration.onOpenFeature Open a single feature, or the inspector's current one.
     * @param {(direction:"previous"|"next")=>void} configuration.onNavigateSelection Request the adjacent map selection.
     * @param {import("./plot-statistics.js").DescribeStatisticsSource} [configuration.describeStatisticsSource]
     * Look up the original layer and schema for whole-layer benchmarks.
     * @param {Document} [configuration.documentContext=document] Owning document.
     * @throws {TypeError} If visibility, dock identity, zoom, or selection navigation callbacks are missing.
     */
    constructor({
        onVisibilityChange, onPresentationChange, onFeatureZoom, onOpenFeature, onNavigateSelection,
        describeStatisticsSource = () => null, documentContext = document,
    }) {
        for (const [name, callback] of Object.entries({onVisibilityChange, onPresentationChange, onFeatureZoom, onNavigateSelection})) {
            if (typeof callback !== "function") throw new TypeError(name + " must be a function.");
        }
        this.document = documentContext;
        this.onVisibilityChange = onVisibilityChange;
        this.onPresentationChange = onPresentationChange;
        this.onFeatureZoom = onFeatureZoom;
        this.panel = documentContext.querySelector("#vector-time-series");
        const element = id => documentContext.querySelector("#vector-time-series-" + id);
        this.heading = element("heading");
        this.context = element("context");
        this.xField = element("x");
        this.xFieldLabel = element("x-label");
        this.direction = element("direction");
        this.chartType = element("chart-type");
        this.chart = element("chart");
        this.legend = element("legend");
        this.chartTitle = element("chart-title");
        this.firstPlot = element("first");
        this.extraPlots = element("extra-charts");
        this.table = element("table");
        this.tableHead = element("table-head");
        this.tableBody = element("table-body");
        this.status = element("status");
        this.selection = element("selection");
        this.selectionText = element("selection-text");
        this.zoomFeatureButton = documentContext.querySelector("#zoom-vector-time-series-feature");
        this.featureList = element("feature-list");
        this.openFeature = element("one");
        this.previousSelection = element("previous-selection");
        this.nextSelection = element("next-selection");
        this.plotPanel = new VectorPlotPanel(documentContext, "vector-time-series", () => this.render());
        this.statistics = new VectorPlotStatistics(documentContext, "vector-time-series", describeStatisticsSource);
        this.fields = new VectorPlotFields(documentContext, "vector-time-series", names => {
            this.settings.yFields = names;
            this.render();
        });
        this.observations = [];
        this.settings = {xField: VECTOR_TIME_SERIES_LAYER_LABEL, yFields: [], direction: "ascending", chartType: "bar"};
        this.hasInitialFields = false;
        /** @type {{index:number,field:string|null,zoomUnavailable:boolean}|null} The chosen reading in this sample. */
        this.selected = null;
        this.pointElements = [];
        this.sampleState = "empty";
        this.sampleMessage = "Click the map to inspect vector features.";
        this.failedLayers = 0;
        this.modeActive = false;
        this.abort = new AbortController();
        const listen = {signal: this.abort.signal};
        this.setSelectionNavigation({canPrevious: false, canNext: false});
        for (const [direction, button, opposite] of [
            ["previous", this.previousSelection, this.nextSelection],
            ["next", this.nextSelection, this.previousSelection],
        ]) {
            button.addEventListener("click", () => {
                if (button.disabled) return;
                const wasFocused = documentContext.activeElement === button;
                onNavigateSelection(direction);
                if (wasFocused && button.disabled && !opposite.disabled) opposite.focus();
            }, listen);
        }
        documentContext.querySelector("#close-vector-time-series").addEventListener("click", () => this.close({moveFocus:true}), listen);
        for (const [control, setting] of [[this.xField,"xField"],[this.direction,"direction"],[this.chartType,"chartType"]]) {
            control.addEventListener("change", () => { this.settings[setting] = control.value; this.render(); }, listen);
        }
        this.openFeature.addEventListener("click", () => onOpenFeature(this.selected?.index ?? null), listen);
        this.featureList.addEventListener("change", () => {
            this.#select(Number(this.featureList.value), null);
            this.plotPanel.closePicker();
        }, listen);
        this.zoomFeatureButton.addEventListener("click", () => {
            if (this.selected) this.#zoomToSelectedFeature();
        }, listen);
        documentContext.addEventListener("keydown", event => {
            if (event.key !== "Escape" || this.panel.hidden || !this.panel.contains(documentContext.activeElement)) return;
            event.preventDefault();
            event.stopPropagation();
            if (!this.plotPanel.closePicker()) this.close({moveFocus:true});
        }, listen);
        this.render();
    }

    /** Open the current comparison. @return {void} */
    open() {
        this.modeActive = true;
        this.onVisibilityChange(true, false);
        this.render();
        this.document.querySelector("#vector-time-series-compare").focus();
    }

    /**
     * Close the comparison while retaining its configuration.
     * @param {{moveFocus?:boolean}} [options] Whether to return focus to the map.
     * @return {void}
     */
    close({moveFocus = false} = {}) {
        this.modeActive = false;
        this.statistics.update([], []);
        this.plotPanel.closePicker(false);
        this.onVisibilityChange(false, moveFocus);
    }

    /**
     * Enable each history button when another completed map selection is available.
     * @param {Readonly<{canPrevious:boolean,canNext:boolean}>} navigation Available directions.
     * @return {void}
     */
    setSelectionNavigation({canPrevious, canNext}) {
        this.previousSelection.disabled = !canPrevious;
        this.nextSelection.disabled = !canNext;
    }

    /**
     * Replace the map click's observations without discarding the user's field or display choices.
     * @param {import("./inspection-observation.js").VectorInspectionSample} sample
     * Inspector-owned result and progress, including observations retained after dismissal.
     * @param {import("./inspection-observation.js").VectorInspectionChange} [change="inspection"]
     * A layer rename retains the selected observation and the field search.
     * @return {void}
     * @throws {TypeError} If the inspection state or message is invalid.
     */
    setSample(sample, change = "inspection") {
        if (!["loading", "ready", "empty", "invalidated", "interrupted"].includes(sample?.state) || typeof sample.message !== "string") {
            throw new TypeError("Invalid vector inspection sample.");
        }
        this.observations = Object.freeze([...sample.observations]);
        if (change === "labels") {
            this.render();
            return;
        }
        this.sampleState = sample.state;
        this.sampleMessage = sample.message;
        this.failedLayers = sample.failedLayers ?? 0;
        this.selected = null;
        const summary = summarizeVectorTimeSeriesFields(this.observations);
        if (!this.hasInitialFields && (sample.state === "ready" || sample.state === "interrupted") && summary.numericFields.length) {
            const date = summary.xFields.find(field => field.count === this.observations.length &&
                /^(year|survey_year|date|survey_date)$/i.test(field.name));
            if (date) this.settings.xField = date.name;
            const measure = summary.numericFields.find(field => field.name !== date?.name && !/^(id|fid|objectid)$/i.test(field.name));
            this.settings.yFields = [(measure ?? summary.numericFields[0]).name];
            this.hasInitialFields = true;
        }
        this.fields.search.value = "";
        this.render();
    }

    /** Rebuild picker options, the selected chart style, and exact values for each feature. @return {void} */
    render() {
        const {xFields,numericFields} = summarizeVectorTimeSeriesFields(this.observations);
        const {xField,yFields,direction,chartType} = this.settings;
        const choices = new Map([[VECTOR_TIME_SERIES_LAYER_LABEL,"Filename or layer"]]);
        for (const field of xFields) choices.set(field.name, field.name);
        if (!choices.has(xField)) choices.set(xField, xField + " (unavailable)");
        this.xField.replaceChildren(...[...choices].map(([value,label]) => this.#option(value,label)));
        this.xField.value = xField;
        this.xFieldLabel.textContent = chartType === "stacked" ? "Feature labels" : "X axis";
        this.direction.value = direction;
        this.chartType.value = chartType;
        this.fields.update(new Map(numericFields.map(field =>
            [field.name, field.count === field.total ? "" : field.count + " of " + field.total])), yFields);
        this.featureList.replaceChildren(this.#option("", "Choose a feature"),
            ...this.observations.map((o,i) => this.#option(String(i), vectorFeatureLabel(o,i))));
        this.featureList.children[0].disabled = true;
        this.plotPanel.fieldButton.textContent = yFields.length > 1 ? yFields.length + " fields" : "Choose fields";
        const count = this.observations.length;
        this.plotPanel.featureButton.textContent = count + (count === 1 ? " feature" : " features");
        const interrupted = this.sampleState === "interrupted";
        const canShowResults = this.sampleState === "ready" || interrupted;
        this.statistics.update(this.modeActive && canShowResults ? this.observations : [], yFields);
        this.openFeature.disabled = !canShowResults || count === 0;
        this.plotPanel.featureButton.disabled = !canShowResults || count === 0;
        this.plotPanel.fieldButton.disabled = !canShowResults || count === 0 || (numericFields.length === 0 && !yFields.length);
        const identity = vectorTimeSeriesPresentation(this.observations,yFields);
        this.heading.textContent = identity?.heading ?? "Compare features";
        this.context.textContent = identity?.context ?? "";
        this.context.hidden = !identity;
        this.onPresentationChange(identity ? {label:identity.label,title:identity.title} : null);
        this.chart.replaceChildren();
        this.chart.setAttribute("hidden","");
        this.legend.hidden = true;
        this.chartTitle.hidden = chartType === "stacked";
        this.firstPlot.replaceChildren(this.chartTitle, this.legend, this.chart);
        this.firstPlot.hidden = true;
        this.extraPlots.replaceChildren();
        this.tableBody.replaceChildren();
        this.tableHead.replaceChildren();
        this.tableRows = new Map();
        this.table.hidden = true;
        this.pointElements = [];
        this.selection.hidden = true;
        this.zoomFeatureButton.hidden = true;
        this.zoomFeatureButton.disabled = true;
        this.featureList.value = "";
        this.status.textContent = canShowResults ? "" : this.sampleMessage;
        if (!canShowResults) return;
        if (count && yFields.length === 0) {
            this.status.textContent = numericFields.length ? "Choose a field to plot." : "These features have no numeric fields.";
        } else if (count) {
            const {rows,plots,xScale} = buildVectorFeatureComparison(this.observations,this.settings);
            const xLabel = choices.get(xField);
            if (chartType === "stacked") {
                this.#drawStackedComparison(plots);
            } else {
                for (const [index,plot] of plots.entries()) this.#drawField(plot,index,xLabel,xScale,count);
            }
            this.#renderTable(rows,yFields,xLabel);
        }
        if (interrupted) this.status.textContent = [this.sampleMessage, this.status.textContent].filter(Boolean).join(" ");
        if (this.failedLayers) this.status.textContent += (this.status.textContent ? " " : "") +
            this.failedLayers + (this.failedLayers === 1 ? " layer could not be inspected." : " layers could not be inspected.");
        if (this.selected) this.#select(this.selected.index, yFields.includes(this.selected.field) ? this.selected.field : null);
    }

    /**
     * Create a native picker option using the unmodified field value or feature index.
     * @param {string} value Picker value.
     * @param {string} label Visible label.
     * @return {HTMLOptionElement} Detached option.
     */
    #option(value,label) {
        const option = this.document.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
    }

    /**
     * Draw one field with its own numeric scale and the shared ordered X positions.
     * @param {ComparisonPlot} plot Field and readings.
     * @param {number} index Plot position.
     * @param {string} xLabel Horizontal field name.
     * @param {"numeric"|"ordinal"} xScale Horizontal spacing.
     * @param {number} total Number of returned features.
     * @return {void}
     */
    #drawField(plot,index,xLabel,xScale,total) {
        let figure = this.firstPlot, title = this.chartTitle, chart = this.chart;
        if (index) {
            figure = this.document.createElement("section");
            figure.classList.add("vector-plot-figure");
            title = this.document.createElement("h3");
            chart = this.document.createElementNS("http://www.w3.org/2000/svg","svg");
            chart.setAttribute("class","vector-time-series-chart");
            chart.setAttribute("role","group");
            figure.append(title,chart);
            this.extraPlots.append(figure);
        }
        figure.hidden = false;
        title.textContent = plot.field;
        if (plot.finiteCount) {
            chart.removeAttribute("hidden");
            const handles = renderOrdinalSeriesChart({
                documentContext:this.document,chart,points:plot.points,chartType:this.settings.chartType,
                width:this.plotPanel.width || undefined,height:this.settings.yFields.length > 1 ? 188 : 218,
                fitXAxisLabels:true,
                xScale,xReverse:xScale === "numeric" && this.settings.direction === "descending",
                xAxisLabel:xLabel,yAxisLabel:"Value",ariaLabel:plot.field + " by " + xLabel,
                pointAccessibleLabel:p => this.#identity(p.observation,p.sourceIndex,plot.field,p.xLabel),
                pointTooltip:p => this.#identity(p.observation,p.sourceIndex,plot.field,p.xLabel),
                onPointSelect: point => this.#selectAndZoomToFeature(point.sourceIndex, plot.field),
            });
            labelVectorPlotValues(chart, handles.pointElements, this.settings.chartType);
            this.pointElements.push(...handles.pointElements);
        } else chart.setAttribute("hidden","");
        const missing = total - plot.finiteCount;
        if (missing) {
            const note = this.document.createElement("p");
            note.classList.add("vector-plot-missing");
            note.textContent = !plot.finiteCount ? "No numeric readings with the selected X field." :
                missing + (missing === 1 ? " feature lacks" : " features lack") + " an X value or a numeric " + plot.field + " value.";
            figure.append(note);
        }
    }

    /**
     * Draw one stack per inspected feature, including separate rows for tied labels.
     * @param {ComparisonPlot[]} plots Selected measurements aligned to the same ordered features.
     * @return {void}
     */
    #drawStackedComparison(plots) {
        const rows = plots[0].points;
        const readingCount = plots.reduce((count, plot) => count + plot.finiteCount, 0);
        if (readingCount === 0) {
            this.status.textContent = "The selected fields have no numeric values on these features.";
            return;
        }
        const labelCounts = new Map();
        for (const row of rows) labelCounts.set(row.xLabel, (labelCounts.get(row.xLabel) ?? 0) + 1);
        const rowLabels = rows.map(row => {
            if (row.xValue === null) return `Feature ${row.sourceIndex + 1}`;
            return labelCounts.get(row.xLabel) > 1 ? `${row.sourceIndex + 1} · ${row.xLabel}` : row.xLabel;
        });
        this.firstPlot.hidden = false;
        this.pointElements = renderStackedSeriesChart({
            documentContext: this.document,
            chart: this.chart,
            legend: this.legend,
            width: this.plotPanel.width || undefined,
            series: plots.map(plot => ({id: plot.field, label: plot.field, points: plot.points})),
            rowLabels,
            valueAxisLabel: "Value",
            ariaLabel: "Numeric fields stacked by feature",
            describePoint: (point, field) => this.#identity(point.observation, point.sourceIndex, field, point.xLabel),
            onPointSelect: (point, field) => this.#selectAndZoomToFeature(point.sourceIndex, field),
        }).pointElements;
        const missing = rows.length * plots.length - readingCount;
        if (missing) this.status.textContent = missing === 1 ? "One field value is missing. See Values." :
            `${missing} field values are missing. See Values.`;
    }

    /**
     * Return a feature's original identity and exact field value.
     * @param {VectorInspectionObservation} observation Inspected feature.
     * @param {number} index Original position.
     * @param {string|null} field Selected measurement or null for a feature.
     * @param {string} xLabel Horizontal coordinate.
     * @return {string} Accessible feature and measurement description.
     */
    #identity(observation,index,field,xLabel) {
        const identity = vectorFeatureLabel(observation,index);
        if (field === null) return identity;
        const y = observation.properties[field];
        return identity + " · " + xLabel + " · " + field + " = " + (Number.isFinite(y) ? String(y) : "No value");
    }

    /**
     * Highlight the same feature in every plot and preserve its known zoom availability.
     * @param {number} index Original observation position.
     * @param {string|null} field Measurement, or null for selection from the feature picker.
     * @return {void}
     */
    #select(index,field) {
        const zoomUnavailable = this.selected?.index === index && this.selected.zoomUnavailable;
        this.selected = {index, field, zoomUnavailable};
        this.featureList.value = String(index);
        this.selection.hidden = false;
        this.zoomFeatureButton.hidden = false;
        this.#renderSelectedReading();
        for (const [sourceIndex, {row, cells}] of this.tableRows) {
            row.setAttribute("aria-current", String(sourceIndex === index));
            for (const [name, button] of cells) {
                button.setAttribute("aria-pressed", String(sourceIndex === index && name === field));
            }
        }
        for (const {circle,point} of this.pointElements) {
            const chosen = point.sourceIndex === index;
            if (chosen) circle.classList.add("is-selected");
            else circle.classList.remove("is-selected");
            circle.setAttribute("aria-pressed",String(chosen));
        }
    }

    /** Show the selected reading and its zoom action, including a previously unavailable location. @return {void} */
    #renderSelectedReading() {
        const {index, field, zoomUnavailable} = this.selected;
        const observation = this.observations[index];
        const x = this.settings.xField === VECTOR_TIME_SERIES_LAYER_LABEL ? observation.layerLabel : observation.properties[this.settings.xField];
        const reading = this.#identity(observation, index, field, isOrderableValue(x) ? formatScalar(x) : "No value");
        this.selectionText.textContent = zoomUnavailable ? reading + " · Feature location is unavailable." : reading;
        this.zoomFeatureButton.disabled = zoomUnavailable;
    }

    /**
     * Select the plotted reading, highlight its feature, and zoom to it.
     * @param {number} index Feature position in the current inspection sample.
     * @param {string} field Measurement represented by the activated mark.
     * @return {void}
     */
    #selectAndZoomToFeature(index, field) {
        this.#select(index, field);
        this.#zoomToSelectedFeature();
    }

    /**
     * Highlight the selected feature on the map and fit its bounds.
     * Remember unavailable bounds for this selection and show them beside the reading.
     * @return {void}
     */
    #zoomToSelectedFeature() {
        const {index} = this.selected;
        if (this.onFeatureZoom(this.observations[index].focus, index)) return;
        this.selected.zoomUnavailable = true;
        this.#renderSelectedReading();
    }

    /**
     * Show each inspected feature once, including missing X or Y readings. Value buttons select the exact original feature.
     * @param {ComparisonRow[]} rows Ordered features.
     * @param {string[]} fields Selected measurement columns.
     * @param {string} xLabel Horizontal coordinate or category.
     * @return {void}
     */
    #renderTable(rows,fields,xLabel) {
        for (const name of [xLabel,...fields]) {
            const cell = this.document.createElement("th");
            cell.setAttribute("scope", "col");
            cell.textContent = name;
            this.tableHead.append(cell);
        }
        for (const row of rows) {
            const tr = this.document.createElement("tr");
            const cells = new Map();
            this.tableRows.set(row.sourceIndex, {row: tr, cells});
            const id = this.document.createElement("th");
            id.setAttribute("scope","row");
            const identity = this.document.createElement("small");
            identity.textContent = vectorFeatureLabel(row.observation,row.sourceIndex);
            id.textContent = row.xLabel;
            id.append(identity);
            tr.append(id);
            for (const field of fields) {
                const cell = this.document.createElement("td");
                const button = this.document.createElement("button");
                const y = row.observation.properties[field];
                button.type = "button";
                button.classList.add("summary-text-button");
                button.textContent = Number.isFinite(y) ? String(y) : "No value";
                button.setAttribute("aria-pressed", "false");
                cells.set(field, button);
                button.setAttribute("aria-label",this.#identity(row.observation,row.sourceIndex,field,row.xLabel));
                button.addEventListener("click",() => this.#select(row.sourceIndex,field));
                cell.append(button);
                tr.append(cell);
            }
            this.tableBody.append(tr);
        }
        this.table.hidden = false;
    }

    /** Release controls and chart resize observation, then close the dock. @return {void} */
    destroy() {
        this.abort.abort();
        this.plotPanel.destroy();
        this.fields.destroy();
        this.statistics.destroy();
        this.onPresentationChange(null);
        this.onVisibilityChange(false, false);
    }
}
