/** Show optional whole-layer benchmarks beside the selected feature values. */

import { getVectorLayerStatistics } from "./api.js";

/** @typedef {import("./inspection-observation.js").VectorInspectionObservation} VectorInspectionObservation */
/** @typedef {import("./api.js").VectorStatisticsSource} VectorStatisticsSource */
/** @typedef {import("./api.js").VectorFieldStatistics} VectorFieldStatistics */
/** @typedef {"mean"|"minimum"|"maximum"} Statistic */
/** @typedef {(id:string) => {selection:VectorStatisticsSource, fields:ReadonlyArray<{name:string}>}|null} DescribeStatisticsSource */
/** @typedef {{summaries:VectorFieldStatistics[]}|{message:string}} LayerStatistics */
/** @typedef {{label:string, key:string}|{label:string, message:string}} PlotLayer */

// All displayed layers remain available. Keep only recent successful reads from other clicks.
const MAX_INACTIVE_LAYER_RESULTS = 32;

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
        this.fields = [];
        this.waitingForFeatures = false;
        /** @type {PlotLayer[]} Headings and request keys in the current map click's order. */
        this.layers = [];
        /** @type {Map<string,AbortController>} One active whole-layer read per request. */
        this.pending = new Map();
        /** @type {Map<string,LayerStatistics>} Finished reads ordered by most recent use. */
        this.completed = new Map();
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
     * @param {boolean} [waitingForFeatures=false] Keep existing reads until the next map click identifies its layers.
     * @return {void}
     */
    update(observations, fields, waitingForFeatures = false) {
        this.observations = observations;
        this.fields = fields;
        this.waitingForFeatures = waitingForFeatures;
        this.#refresh();
    }

    /**
     * Read the benchmark columns that are currently enabled.
     * @return {Statistic[]} Enabled statistics in display order.
     */
    #selectedStatistics() {
        return this.choices.filter(([, checkbox]) => checkbox.checked).map(([statistic]) => statistic);
    }

    /** Match displayed benchmarks and outstanding reads to the layers in the current click. @return {void} */
    #refresh() {
        const statistics = this.#selectedStatistics();
        this.button.disabled = this.observations.length === 0 || this.fields.length === 0;
        this.panel.hidden = this.button.disabled || statistics.length === 0;
        const labels = new Map();
        if (!this.panel.hidden) {
            for (const {sourceId, layerLabel} of this.observations) labels.set(sourceId, layerLabel);
        }
        const requested = new Set();
        this.layers = Array.from(labels, ([id, label]) => this.#prepareLayerStatistics(id, label, requested));
        const awaitingLayers = this.waitingForFeatures && this.fields.length > 0 && statistics.length > 0;
        if (!awaitingLayers) {
            for (const [key, controller] of this.pending) {
                if (!requested.has(key)) {
                    controller.abort();
                    this.pending.delete(key);
                }
            }
        }
        const inactive = [];
        for (const [key, result] of this.completed) {
            if (requested.has(key)) continue;
            if ("message" in result) this.completed.delete(key);
            else if (!awaitingLayers) inactive.push(key);
        }
        const excess = inactive.length - MAX_INACTIVE_LAYER_RESULTS;
        for (let index = 0; index < excess; index++) this.completed.delete(inactive[index]);
        if (this.panel.hidden) return;
        if (this.pending.size) {
            this.status.textContent = "Reading whole-layer statistics…";
            this.results.replaceChildren();
        } else {
            this.#render(statistics);
        }
    }

    /**
     * Resolve a visible layer's benchmark request and reuse its pending or completed read.
     * @param {string} id Retained vector view identity.
     * @param {string} label Current heading for this view.
     * @param {Set<string>} requested Request keys needed by the current plot.
     * @return {PlotLayer} Heading and result key, or a message when this layer cannot be read.
     */
    #prepareLayerStatistics(id, label, requested) {
        const description = this.describeSource(id);
        if (!description) return { label, message: "The original layer is unavailable." };
        const available = new Set(description.fields.map(({ name }) => name));
        const fields = this.fields.filter(field => available.has(field));
        if (!fields.length) return { label, message: "This layer has none of the plotted numeric fields." };
        const key = JSON.stringify([description.selection, fields]);
        requested.add(key);
        const result = this.completed.get(key);
        if (result) {
            this.completed.delete(key);
            this.completed.set(key, result);
        } else if (!this.pending.has(key)) {
            void this.#readLayer(key, description.selection, fields);
        }
        return { label, key };
    }

    /**
     * Read one original layer and display its statistics once the current plot's reads finish.
     * @param {string} key Identity of the source and ordered fields.
     * @param {VectorStatisticsSource} source Original catalog layer, upload or run result.
     * @param {string[]} fields Numeric fields in display order.
     * @return {Promise<void>} Settles after completion, failure or cancellation.
     */
    async #readLayer(key, source, fields) {
        const controller = new AbortController();
        this.pending.set(key, controller);
        /** @type {LayerStatistics} */
        let result;
        try {
            result = { summaries: await getVectorLayerStatistics(source, fields, controller.signal) };
        } catch {
            result = { message: "Could not read whole-layer statistics." };
        }
        if (controller.signal.aborted) return;
        this.pending.delete(key);
        if (!this.panel.hidden || "summaries" in result) this.completed.set(key, result);
        if (!this.pending.size && !this.panel.hidden) this.#render(this.#selectedStatistics());
    }

    /**
     * Display completed benchmarks and per-layer messages without changing the chart.
     * @param {Statistic[]} statistics Enabled benchmark values.
     * @return {void}
     */
    #render(statistics) {
        const documentContext = this.document;
        const groups = this.layers.map(layer => {
            const result = "key" in layer ? this.completed.get(layer.key) : layer;
            const group = documentContext.createElement("div");
            const heading = documentContext.createElement("h4");
            heading.textContent = layer.label;
            group.append(heading);
            if ("message" in result) {
                const note = documentContext.createElement("p");
                note.textContent = result.message;
                group.append(note);
                return group;
            }
            for (const summary of result.summaries) {
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

    /** Release the picker listeners, cached results and outstanding layer reads. @return {void} */
    destroy() {
        this.controls.abort();
        for (const controller of this.pending.values()) controller.abort();
        this.pending.clear();
        this.completed.clear();
    }
}
