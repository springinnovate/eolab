/** Optional display outlines for catalog or uploaded polygons; never authorizes analysis. */
import { vectorMapBounds } from "./leaflet.js";

/** Draw one replaceable, noninteractive polygon outline on a Leaflet map. */
export class VectorSelectionOverlay {
    /**
     * @param {Object} map Leaflet map.
     * @param {Object} leaflet Leaflet public adapter.
     */
    constructor(map, leaflet) { this.map = map; this.leaflet = leaflet; this.sequence = 0; }

    /**
     * Draw the selected polygons using their bounded display geometry.
     * @param {{selection:Object}} area Original source descriptor and feature filter.
     * @param {{fitBounds?:boolean}} [options] Zoom to the selected polygons' original bounds when requested.
     * @return {Promise<Object|undefined>} Displayed GeoJSON for other map previews, or undefined if unavailable or superseded.
     */
    async load(area, {fitBounds = false} = {}) {
        this.clear();
        const sequence = this.sequence;
        this.abort = new AbortController();
        try {
            const response = await fetch("/api/vector-sampling/outline", {
                method: "POST", signal: this.abort.signal,
                headers: { "Content-Type": "application/json",
                    ...(area.selection.uploadId || area.selection.filter.rules.some(rule => rule.operator === "intersects") ? {"X-EOLab-Uploads": "1"} : {}),
                    ...(area.selection.kind === "runArtifact" || area.selection.filter.rules.some(rule => rule.operator === "intersects") ? {"X-EOLab-Processing": "1"} : {}) },
                credentials: "same-origin", cache: "no-store", body: JSON.stringify(area.selection),
            });
            if (!response.ok) return;
            const value = await response.json();
            if (sequence !== this.sequence || value.geometry?.type !== "FeatureCollection") return;
            if (fitBounds && !value.geometry.features.length) return;
            this.layer = this.leaflet.geoJSON(value.geometry, {
                style: { color: "#f59e0b", weight: 2, fillOpacity: 0.05 }, interactive: false,
            }).addTo(this.map);
            if (fitBounds) this.map.fitBounds(vectorMapBounds(value.bbox), {padding: [24, 24], maxZoom: 14});
            return value.geometry;
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
