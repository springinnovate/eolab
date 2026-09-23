/** Independent Leaflet rendering for an annotation layer in the map stack. */
import { matchingAnnotationPolygons } from "./model.js";
import { updatePolygonLabel } from "./polygon-label.js";

/**
 * Create a local vector layer with the same opacity/order hooks as tiled layers.
 * @param {Object} leaflet Leaflet namespace.
 * @param {Object} map Leaflet map.
 * @param {import("./model.js").AnnotationLayer} annotation Annotation layer data.
 * @param {import("./polygon-label-layout.js").PolygonLabelLayout} labelLayout Map-local annotation label placement.
 * @return {Object} Leaflet layer supporting refresh, draft visibility, opacity and drawing order.
 */
export function createAnnotationLeafletLayer(leaflet, map, annotation, labelLayout) {
    // Leaflet accepts a pane element, so deleting a layer can release the pane too.
    const pane = leaflet.DomUtil.create("div", "leaflet-pane leaflet-annotation-pane", map.getPane("tilePane"));
    pane.style.pointerEvents = "none";
    const renderer = leaflet.svg({ pane });
    const group = leaflet.featureGroup();
    const shapes = new Map();
    let editingPolygon = null;
    let inspectedPolygon = null;
    let opacity = 1;
    labelLayout.register(group, () => opacity > 0 ? [...shapes.values()].map(({ shape }) => shape) : []);
    /**
     * Update retained shapes and labels without restarting tooltip fades while typing.
     * @return {void}
     */
    group.refresh = () => {
        const polygons = matchingAnnotationPolygons(annotation).filter(polygon => polygon.id !== editingPolygon);
        const visibleIds = new Set(polygons.map(polygon => polygon.id));
        for (const [id, { shape }] of shapes) {
            if (!visibleIds.has(id)) { group.removeLayer(shape); shapes.delete(id); }
        }
        for (const polygon of polygons) {
            let retained = shapes.get(polygon.id);
            if (!retained) {
                const shape = leaflet.polygon([], { pane, renderer, interactive: false });
                retained = { shape, vertices: null, projected: null, polygon };
                shapes.set(polygon.id, retained);
                group.addLayer(shape);
            }
            const { shape } = retained;
            if (retained.vertices !== polygon.vertices) {
                shape.setLatLngs(polygon.vertices.map(([lng, lat]) => [lat, lng]));
                retained.vertices = polygon.vertices;
                retained.projected = null;
            }
            retained.polygon = polygon;
            shape.setStyle({ color: annotation.style.outline, fillColor: polygon.contributorColor ?? annotation.style.color,
                weight: polygon.id === inspectedPolygon ? Math.max(3, annotation.style.weight + 2) : annotation.style.weight,
                dashArray: polygon.id === inspectedPolygon ? "6 4" : null, fillOpacity: annotation.style.fillOpacity });
            updatePolygonLabel(shape, polygon, annotation.style, map.getContainer().ownerDocument, pane);
        }
        labelLayout.schedule();
    };
    /**
     * Hide the saved polygon while the editor shows its draft and moving label.
     * @param {string|null} id Edited polygon, or null to show every saved polygon again.
     * @return {void}
     */
    group.setEditingPolygon = id => {
        if (editingPolygon === id) return;
        editingPolygon = id;
        group.refresh();
    };
    /**
     * Find saved polygons under a point in their drawing order, topmost first.
     * Project each ring once at a fixed zoom: panning/zooming cannot change inclusion.
     * Shapes stay non-interactive so coordinates, raster picking and dragging still receive map events.
     * @param {{lat:number,lng:number}} position Geographic pointer location.
     * @return {import("./model.js").AnnotationPolygon[]} Matching polygons; filtered and draft polygons are absent.
     */
    group.polygonsAt = position => {
        if (opacity === 0 || !map.hasLayer(group)) return [];
        const point = map.project(position, 0);
        return [...shapes.values()].reverse().filter(retained => {
            if (!retained.shape.getBounds().contains(position)) return false;
            retained.projected ??= retained.vertices.map(([lng, lat]) => map.project({ lng, lat }, 0));
            return pointInsideRing(point, retained.projected);
        }).map(retained => retained.polygon);
    };
    /**
     * Emphasize one inspected polygon without changing saved styling or drawing order.
     * @param {string|null} id Inspected polygon, or null to clear the highlight.
     * @return {void}
     */
    group.setInspectedPolygon = id => {
        if (inspectedPolygon === id) return;
        inspectedPolygon = id;
        group.refresh();
    };
    /** @param {number} value Layer opacity. @return {void} */
    group.setOpacity = value => { opacity = value; pane.style.opacity = String(value); labelLayout.schedule(); };
    /** @param {number} zIndex Position among individual map layers. @return {void} */
    group.setZIndex = zIndex => { pane.style.zIndex = String(zIndex); };
    /** Remove the layer's renderer and pane. @return {void} */
    group.release = () => { labelLayout.unregister(group); group.clearLayers(); shapes.clear(); map.removeLayer(renderer); pane.remove(); };
    group.refresh();
    return group;
}

/**
 * Test a simple ring in map-projected coordinates, including points on its edges.
 * @param {{x:number,y:number}} point Projected pointer.
 * @param {{x:number,y:number}[]} ring Projected, unclosed polygon ring.
 * @return {boolean} Whether the polygon contains or touches the point.
 */
function pointInsideRing(point, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j], b = ring[i];
        const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
        if (Math.abs(cross) < 1e-10 && point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x)
            && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y)) return true;
        if ((a.y > point.y) !== (b.y > point.y)
            && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}
