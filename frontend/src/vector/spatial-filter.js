/** Bind spatial conditions to the selected map view and its currently applied filter. */
import { EMPTY_VECTOR_FILTER } from "./filter.js";

/** Keep the user's choices when saving or comparing views without retaining private read references.
 * @param {Object} filter Accepted filter or editor draft.
 * @return {Object} Field conditions and stable polygon-view IDs.
 */
export function viewFilter(filter) {
    return {...filter, rules: filter.rules.map(rule => rule.operator === "intersects"
        ? {operator: "intersects", layerId: rule.layerId} : rule)};
}

/** Show an empty view until all its saved polygon sources can be read.
 * @param {Object} filter Saved filter containing at least one spatial clause.
 * @return {Object} An empty selection, or the unrestricted view when filtering is disabled.
 */
export function waitingForPolygonLayer(filter) {
    const rule = filter.rules.find(condition => condition.operator === "intersects");
    return {enabled: filter.enabled, match: "all", rules: [{operator: "intersects", layerId: rule.layerId,
        source: {kind: "drawing", polygonArea: null}}]};
}

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
     */
    constructor({layers, upload, drawingGeometry, discard}) {
        Object.assign(this, {layers, upload, drawingGeometry, discard});
        this.drawings = new Map();
        this.followed = new Map();
    }

    /** Return the selected drawing geometry as an owned input, reusing an identical selection.
     * @param {Object} layer A committed drawing view.
     * @param {Object} filter Current filter, or all polygons for a drawing target.
     * @return {Promise<Object>} Opaque private drawing reference, including an empty view.
     * @throws {Error} If the device polygons could not be saved for the comparison.
     */
    async drawing(layer, filter) {
        const polygons = this.drawingGeometry(layer.polygons, filter);
        if (!polygons.length) return {kind: "drawing", polygonArea: null};
        const key = JSON.stringify([layer.key, filter === EMPTY_VECTOR_FILTER]);
        const signature = JSON.stringify(polygons);
        let entry = this.drawings.get(key);
        if (entry?.signature !== signature) {
            const previous = entry;
            entry = {signature, pending: this.upload(polygons)};
            this.drawings.set(key, entry);
            try { await entry.pending; }
            catch (error) { if (this.drawings.get(key) === entry) this.drawings.delete(key); throw error; }
            if (previous) void previous.pending.then(area => this.discard(area.polygonArea.id)).catch(() => {});
        }
        return {kind: "drawing", polygonArea: (await entry.pending).polygonArea};
    }

    /** Capture each chosen view's applied filter and reject references back to the target.
     * @param {string} key Target map-layer key.
     * @param {Object} filter Logical editor rules, including chosen polygon-view IDs.
     * @param {Set<string>} [ancestors] View keys on the current chain.
     * @return {Promise<Object>} Portable predicate with immutable original-source descriptors.
     * @throws {Error} If a chosen view disappeared or creates a circular filter.
     */
    async bind(key, filter, ancestors = new Set()) {
        if (ancestors.has(key)) throw new Error("Choose a polygon layer whose filter does not refer back to this layer.");
        const path = new Set(ancestors).add(key);
        const rules = [];
        for (const rule of filter.rules) {
            if (rule.operator !== "intersects") { rules.push(rule); continue; }
            const layer = this.layers().find(view => view.id === rule.layerId);
            if (!layer) throw new Error("The polygon layer is unavailable. Choose another layer.");
            const current = await this.bind(layer.key, layer.filter, path);
            const source = layer.selection ? {...layer.selection, filter: current} : await this.drawing(layer, layer.filter);
            rules.push({operator: "intersects", layerId: layer.id, source});
        }
        return {...filter, rules};
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
        const inputs = (filter, path) => viewFilter(filter).rules.map(rule => {
            if (rule.operator !== "intersects") return rule;
            const layer = layers.find(view => view.id === rule.layerId);
            if (!layer || path.has(layer.key)) return [rule.layerId, null];
            return [rule.layerId, layer.selection, layer.polygons, layer.filter.enabled, layer.filter.match,
                inputs(layer.filter, new Set(path).add(layer.key))];
        });
        for (const target of active) {
            const signature = JSON.stringify([viewFilter(target.filter), inputs(target.filter, new Set([target.key])),
                layers.find(layer => layer.key === target.key)?.polygons]);
            if (this.followed.get(target.key) === signature) continue;
            this.followed.set(target.key, signature);
            const current = () => this.followed.get(target.key) === signature;
            void target.update(target.filter, current);
        }
    }
}
