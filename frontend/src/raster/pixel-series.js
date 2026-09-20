/** Plot a retained map click across catalog rasters without depending on rendering. */
import { RasterPointSamplesController, MAXIMUM_POINT_SAMPLE_PARTICIPANTS } from "./point-samples.js";
import { isCanonicalWgs84Position } from "./geometry.js";

/**
 * Encode one CSV field, keeping user-supplied text from becoming a spreadsheet formula.
 * @param {string|number|null} value Text, a measured number, or a missing value.
 * @return {string} Quoted CSV field.
 */
function csvField(value) {
    let text = value == null ? "" : String(value);
    if (typeof value === "string" && /^[=+@\-\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
}

/** Own raster choices, point results and presentation settings for Raster series. */
export class RasterPixelSeriesController {
    /**
     * Connect the plot to the pixel reader and its own view.
     * @param {Object} options Collaborators.
     * @param {import("./point-samples.js").SampleRasterPoint} options.samplePoint Catalog pixel reader.
     * @param {import("./pixel-series-view.js").RasterPixelSeriesView} options.view Plot controls.
     * @param {()=>void} options.onClose Request that composition close this tool.
     */
    constructor({ samplePoint, view, onClose }) {
        this.view = view;
        this.sources = [];
        this.selectedKeys = new Set();
        this.position = null;
        this.snapshot = null;
        this.previousSnapshot = null;
        this.active = false;
        this.order = "map";
        this.direction = "forward";
        this.chartType = "line";
        this.sampler = new RasterPointSamplesController(samplePoint, snapshot => {
            if (snapshot === null) return;
            this.snapshot = snapshot;
            this.render();
        });
        view.bind({
            onClose,
            onSelect: (key, selected) => this.selectRaster(key, selected),
            onOrder: (order, direction) => {
                this.order = order; this.direction = direction; this.render();
            },
            onChartType: type => { this.chartType = type; this.render(); },
            onRetry: () => this.invalidateResults(),
            onDownload: () => view.downloadCsv(this.exportCsv()),
        });
        this.render();
    }

    /**
     * Update available catalog rasters, preserving user choices for retained sources.
     * Visible newly added rasters are selected by default. Hidden rasters remain selectable.
     * @param {{key:string,label:string,item:Object,visible:boolean}[]} sources Ordered catalog sources.
     * @return {void}
     */
    updateAvailableRasters(sources) {
        const oldKeys = new Set(this.sources.map(source => source.key));
        const oldSelection = [...this.selectedKeys].sort().join("\n");
        const newKeys = new Set(sources.map(source => source.key));
        this.selectedKeys = new Set([...this.selectedKeys].filter(key => newKeys.has(key)));
        for (const source of sources) {
            if (!oldKeys.has(source.key) && source.visible) this.selectedKeys.add(source.key);
        }
        this.sources = sources.map(source => ({ ...source }));
        if (oldSelection !== [...this.selectedKeys].sort().join("\n")) this.invalidateResults();
        else this.render();
    }

    /**
     * Remember a completed map click and refresh only while this tool is active.
     * Clicks outside the canonical map world clear the point instead of sending an invalid request.
     * @param {{longitude:number,latitude:number}} position Map click in WGS 84 degrees.
     * @return {void}
     */
    setPosition(position) {
        if (this.position?.longitude === position.longitude && this.position?.latitude === position.latitude) return;
        this.position = isCanonicalWgs84Position(position) ? Object.freeze({ ...position }) : null;
        this.invalidateResults();
    }

    /**
     * Start work when this panel becomes active; cancel unfinished work when it leaves.
     * Completed values and settings remain available when the panel is reopened.
     * @param {boolean} active Whether the tool is visible and active.
     * @return {void}
     */
    setActive(active) {
        if (this.active === active) return;
        this.active = active;
        if (!active) {
            if (this.snapshot?.samples.some(sample => sample.state === "loading")) this.snapshot = null;
            this.sampler.clear();
        } else if (!this.snapshot) this.sampleSelectedRasters();
        this.render();
    }

    /**
     * Include or exclude one raster and refresh the current click.
     * @param {string} key Available raster identity.
     * @param {boolean} selected Whether to include this raster.
     * @return {void}
     */
    selectRaster(key, selected) {
        if (!this.sources.some(source => source.key === key)) return;
        if (selected) this.selectedKeys.add(key);
        else this.selectedKeys.delete(key);
        this.invalidateResults();
    }

    /** Retain a completed previous plot while the new request replaces it. @return {void} */
    invalidateResults() {
        if (this.snapshot && this.snapshot.samples.every(sample => sample.state !== "loading")) {
            this.previousSnapshot = this.snapshot;
        }
        this.snapshot = null;
        this.sampler.clear();
        if (this.active) this.sampleSelectedRasters();
        else this.render();
    }

    /** Request selected pixels through the bounded point sampler. @return {void} */
    sampleSelectedRasters() {
        const sources = this.sources.filter(source => this.selectedKeys.has(source.key));
        if (!this.active || !this.position || !sources.length || sources.length > MAXIMUM_POINT_SAMPLE_PARTICIPANTS) {
            this.render();
            return;
        }
        this.sampler.sample(sources.map(source => ({ ...source, axis: null })), this.position);
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

    /** Present current results, with separate previous values while replacements are pending. @return {void} */
    render() {
        const sources = this.orderedSources();
        const byKey = new Map(this.snapshot?.samples.map(sample => [sample.key, sample]) ?? []);
        const rows = sources.map(source => ({
            ...source, state: this.snapshot ? "loading" : "waiting", value: null, errorMessage: "", ...byKey.get(source.key),
            label: source.label,
        }));
        const busy = !!this.snapshot && rows.some(row => row.state === "loading");
        const completed = rows.filter(row => row.state !== "loading").length;
        let message = !this.sources.length ? "Add raster layers to the map to plot their pixel values."
            : !sources.length ? "Select rasters to plot."
            : sources.length > MAXIMUM_POINT_SAMPLE_PARTICIPANTS ? `Select up to ${MAXIMUM_POINT_SAMPLE_PARTICIPANTS} rasters per plot; ${sources.length} are selected.`
            : !this.position ? "Click the map to plot values across these rasters."
            : !this.snapshot ? "Click the map or retry to read these pixels."
            : busy ? `Reading pixel values: ${completed} of ${rows.length} rasters complete.`
            : `${rows.filter(row => row.state === "value").length} of ${rows.length} rasters returned a pixel value.`;
        const previous = busy && !rows.some(row => row.state === "value") ? this.previousSnapshot : null;
        const previousByKey = new Map(previous?.samples.map(sample => [sample.key, sample]) ?? []);
        this.view.render({
            sources: this.sources.map(source => ({ ...source, selected: this.selectedKeys.has(source.key) })),
            rows, position: this.position, message, busy, chartType: this.chartType,
            previousRows: previous ? sources.map(source => ({ ...source, ...previousByKey.get(source.key), label: source.label })) : null,
            canDownload: !!this.snapshot && !busy && rows.length > 0,
            canRetry: !!this.position && sources.length > 0 && sources.length <= MAXIMUM_POINT_SAMPLE_PARTICIPANTS && !busy,
        });
    }

    /**
     * Export the current ordered results with catalog identities, click and missing-data states.
     * @return {string} CSV document, or an empty string when no completed result is available.
     */
    exportCsv() {
        if (!this.snapshot || this.snapshot.samples.some(row => row.state === "loading")) return "";
        const byKey = new Map(this.snapshot.samples.map(row => [row.key, row]));
        const lines = [["raster", "collection_id", "item_id", "longitude", "latitude", "value", "status", "error"]];
        for (const source of this.orderedSources()) {
            const row = byKey.get(source.key);
            lines.push([source.label, source.item.collection, source.item.id,
                this.snapshot.position.longitude, this.snapshot.position.latitude,
                row.value, row.state, row.errorMessage]);
        }
        return lines.map(line => line.map(csvField).join(",")).join("\r\n") + "\r\n";
    }
}

