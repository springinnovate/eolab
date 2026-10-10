/** Display-only GeoJSON output adapter using the established vector styles. */
/** Render one display-only GeoJSON through the local map-layer protocol.
 * @param {Object} leaflet Leaflet namespace.
 * @param {Object} map Leaflet map.
 * @param {string} key Unique local layer identity.
 * @param {Object} data Bounded display data.
 * @param {Object} appearance Normalized solid vector style.
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
    const layer = leaflet.geoJSON(data.geojson, {pane: paneName, interactive: false, style: vectorOptions,
            /** Draw a point with the standard symbol size and colors.
             * @param {Object} _feature Display-only feature. @param {Object} latlng Leaflet coordinate.
             * @return {Object} Noninteractive point symbol.
             */
            pointToLayer: (_feature, latlng) => leaflet.circleMarker(latlng, vectorOptions())});
    const PreviewLayer = leaflet.Layer.extend({
        /** Attach bounded display features. @param {Object} target Leaflet map. @return {void} */
        onAdd(target) { target.addLayer(layer); },
        /** Detach display features while retaining the bounded source for a visibility toggle.
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
            layer.setStyle(vectorOptions()); layer.eachLayer(child => child.setRadius?.((style.pointSize ?? 8) / 2));
        },
        /** Zoom to the result extent. @return {void} */
        zoom() { map.fitBounds(bounds, {maxZoom: 15}); },
        /** Discard features and the pane after the map-layer owner detaches the wrapper. @return {void} */
        release() {
            map.removeLayer(this); pane.remove();
            // Leaflet has no pane-removal API. Delete only this adapter's unique
            // pane entry so repeated show/remove cycles cannot retain DOM nodes.
            delete map._panes[paneName];
        },
    });
    return new PreviewLayer();
}
