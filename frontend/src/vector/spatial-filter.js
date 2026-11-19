/** Bind spatial conditions to the selected map view and its currently applied filter. */
import { EMPTY_VECTOR_FILTER } from "./filter.js";
import { viewFilter, waitingForPolygonLayer } from "../selected-area.js";


/** Send an authorized original-source intersection request.
 * @param {"map"|"drawings"} operation Map filter or committed drawing membership.
 * @param {Object} body Captured path-free target and polygon source.
 * @param {AbortSignal} [signal] Aborts superseded map work.
 * @return {Promise<Object|number[]>} Map publication and counts, or matching drawing positions.
 * @throws {Error} When a source is unavailable or the comparison fails.
 */
export async function applySpatialFilter(operation, body, signal) {
    const response = await fetch(`/api/vector-filters/${operation}`, {method: "POST", credentials: "same-origin", cache: "no-store", signal,
        headers: {"Content-Type": "application/json", "X-EOLab-Processing": "1", "X-EOLab-Uploads": "1"}, body: JSON.stringify(body)});
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "Could not apply the polygon filter.");
    return result;
}

/** Read the current source of a map condition, including hidden and duplicated polygon views. */
export class SpatialFilterViews {
    /** @param {Object} options Dependencies supplied by browser composition.
     * @param {()=>Object[]} options.layers Eligible polygon views with stable IDs.
     * @param {(polygons:Object[])=>Promise<Object>} options.upload Save an exact committed drawing as a private input.
     * @param {(polygons:Object[],filter:Object)=>Object[]} options.drawingGeometry Select committed drawing polygons in source order.
     * @param {(id:string)=>Promise<void>} options.discard Release an obsolete private drawing input.
     * @param {()=>void} options.refresh Reapply active filters when a device-only input needs renewal.
     */
    constructor({layers, upload, drawingGeometry, discard, refresh}) {
        Object.assign(this, {layers, upload, drawingGeometry, discard, refresh});
        this.drawings = new Map();
        this.followed = new Map();
    }

    /** Reference selected polygons at their saved revision, or upload a device-only drawing.
     * @param {Object} layer A committed drawing view.
     * @param {Object} filter Current filter, or all polygons for a drawing target.
     * @return {Promise<Object>} Reference to the selected drawing features, including an empty view.
     * @throws {Error} If the device polygons could not be saved for the comparison.
     */
    async drawing(layer, filter) {
        if (layer.drawingSource) {
            const {id, revision, pending} = layer.drawingSource;
            if (pending) throw new Error("Save the drawing changes before using this layer as a filter.");
            return {kind: "drawing", polygonArea: {drawingLayerId: id, revision, featureIds: layer.selectedIds(filter)}};
        }
        const polygons = this.drawingGeometry(layer.polygons, filter);
        if (!polygons.length) return {kind: "drawing", polygonArea: null};
        const key = JSON.stringify([layer.key, filter === EMPTY_VECTOR_FILTER]);
        const signature = JSON.stringify(polygons);
        let entry = this.drawings.get(key);
        if (entry?.signature !== signature || Date.now() >= entry.renewAt) {
            const previous = entry;
            entry = {signature, pending: this.upload(polygons), renewAt: Date.now() + 23 * 60 * 60 * 1000};
            this.drawings.set(key, entry);
            try { await entry.pending; }
            catch (error) { if (this.drawings.get(key) === entry) this.drawings.delete(key); throw error; }
            if (this.drawings.get(key) === entry) {
                clearTimeout(previous?.timer);
                entry.timer = setTimeout(() => {
                    if (this.drawings.get(key) !== entry) return;
                    this.drawings.delete(key);
                    this.followed.clear();
                    this.refresh();
                }, Math.max(0, entry.renewAt - Date.now()));
            }
            if (previous) void previous.pending.then(area => this.discard(area.polygonArea.id)).catch(() => {});
        }
        return {kind: "drawing", polygonArea: (await entry.pending).polygonArea};
    }

    /** Capture each chosen view's applied filter and reject references back to the target.
     * @param {string} key Target map-layer key.
     * @param {Object} filter Logical editor rules, including chosen polygon-view IDs.
     * @param {Set<string>} [ancestors] View keys on the current chain.
     * @param {Object[]} [views] Polygon views captured for this edit.
     * @return {Promise<Object>} Portable predicate with immutable original-source descriptors.
     * @throws {Error} If a chosen view disappeared or creates a circular filter.
     */
    async bind(key, filter, ancestors = new Set(), views = this.layers()) {
        if (!filter.enabled) return waitingForPolygonLayer(viewFilter(filter));
        if (ancestors.has(key)) throw new Error("Choose a polygon layer whose filter does not refer back to this layer.");
        const path = new Set(ancestors).add(key);
        const rules = [];
        for (const rule of filter.rules) {
            if (rule.operator !== "intersects") { rules.push(rule); continue; }
            const layer = views.find(view => view.id === rule.layerId);
            if (!layer) throw new Error("The polygon layer is unavailable. Choose another layer.");
            const current = await this.bind(layer.key, layer.filter, path, views);
            const source = layer.selection ? {...layer.selection, filter: current} : await this.drawing(layer, layer.filter);
            if (!layer.selection && current.enabled && current.rules.some(condition => condition.operator === "intersects")) source.filter = current;
            rules.push({operator: "intersects", layerId: layer.id, source});
        }
        return {enabled: filter.enabled, match: filter.match, rules};
    }

    /** Refresh consumers after a source filter or committed drawing changes.
     * @param {Object[]} targets Retained targets with key, requested filter and a composed update callback.
     * @return {void}
     */
    follow(targets) {
        const active = targets.filter(target => target.filter.enabled && target.filter.rules.some(rule => rule.operator === "intersects"));
        const keys = new Set(active.map(target => target.key));
        for (const key of this.followed.keys()) if (!keys.has(key)) this.followed.delete(key);
        if (!active.length) return;
        const layers = this.layers();
        const inputs = (filter, path) => !filter.enabled ? [] : viewFilter(filter).rules.map(rule => {
            if (rule.operator !== "intersects") return rule;
            const layer = layers.find(view => view.id === rule.layerId);
            if (!layer || path.has(layer.key)) return [rule.layerId, null];
            const drawingMatches = layer.filter.matchingIds;
            return [rule.layerId, layer.selection, layer.drawingSource ?? layer.polygons, drawingMatches, layer.filter.enabled, layer.filter.match,
                inputs(layer.filter, new Set(path).add(layer.key))];
        });
        for (const target of active) {
            const layer = layers.find(view => view.key === target.key);
            const signature = JSON.stringify([viewFilter(target.filter), inputs(target.filter, new Set([target.key])),
                layer?.drawingSource ?? layer?.polygons]);
            if (this.followed.get(target.key) === signature) continue;
            this.followed.set(target.key, signature);
            const current = () => this.followed.get(target.key) === signature;
            void target.update(target.filter, current);
        }
    }
}
