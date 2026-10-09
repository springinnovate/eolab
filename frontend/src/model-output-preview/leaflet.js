/** Leaflet display adapters using the application's established raster and vector styles. */
import { getRasterStyleColor, getRasterStyleOpacity } from "../raster/style.js";

/** Paint a bounded raster display grid with the existing continuous/category style contracts.
 * @param {Object} data Checked raster preview.
 * @param {Object} appearance Normalized raster appearance.
 * @param {Document} documentContext Owning document.
 * @return {string} In-memory PNG data URL, never a public artifact URL.
 */
export function rasterPreviewImage(data, appearance, documentContext) {
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

/** Render one display-only raster or GeoJSON through the local map-layer protocol.
 * @param {Object} leaflet Leaflet namespace.
 * @param {Object} map Leaflet map.
 * @param {string} key Unique local layer identity.
 * @param {Object} data Bounded display data.
 * @param {Object} appearance Normalized raster appearance or solid vector style.
 * @param {Document} documentContext Owning document.
 * @return {Object} Leaflet-compatible wrapper with style, opacity and order updates.
 */
export function createArtifactPreviewLayer(leaflet, map, key, data, appearance, documentContext) {
    const paneName = `artifact-${key.replaceAll(":", "-")}`;
    const pane = map.createPane(paneName); pane.style.pointerEvents = "none";
    const bounds = [[data.bounds[1], data.bounds[0]], [data.bounds[3], data.bounds[2]]];
    let style = appearance;
    /** Translate the checked solid symbol to Leaflet without changing feature geometry.
     * @return {Object} Leaflet path presentation.
     */
    const vectorOptions = () => ({color: style.strokeColor, opacity: style.strokeOpacity, weight: style.strokeWidth,
        fillColor: style.fillColor, fillOpacity: style.fillOpacity, radius: (style.pointSize ?? 8) / 2, pane: paneName, interactive: false});
    const layer = data.kind === "raster"
        ? leaflet.imageOverlay(rasterPreviewImage(data, style, documentContext), bounds, {pane: paneName, interactive: false})
        : leaflet.geoJSON(data.geojson, {pane: paneName, interactive: false, style: vectorOptions,
            /** Draw a point with the standard symbol size and colors.
             * @param {Object} _feature Display-only feature. @param {Object} latlng Leaflet coordinate.
             * @return {Object} Noninteractive point symbol.
             */
            pointToLayer: (_feature, latlng) => leaflet.circleMarker(latlng, vectorOptions())});
    const PreviewLayer = leaflet.Layer.extend({
        /** Attach bounded display pixels. @param {Object} target Leaflet map. @return {void} */
        onAdd(target) { target.addLayer(layer); },
        /** Detach display pixels while retaining the bounded source for a visibility toggle.
         * @param {Object} target Leaflet map. @return {void}
         */
        onRemove(target) { target.removeLayer(layer); },
        /** Set whole-layer alpha. @param {number} opacity Unit opacity. @return {void} */
        setOpacity(opacity) { pane.style.opacity = String(opacity); },
        /** Place this local layer among catalog tiles. @param {number} index Drawing order. @return {void} */
        setZIndex(index) { pane.style.zIndex = String(index); },
        /** Apply a committed appearance immediately. @param {Object} next Normalized style. @return {void} */
        setAppearance(next) {
            style = next;
            if (data.kind === "raster") layer.setUrl(rasterPreviewImage(data, style, documentContext));
            else { layer.setStyle(vectorOptions()); layer.eachLayer(child => child.setRadius?.((style.pointSize ?? 8) / 2)); }
        },
        /** Zoom to the result extent. @return {void} */
        zoom() { map.fitBounds(bounds, {maxZoom: 15}); },
        /** Discard pixels and the pane after the map-layer owner detaches the wrapper. @return {void} */
        release() {
            map.removeLayer(this); pane.remove();
            // Leaflet has no pane-removal API. Delete only this adapter's unique
            // pane entry so repeated show/remove cycles cannot retain DOM nodes.
            delete map._panes[paneName];
        },
    });
    return new PreviewLayer();
}
