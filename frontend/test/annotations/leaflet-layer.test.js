import assert from "node:assert/strict";
import test from "node:test";
import { createAnnotationLeafletLayer } from "../../src/annotations/leaflet-layer.js";
import { DEFAULT_ANNOTATION_STYLE } from "../../src/annotations/model.js";

/** @return {Object} Plain-text element double for the label content contract. */
function element() {
    return { children: [], style: {}, textContent: "", hidden: false,
        append(child) { this.children.push(child); },
        querySelector(selector) { return this.children.find(child => `.${child.className}` === selector); },
        remove() { this.removed = true; } };
}

/** @return {Object} Local annotation renderer with doubles for Leaflet's public layer methods. */
function setup() {
    const annotation = { filter: "", style: { ...DEFAULT_ANNOTATION_STYLE },
        polygons: [{ id: "polygon", name: "Riverbank", note: "Restore habitat", vertices: [[0, 0], [1, 0], [0, 1]] }] };
    const members = new Set();
    const panes = { tilePane: element(), tooltipPane: element() };
    const leaflet = { DomUtil: { create: (tag, className, parent) => {
        const pane = element(); parent.append(pane); return pane;
    } }, svg: () => ({}),
        featureGroup: () => ({ addLayer: shape => members.add(shape), removeLayer: shape => members.delete(shape), clearLayers: () => members.clear() }),
        polygon: () => ({ setLatLngs(vertices) { this.vertices = vertices; this.center = vertices[0]; }, setStyle(style) { this.style = style; },
            getBounds() { return { contains: ({ lng, lat }) => lng >= Math.min(...this.vertices.map(v => v[1])) && lng <= Math.max(...this.vertices.map(v => v[1]))
                && lat >= Math.min(...this.vertices.map(v => v[0])) && lat <= Math.max(...this.vertices.map(v => v[0])) }; },
            isTooltipOpen() { return !!this.tooltip; },
            getCenter() { return this.center; },
            getTooltip() { return this.tooltip; },
            bindTooltip(content, options) { this.tooltip = { options, getContent: () => content, setLatLng(position) { this.position = position; }, update() {} }; },
            unbindTooltip() { this.tooltip = undefined; } }) };
    const map = { getPane: name => panes[name], getContainer: () => ({ ownerDocument: { createElement: element } }), removeLayer() {},
        attached: true, hasLayer() { return this.attached; }, projections: 0,
        project({ lng, lat }, zoom) { assert.equal(zoom, 0); this.projections++; return { x: lng, y: Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) }; } };
    const labelLayout = { register(owner, polygons) { this.polygons = polygons; this.owner = owner; },
        schedule() { this.scheduled = true; }, unregister(owner) { assert.equal(owner, this.owner); this.released = true; } };
    return { annotation, members, map, labelLayout, rendering: createAnnotationLeafletLayer(leaflet, map, annotation, labelLayout) };
}

test("label layout sees filtered, visible saved polygons and releases removed renderers", () => {
    const { annotation, members, map, labelLayout, rendering } = setup();
    const polygonPane = map.getPane("tilePane").children[0];
    const labelPane = map.getPane("tooltipPane").children[0];
    assert.equal([...members][0].getTooltip().options.pane, labelPane);
    assert.equal(labelPane.style.pointerEvents, "none");
    rendering.setZIndex(300);
    assert.equal(polygonPane.style.zIndex, "300");
    assert.equal(labelPane.style.zIndex, "300");
    assert.deepEqual(labelLayout.polygons(), [...members]);
    rendering.setOpacity(0);
    assert.deepEqual(labelLayout.polygons(), []);
    rendering.setOpacity(0.5);
    assert.equal(polygonPane.style.opacity, "0.5");
    assert.equal(labelPane.style.opacity, "0.5");
    assert.deepEqual(labelLayout.polygons(), [...members]);
    annotation.filter = "absent";
    rendering.refresh();
    assert.deepEqual(labelLayout.polygons(), []);
    rendering.release();
    assert.equal(labelLayout.released, true);
    assert.equal(polygonPane.removed, true);
    assert.equal(labelPane.removed, true);
});

test("each polygon uses its contributor's color while opacity and outlines remain layer settings", () => {
    const { annotation, members, rendering } = setup();
    annotation.polygons[0].contributorColor = "#FF006E";
    annotation.polygons.push({ ...annotation.polygons[0], id: "peer", contributorColor: "#7CB518" });
    rendering.refresh();
    assert.deepEqual([...members].map(shape => shape.style.fillColor), ["#FF006E", "#7CB518"]);
    annotation.style.fillOpacity = 0.6; annotation.style.outline = "#123456";
    annotation.polygons[0].contributorColor = "#C77DFF";
    rendering.refresh();
    assert.deepEqual([...members].map(shape => shape.style.fillColor), ["#C77DFF", "#7CB518"]);
    assert.ok([...members].every(shape => shape.style.fillOpacity === 0.6 && shape.style.color === "#123456"));
});

