/** Show optional whole-layer benchmarks beside the selected feature values. */

import { getVectorLayerStatistics } from "./api.js";

/** @typedef {import("./inspection-observation.js").VectorInspectionObservation} VectorInspectionObservation */
/** @typedef {import("./api.js").VectorStatisticsSource} VectorStatisticsSource */
/** @typedef {import("./api.js").VectorFieldStatistics} VectorFieldStatistics */
/** @typedef {"mean"|"minimum"|"maximum"} Statistic */
/** @typedef {(id:string) => {selection:VectorStatisticsSource, fields:ReadonlyArray<{name:string}>}|null} DescribeStatisticsSource */
/** @typedef {{sourceId:string, source:VectorStatisticsSource|null, fields:string[]}} LayerToSummarize */
/** @typedef {{sourceId:string, summaries?:VectorFieldStatistics[], message?:string, failed?:boolean}} LayerStatistics */

/** @type {Readonly<Record<Statistic,string>>} */
const STATISTICS_LABELS = Object.freeze({ mean: "Mean", minimum: "Minimum", maximum: "Maximum" });

/** Own the statistic choices and source reads for one feature plot panel. */
export class VectorPlotStatistics {
    /**
     * Bind the layer statistics picker and its readouts.
     * @param {Document} documentContext Document containing the plot.
     * @param {string} prefix Owning plot ID.
     * @param {DescribeStatisticsSource} describeSource Resolve a retained view's original layer and numeric fields.
     */
    constructor(documentContext, prefix, describeSource) {
        this.document = documentContext;
        this.describeSource = describeSource;
        const element = suffix => documentContext.querySelector("#" + prefix + "-statistics" + suffix);
        this.button = element("-button");
        this.panel = element("");
        this.status = element("-status");
        this.results = element("-results");
        /** @type {[Statistic,HTMLInputElement][]} */
        this.choices = Object.keys(STATISTICS_LABELS).map(statistic => [statistic, element("-" + statistic)]);
        this.observations = [];
        /** @type {Map<string,string>} Current headings for pending and completed layer statistics. */
        this.layerLabels = new Map();
        this.fields = [];
        this.pending = null;
        this.completed = null;
        this.controls = new AbortController();
        for (const [, checkbox] of this.choices) {
            checkbox.addEventListener("change", () => this.#refresh(), { signal: this.controls.signal });
        }
        this.#refresh();
    }

    /**
     * Match the readout to an open plot's retained layers and chosen fields.
     * @param {ReadonlyArray<VectorInspectionObservation>} observations Observations in the open plot, or empty while closed or loading.
     * @param {string[]} fields Numeric fields chosen for the plot.
     * @return {void}
     */
    update(observations, fields) {
        this.observations = observations;
        this.fields = fields;
        this.#refresh();
    }

    /**
     * Read the benchmark columns that are currently enabled.
     * @return {Statistic[]} Enabled statistics in display order.
     */
    #selectedStatistics() {
        return this.choices.filter(([, checkbox]) => checkbox.checked).map(([statistic]) => statistic);
    }

    /** Load or show the current groups when there are enabled statistics. @return {void} */
    #refresh() {
        const statistics = this.#selectedStatistics();
        this.button.disabled = this.observations.length === 0 || this.fields.length === 0;
        this.panel.hidden = this.button.disabled || statistics.length === 0;
        this.layerLabels.clear();
        if (this.panel.hidden) {
            this.#cancelRead();
            if (this.completed?.layers.some(layer => layer.failed)) this.completed = null;
            return;
        }
        for (const {sourceId, layerLabel} of this.observations) this.layerLabels.set(sourceId, layerLabel);
        const layers = Array.from(this.layerLabels.keys(), sourceId => {
            const description = this.describeSource(sourceId);
            const available = new Set(description?.fields.map(({ name }) => name));
            return { sourceId, source: description?.selection ?? null, fields: this.fields.filter(field => available.has(field)) };
        });
        const key = JSON.stringify(layers);
        if (this.pending?.key !== key) this.#cancelRead();
        if (this.completed?.key === key) {
            this.#render(this.completed.layers, statistics);
        } else if (!this.pending) {
            this.status.textContent = "Reading whole-layer statistics…";
            this.results.replaceChildren();
            const pending = { key, controller: new AbortController() };
            this.pending = pending;
            void this.#read(layers, pending);
        }
    }

    /**
     * Read each layer independently and discard obsolete responses.
     * @param {LayerToSummarize[]} layers Sources and requested fields in display order.
     * @param {{key:string,controller:AbortController}} pending Active read identity.
     * @return {Promise<void>} Settles after the relevant results have been presented.
     */
    async #read(layers, pending) {
        const results = await Promise.all(layers.map(async ({ sourceId, source, fields }) => {
            if (!source) return { sourceId, message: "The original layer is unavailable." };
            if (fields.length === 0) return { sourceId, message: "This layer has none of the plotted numeric fields." };
            try {
                const summaries = await getVectorLayerStatistics(source, fields, pending.controller.signal);
                return { sourceId, summaries };
            } catch {
                return { sourceId, message: "Could not read whole-layer statistics.", failed: true };
            }
        }));
        if (this.pending !== pending) return;
        this.pending = null;
        this.completed = { key: pending.key, layers: results };
        this.#render(results, this.#selectedStatistics());
    }

    /**
     * Display completed benchmarks and per-layer messages without changing the chart.
     * @param {LayerStatistics[]} layers Completed results for the current plot.
     * @param {Statistic[]} statistics Enabled benchmark values.
     * @return {void}
     */
    #render(layers, statistics) {
        const documentContext = this.document;
        const groups = layers.map(({ sourceId, summaries, message }) => {
            const group = documentContext.createElement("div");
            const heading = documentContext.createElement("h4");
            heading.textContent = this.layerLabels.get(sourceId);
            group.append(heading);
            if (message) {
                const note = documentContext.createElement("p");
                note.textContent = message;
                group.append(note);
            }
            for (const summary of summaries ?? []) {
                const field = documentContext.createElement("h5");
                field.textContent = summary.field;
                group.append(field);
                if (summary.count === 0) {
                    const note = documentContext.createElement("p");
                    note.textContent = "No numeric values.";
                    group.append(note);
                    continue;
                }
                const values = documentContext.createElement("dl");
                for (const statistic of statistics) {
                    const row = documentContext.createElement("div");
                    const term = documentContext.createElement("dt");
                    const value = documentContext.createElement("dd");
                    term.textContent = STATISTICS_LABELS[statistic];
                    value.textContent = String(summary[statistic]);
                    row.append(term, value);
                    values.append(row);
                }
                group.append(values);
            }
            return group;
        });
        this.status.textContent = "";
        this.results.replaceChildren(...groups);
    }

    /** Stop any read that can no longer populate this panel. @return {void} */
    #cancelRead() {
        this.pending?.controller.abort();
        this.pending = null;
    }

    /** Release the picker listeners and cancel an outstanding read. @return {void} */
    destroy() {
        this.controls.abort();
        this.#cancelRead();
    }
}
