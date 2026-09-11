/** Optional presentation of a catalog selection; never authorizes analysis. */
export class VectorSelectionOverlay {
    /**
     * @param {Object} map Leaflet map.
     * @param {Object} leaflet Leaflet public adapter.
     */
    constructor(map, leaflet) { this.map = map; this.leaflet = leaflet; this.sequence = 0; }

    /**
     * Request a bounded outline without delaying numeric selection activation.
     * @param {Object} area Validated selection response.
     * @return {Promise<void>} Presentation completion; failures leave no outline.
     */
    async load(area) {
        this.clear();
        const sequence = this.sequence;
        this.abort = new AbortController();
        try {
            const response = await fetch("/api/vector-sampling/outline", {
                method: "POST", signal: this.abort.signal,
                headers: { "Content-Type": "application/json" }, body: JSON.stringify(area.selection),
            });
            if (!response.ok) return;
            const value = await response.json();
            if (sequence !== this.sequence || value.geometry?.type !== "FeatureCollection") return;
            this.layer = this.leaflet.geoJSON(value.geometry, {
                style: { color: "#f59e0b", weight: 2, fillOpacity: 0.05 }, interactive: false,
            }).addTo(this.map);
        } catch { /* Optional outline failure never changes the analysis selection. */ }
    }

    /** Remove obsolete presentation and cancel its pending request. @return {void} */
    clear() {
        ++this.sequence;
        this.abort?.abort();
        if (this.layer) this.map.removeLayer(this.layer);
        this.layer = null;
    }
}