test("text edits retain the same polygon and label instead of restarting tooltip fades", () => {
    const { annotation, members, rendering } = setup();
    const shape = [...members][0];
    const tooltip = shape.getTooltip();
    annotation.polygons[0].name = "Priority riverbank";
    rendering.refresh();
    assert.equal([...members][0], shape);
    assert.equal(shape.getTooltip(), tooltip);
    assert.equal(tooltip.getContent().querySelector(".annotation-polygon-name").textContent, "Priority riverbank");
    annotation.filter = "absent";
    rendering.refresh();
    assert.equal(members.size, 0);
    annotation.filter = "";
    rendering.refresh();
    assert.equal(members.size, 1);
    rendering.release();
    assert.equal(members.size, 0);
});

test("names and notes can each be shown alone, together, or hidden without blank labels", () => {
    const { annotation, members, rendering } = setup();
    const shape = [...members][0];
    let label = shape.getTooltip().getContent();
    assert.equal(label.querySelector(".annotation-polygon-name").hidden, false);
    assert.equal(label.querySelector(".annotation-polygon-note").hidden, true);
    annotation.style.notes = true;
    annotation.polygons[0].note = "<script>plain text</script>";
    rendering.refresh();
    assert.equal(label.querySelector(".annotation-polygon-note").textContent, "<script>plain text</script>");
    assert.equal(label.querySelector(".annotation-polygon-note").hidden, false);
    annotation.style.labels = false;
    rendering.refresh();
    assert.equal(label.querySelector(".annotation-polygon-name").hidden, true);
    assert.equal(label.querySelector(".annotation-polygon-note").hidden, false);
    annotation.style.notes = false;
    rendering.refresh();
    assert.equal(shape.getTooltip(), undefined);
    annotation.style.notes = true;
    annotation.polygons[0].note = "   ";
    rendering.refresh();
    assert.equal(shape.getTooltip(), undefined);
});

test("geometry updates relocate labels and editing hides only the saved copy", () => {
    const { annotation, members, rendering } = setup();
    const shape = [...members][0];
    annotation.polygons[0].vertices = [[10, 20], [11, 20], [10, 21]];
    rendering.refresh();
    assert.deepEqual(shape.getTooltip().position, [20, 10]);
    rendering.setEditingPolygon("polygon");
    assert.equal(members.size, 0);
    rendering.setEditingPolygon(null);
    assert.equal(members.size, 1);
    assert.deepEqual([...members][0].getTooltip().position, [20, 10]);
});

test("map hits follow projected polygon edges, include boundaries, and reuse projected vertices", () => {
    const { annotation, rendering, map } = setup();
    annotation.polygons[0].vertices = [[0, 0], [10, 0], [0, 80]];
    rendering.refresh();
    assert.equal(rendering.polygonsAt({ lng: 5, lat: 50 }).length, 1, "Mercator edge is above the geographic straight-line midpoint");
    const projections = map.projections;
    assert.equal(rendering.polygonsAt({ lng: 5, lat: 60 }).length, 0);
    assert.equal(map.projections, projections + 1, "only the pointer is projected on subsequent moves");
    assert.equal(rendering.polygonsAt({ lng: 0, lat: 80 }).length, 1, "vertices and edges are included");
    annotation.polygons[0].vertices = [[0, 0], [1, 0], [0, 1]];
    rendering.refresh();
    assert.equal(rendering.polygonsAt({ lng: 5, lat: 50 }).length, 0);
    assert.equal(rendering.polygonsAt({ lng: 0.1, lat: 0.1 }).length, 1);
});

test("hit order matches shape drawing order and excludes filtered, hidden, zero-opacity and draft polygons", () => {
    const { annotation, rendering, map, members } = setup();
    annotation.polygons.push({ ...annotation.polygons[0], id: "top", name: "Top" });
    rendering.refresh();
    const point = { lng: 0.1, lat: 0.1 };
    assert.deepEqual(rendering.polygonsAt(point).map(p => p.id), ["top", "polygon"]);
    rendering.setInspectedPolygon("polygon");
    assert.equal([...members][0].style.dashArray, "6 4");
    assert.deepEqual(rendering.polygonsAt(point).map(p => p.id), ["top", "polygon"], "highlight does not change hit order");
    rendering.setEditingPolygon("top");
    assert.deepEqual(rendering.polygonsAt(point).map(p => p.id), ["polygon"]);
    annotation.filter = "absent"; rendering.refresh();
    assert.deepEqual(rendering.polygonsAt(point), []);
    annotation.filter = ""; rendering.refresh();
    rendering.setOpacity(0);
    assert.deepEqual(rendering.polygonsAt(point), []);
    rendering.setOpacity(1); map.attached = false;
    assert.deepEqual(rendering.polygonsAt(point), []);
});
