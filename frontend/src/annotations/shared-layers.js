/** Present received annotation GeoJSON as read-only layers in the normal map stack. */
import { parseAnnotationGeoJSON } from "./geojson.js";
import { DEFAULT_ANNOTATION_STYLE } from "./model.js";
import { createAnnotationLeafletLayer } from "./leaflet-layer.js";

export class SharedAnnotationLayers {
    /**
     * Connect received polygons to the existing annotation renderer.
     * @param {Object} options Rendering dependencies.
     * @param {Object} options.leaflet Leaflet namespace.
     * @param {Object} options.map Leaflet map.
     * @param {Object} options.mapLayers Neutral map-layer owner.
     * @param {Document} [options.document=globalThis.document] Browser document.
     */
    constructor({ leaflet, map, mapLayers, document = globalThis.document }) {
        Object.assign(this, { leaflet, map, mapLayers, document }); this.layers = new Map();
    }

    /**
     * Add or refresh a received layer, retaining its local visibility and drawing order.
     * @param {string} id Opaque contribution identity supplied by composition.
     * @param {string} label Contributor and layer name for the map list.
     * @param {Object} collection Polygon GeoJSON; validated at this presentation boundary.
     * @return {void}
     * @throws {Error} If received polygons are unsupported by the annotation renderer.
     */
    show(id, label, collection) {
        const imported = parseAnnotationGeoJSON(JSON.stringify(collection));
        const polygons = imported.polygons.map((polygon, index) => ({ ...polygon, id: String(index) }));
        const retained = this.layers.get(id);
        if (retained) {
            retained.annotation.polygons = polygons; retained.rendering.refresh();
            this.mapLayers.getRecord(retained.key).entry.label = label; this.mapLayers.render(); return;
        }
        const key = `local:shared-annotation:${id}`;
        const annotation = { id: key, name: label, polygons, filter: "", style: { ...DEFAULT_ANNOTATION_STYLE, notes: true } };
        const rendering = createAnnotationLeafletLayer(this.leaflet, this.map, annotation);
        const controls = this.document.createElement("details");
        controls.className = "annotation-layer-controls";
        const summary = this.document.createElement("summary"); summary.textContent = "Shared annotation details";
        const description = this.document.createElement("p"); description.textContent = "Read-only contribution. Its contributor edits the original layer. Visibility and labels here affect only your map.";
        controls.append(summary, description);
        for (const [property, text] of [["labels", "Show names"], ["notes", "Show notes"]]) {
            const wrapper = this.document.createElement("label"); wrapper.className = "annotation-field";
            const input = this.document.createElement("input"); input.type = "checkbox"; input.checked = annotation.style[property];
            input.addEventListener("change", () => { annotation.style[property] = input.checked; rendering.refresh(); });
            wrapper.append(input, this.document.createTextNode(text)); controls.append(wrapper);
        }
        const adapter = {
            createState: () => annotation,
            createLayer: () => rendering,
            snapshot: () => ({ datasetKind: "annotation", controls, canFilter: false, legend: null }),
            zoom: () => { const bounds = rendering.getBounds(); if (bounds.isValid()) this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 }); },
            info: () => { controls.open = true; },
            copyLayerForUndo: () => ({ sharedContribution: id }),
            removed: () => { rendering.release(); this.layers.delete(id); },
        };
        try {
            this.mapLayers.addLocal({ key, label, visible: true, opacity: 1 }, adapter);
            this.layers.set(id, { key, annotation, rendering, controls, adapter });
        } catch (error) {
            rendering.release();
            throw error;
        }
    }

    /**
     * Remove received layers no longer present in the current session.
     * @param {Set<string>} ids Authoritative contribution identities to retain.
     * @return {void}
     */
    retain(ids) {
        for (const [id, layer] of this.layers) if (!ids.has(id)) this.mapLayers.removeOwned(layer.adapter);
    }

    /**
     * Open this component's local label controls for a shared layer.
     * @param {string} key Map-layer identity.
     * @return {boolean} Whether this component handled the requested controls.
     */
    openControls(key) {
        const layer = [...this.layers.values()].find(layer => layer.key === key);
        if (!layer) return false;
        layer.controls.open = true; return true;
    }
}
