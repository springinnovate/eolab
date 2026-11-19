/** Ordered numeric analysis for bounded vector feature-inspection results. */

import {
    renderOrdinalSeriesChart,
} from "../charts/series-chart.js";
import { labelVectorPlotValues, VectorPlotFields, VectorPlotPanel, vectorFeatureLabel } from "./plot-panel.js";
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

/**
 * Order every inspected feature once for the values table and all comparison plots.
 * Missing X values sort last and stay in the table. Missing numeric measurements retain
 * their X slot in every plot. Equal X values retain the inspection order.
 * @param {ReadonlyArray<VectorInspectionObservation>} observations Features from the map click.
 * @param {VectorTimeSeriesSettings} settings Selected axes and sort direction.
 * @return {{rows:ComparisonRow[], xScale:"numeric"|"ordinal", plots:{field:string,
 * points:(ComparisonRow & {yValue:number|null})[], finiteCount:number}[]}} Aligned plots and table rows.
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
    const positions = rows.filter(row => row.xValue !== null);
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
     * @param {(focus:VectorInspectionObservation["focus"])=>boolean} configuration.onFeatureZoom Zoom to the selected source feature.
     * @param {(index:number|null)=>void} configuration.onOpenFeature Open a single feature, or the inspector's current one.
     * @param {Document} [configuration.documentContext=document] Owning document.
     * @throws {TypeError} If visibility, dock identity, or zoom callbacks are missing.
     */
    constructor({onVisibilityChange, onPresentationChange, onFeatureZoom, onOpenFeature, documentContext = document}) {
        for (const [name, callback] of Object.entries({onVisibilityChange, onPresentationChange, onFeatureZoom})) {
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
        this.direction = element("direction");
        this.chartType = element("chart-type");
        this.chart = element("chart");
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
        this.plotPanel = new VectorPlotPanel(documentContext, "vector-time-series", () => this.render());
        this.fields = new VectorPlotFields(documentContext, "vector-time-series", names => {
            this.settings.yFields = names;
            this.render();
        });
        this.observations = [];
        this.settings = {xField: VECTOR_TIME_SERIES_LAYER_LABEL, yFields: [], direction: "ascending", chartType: "bar"};
        this.hasInitialFields = false;
        this.selected = null;
        this.pointElements = [];
        this.sampleState = "empty";
        this.sampleMessage = "Click the map to inspect vector features.";
        this.failedLayers = 0;
        this.abort = new AbortController();
        const listen = {signal: this.abort.signal};
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
            if (this.selected && !onFeatureZoom(this.observations[this.selected.index].focus)) {
                this.zoomFeatureButton.disabled = true;
                this.status.textContent = "Feature location is unavailable. The map has not moved.";
            }
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
        this.plotPanel.closePicker(false);
        this.onVisibilityChange(false, moveFocus);
    }

    /**
     * Replace the map click's observations without discarding the user's field or display choices.
     * @param {{state:"loading"|"ready"|"empty"|"invalidated",observations:ReadonlyArray<VectorInspectionObservation>,
     * message:string,failedLayers?:number}} sample Inspector-owned result and progress.
     * @return {void}
     * @throws {TypeError} If the inspection state or message is invalid.
     */
    setSample(sample) {
        if (!["loading", "ready", "empty", "invalidated"].includes(sample?.state) || typeof sample.message !== "string") {
            throw new TypeError("Invalid vector inspection sample.");
        }
        this.observations = Object.freeze([...sample.observations]);
        this.sampleState = sample.state;
        this.sampleMessage = sample.message;
        this.failedLayers = sample.failedLayers ?? 0;
        this.selected = null;
        const summary = summarizeVectorTimeSeriesFields(this.observations);
        if (!this.hasInitialFields && sample.state === "ready" && summary.numericFields.length) {
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

    /** Rebuild picker options, aligned charts, and one exact-values row per feature. @return {void} */
    render() {
        const {xFields,numericFields} = summarizeVectorTimeSeriesFields(this.observations);
        const {xField,yFields,direction,chartType} = this.settings;
        const choices = new Map([[VECTOR_TIME_SERIES_LAYER_LABEL,"Filename or layer"]]);
        for (const field of xFields) choices.set(field.name, field.name);
        if (!choices.has(xField)) choices.set(xField, xField + " (unavailable)");
        this.xField.replaceChildren(...[...choices].map(([value,label]) => this.#option(value,label)));
        this.xField.value = xField;
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
        const ready = this.sampleState === "ready";
        this.openFeature.disabled = !ready || count === 0;
        this.plotPanel.featureButton.disabled = !ready || count === 0;
        this.plotPanel.fieldButton.disabled = !ready || (numericFields.length === 0 && !yFields.length);
        const identity = vectorTimeSeriesPresentation(this.observations,yFields);
        this.heading.textContent = identity?.heading ?? "Compare features";
        this.context.textContent = identity?.context ?? "";
        this.context.hidden = !identity;
        this.onPresentationChange(identity ? {label:identity.label,title:identity.title} : null);
        this.chart.replaceChildren();
        this.chart.setAttribute("hidden","");
        this.firstPlot.replaceChildren(this.chartTitle, this.chart);
        this.firstPlot.hidden = true;
        this.extraPlots.replaceChildren();
        this.tableBody.replaceChildren();
        this.tableHead.replaceChildren();
        this.table.hidden = true;
        this.pointElements = [];
        this.selection.hidden = true;
        this.zoomFeatureButton.hidden = true;
        this.zoomFeatureButton.disabled = true;
        this.featureList.value = "";
        this.status.textContent = ready ? "" : this.sampleMessage;
        if (!ready) return;
        if (yFields.length === 0) {
            this.status.textContent = numericFields.length ? "Choose a field to plot." : "These features have no numeric fields.";
        } else {
            const {rows,plots,xScale} = buildVectorFeatureComparison(this.observations,this.settings);
            const xLabel = choices.get(xField);
            for (const [index,plot] of plots.entries()) this.#drawField(plot,index,xLabel,xScale,count);
            this.#renderTable(rows,yFields,xLabel);
        }
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
     * @param {{field:string,points:(ComparisonRow & {yValue:number|null})[],finiteCount:number}} plot Field and readings.
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
                width:this.plotPanel.width || undefined,height:this.settings.yFields.length > 1 ? 215 : 250,
                xScale,xReverse:xScale === "numeric" && this.settings.direction === "descending",
                xAxisLabel:xLabel,yAxisLabel:"Value",ariaLabel:plot.field + " by " + xLabel,
                pointAccessibleLabel:p => this.#identity(p.observation,p.sourceIndex,plot.field,p.xLabel),
                pointTooltip:p => this.#identity(p.observation,p.sourceIndex,plot.field,p.xLabel),
                onPointSelect:p => this.#select(p.sourceIndex,plot.field),
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
     * Highlight the same feature in every plot and enable its original zoom target.
     * @param {number} index Original observation position.
     * @param {string|null} field Measurement, or null for selection from the feature picker.
     * @return {void}
     */
    #select(index,field) {
        const observation = this.observations[index];
        this.selected = {index,field};
        this.featureList.value = String(index);
        const x = this.settings.xField === VECTOR_TIME_SERIES_LAYER_LABEL ? observation.layerLabel : observation.properties[this.settings.xField];
        this.selectionText.textContent = this.#identity(observation,index,field,isOrderableValue(x) ? formatScalar(x) : "No value");
        this.selection.hidden = false;
        this.zoomFeatureButton.hidden = false;
        this.zoomFeatureButton.disabled = false;
        for (const {circle,point} of this.pointElements) {
            const chosen = point.sourceIndex === index;
            if (chosen) circle.classList.add("is-selected");
            else circle.classList.remove("is-selected");
            circle.setAttribute("aria-pressed",String(chosen));
        }
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
        this.onPresentationChange(null);
        this.onVisibilityChange(false, false);
    }
}
