/** Leaflet viewport adapter for owner-authorized raster display. */
import { getRasterStyleColor, getRasterStyleOpacity } from "./style.js";
import { readRasterMapWindow } from "./window-api.js";

/** Paint a bounded raster display grid with the existing continuous/category style contracts.
 * @param {Object} data Checked viewport grid.
 * @param {Object} appearance Normalized raster appearance.
 * @param {Document} documentContext Owning document.
 * @return {string} In-memory PNG data URL, never a public artifact URL.
 */
export function rasterWindowImage(data, appearance, documentContext) {
    const canvas = documentContext.createElement("canvas"); canvas.width = data.width; canvas.height = data.height;
    const context = canvas.getContext("2d"); const image = context.createImageData(data.width, data.height);
    const categories = new Map(appearance.categorical?.categories.map(row => [row.value, row]) ?? []);
    const style = appearance.continuous.definition;
    for (let index = 0; index < data.values.length; index++) {
        const value = data.values[index]; if (value === null) continue;
        const category = appearance.mode === "categorical" ? categories.get(value) ?? appearance.categorical.unmapped : null;
        const color = category?.color ?? getRasterStyleColor(style, value);
        const opacity = category?.opacity ?? getRasterStyleOpacity(style, value);
        const rgb = Number.parseInt(color.slice(1), 16);
        image.data.set([(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, Math.round(opacity * 255)], index * 4);
    }
    context.putImageData(image, 0, 0); return canvas.toDataURL("image/png");
}

/** Display a raster through the same layer/style lifecycle as catalog WMS layers.
 * @param {Object} leaflet Leaflet namespace.
 * @param {Object} map Owning map.
 * @param {Object} raster Source metadata, key and bounds.
 * @param {Object} appearance Shared normalized raster appearance.
 * @param {(message:string|null)=>void} onStatus Report display failure or recovery.
 * @param {Function} [read=readRasterMapWindow] Authorized viewport transport.
 * @param {Document} [documentContext=globalThis.document] Canvas factory.
 * @return {Object} Leaflet layer with bounded viewport reads and ordinary appearance methods.
 */
export function createRasterWindowLayer(leaflet, map, raster, appearance, onStatus, read = readRasterMapWindow, documentContext = globalThis.document) {
    const paneName = `raster-${raster.key.replaceAll(":", "-")}`;
    const pane = map.createPane(paneName); pane.style.pointerEvents = "none";
    let active = false, abort = null, overlay = null, data = null, style = appearance;
    let generation = 0;
    /** Discard display bytes and cancel a superseded viewport read. @return {void} */
    function clearWindow() {
        generation++; abort?.abort(); abort = null; data = null;
        if (overlay) map.removeLayer(overlay);
        overlay = null;
    }
    /** Color the current viewport using the shared continuous/category functions. @return {void} */
    function paint() {
        if (!active || !data) return;
        const image = rasterWindowImage(data, style, documentContext);
        if (overlay) overlay.setUrl(image);
        else overlay = leaflet.imageOverlay(image, [[data.bounds[1], data.bounds[0]], [data.bounds[3], data.bounds[2]]],
            {pane: paneName, interactive: false}).addTo(map);
    }
    /** Request fresh detail for the visible source intersection; reject obsolete responses.
     * @return {Promise<void>} Display completion or reported failure.
     */
    async function refresh() {
        clearWindow(); if (!active) return;
        const version = generation, viewport = map.getBounds(), extent = raster.bbox;
        const bounds = {west: Math.max(-180, viewport.getWest(), extent[0]), south: Math.max(-85.05112878, viewport.getSouth(), extent[1]),
            east: Math.min(180, viewport.getEast(), extent[2]), north: Math.min(85.05112878, viewport.getNorth(), extent[3])};
        if (bounds.west >= bounds.east || bounds.south >= bounds.north) { onStatus(null); layer.fire("load"); return; }
        const sw = map.project(leaflet.latLng(bounds.south, bounds.west)), ne = map.project(leaflet.latLng(bounds.north, bounds.east));
        const width = Math.max(1, Math.ceil(Math.abs(ne.x - sw.x))), height = Math.max(1, Math.ceil(Math.abs(ne.y - sw.y)));
        const scale = Math.min(1, 512 / Math.max(width, height));
        const window = {bounds, width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale))};
        const request = new AbortController(); abort = request; layer.fire("loading"); onStatus(null);
        try {
            for (let attempt = 0; ; attempt++) {
                try {
                    const received = await read(raster, window, request.signal);
                    if (version !== generation || request.signal.aborted || !active) return;
                    data = received; break;
                }
                catch (error) {
                    if (request.signal.aborted || error.status !== 429 || attempt >= 5) throw error;
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => { request.signal.removeEventListener("abort", cancel); resolve(); }, 250 * 2 ** attempt);
                        /** End capacity retry promptly when its viewport is superseded. @return {void} */
                        const cancel = () => { clearTimeout(timer); reject(request.signal.reason); };
                        request.signal.addEventListener("abort", cancel, {once: true});
                    });
                }
            }
            if (version !== generation || request.signal.aborted || !active) return;
            paint(); onStatus(null); layer.fire("load");
        } catch (error) {
            if (version !== generation || request.signal.aborted || !active) return;
            data = null; onStatus(`${error.message} Move or zoom the map to retry.`); layer.fire("tileerror", {error}); layer.fire("load");
        }
    }
    const RasterWindowLayer = leaflet.Layer.extend({
        /** Attach viewport listeners and load detail. @return {void} */
        onAdd() { active = true; map.on("movestart", clearWindow); map.on("moveend resize", refresh); void refresh(); },
        /** Stop requests and discard private display data on hide or removal. @return {void} */
        onRemove() { active = false; map.off("movestart", clearWindow); map.off("moveend resize", refresh); clearWindow(); },
        /** Change display opacity only. @param {number} opacity Unit alpha. @return {void} */
        setOpacity(opacity) { pane.style.opacity = String(opacity); },
        /** Match ordinary layer drawing order. @param {number} index Drawing index. @return {void} */
        setZIndex(index) { pane.style.zIndex = String(index); },
        /** Apply ordinary raster appearance without requesting data. @param {Object} next Checked appearance. @return {void} */
        setAppearance(next) { style = next; paint(); },
        /** Expose the container for the ordinary paired color blend. @return {Object} Pane. */
        getContainer() { return pane; },
        /** Retry the current visible window through fresh authorization. @return {void} */
        redraw() { void refresh(); },
        /** Detach private display data and its owned pane permanently. @return {void} */
        release() { map.removeLayer(this); clearWindow(); pane.remove(); delete map._panes[paneName]; },
    });
    const layer = new RasterWindowLayer();
    return layer;
}
