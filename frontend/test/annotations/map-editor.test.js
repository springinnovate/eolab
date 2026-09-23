import assert from "node:assert/strict";
import test from "node:test";
import { AnnotationMapEditor } from "../../src/annotations/map-editor.js";
import { AnnotationModel } from "../../src/annotations/model.js";

test("one editor forwards private text changes and explicit Save/Cancel intents", () => {
    const document = new EventTarget();
    document.defaultView = new EventTarget();
    document.createElement = tag => Object.assign(new EventTarget(), {
        tag, children: [], hidden: false,
        setAttribute() {}, append(...children) { this.children.push(...children); },
        focus() { document.activeElement = this; }, select() { this.selected = true; },
    });
    const mapElement = document.createElement("div");
    mapElement.ownerDocument = document;
    const map = { getContainer: () => mapElement, on() {} };
    const leaflet = { layerGroup: () => ({}), DomEvent: { disableClickPropagation() {}, disableScrollPropagation() {} } };
    const calls = [];
    const editor = new AnnotationMapEditor({ leaflet, map, labelLayout: { register() {} },
        onAdd() {}, onInsert() {}, onMove() {}, onDelete() {}, onCloseOutline() {},
        onSave: another => calls.push(["save", another]), onCancel: () => calls.push(["cancel"]),
        onTextChange: (...text) => calls.push(["draft", ...text]),
    });
    editor.draft = { polygon: { name: "Polygon 1", note: "" } };
    editor.focusTextField("name");
    assert.equal(document.activeElement, editor.polygonName);
    assert.equal(editor.polygonName.selected, true);
    assert.equal(editor.polygonName.maxLength, 160);
    assert.equal(editor.polygonNote.maxLength, 10000);
    editor.polygonName.value = "Corridor"; editor.polygonNote.value = "Keep connected";
    editor.polygonNote.dispatchEvent(new Event("input"));
    assert.deepEqual(calls, [["draft", "Corridor", "Keep connected"]]);
    editor.saveAndDraw.dispatchEvent(new Event("click"));
    editor.save.dispatchEvent(new Event("click"));
    const escape = new Event("keydown", { cancelable: true });
    escape.key = "Escape"; document.dispatchEvent(escape);
    const enter = new Event("keydown", { cancelable: true }); enter.key = "Enter"; enter.ctrlKey = true;
    editor.strip.dispatchEvent(enter);
    assert.deepEqual(calls.slice(1), [["save", true], ["save", false], ["cancel"], ["save", false]]);
    assert.equal(enter.defaultPrevented, true);
    assert.equal(escape.defaultPrevented, true);
    editor.focusTextField("note");
    assert.equal(document.activeElement, editor.polygonNote);
});

/**
 * Supply the small Leaflet projection and point contract used by polygon dragging.
 * @param {number} x Horizontal coordinate.
 * @param {number} y Vertical coordinate.
 * @return {Object} Immutable point with vector addition and subtraction.
 */
function point(x, y) {
    return { x, y, add: other => point(x + other.x, y + other.y),
        subtract: other => point(x - other.x, y - other.y) };
}

/**
 * Exercise drag gestures against an isolated model draft and a small Leaflet double.
 * @param {boolean} [mapDragging=true] Existing map-pan preference.
 * @return {Object} Gesture subject, saved model, capture target and map-pan state.
 */
function setup(mapDragging = true) {
    const model = new AnnotationModel([], () => "test-id");
    const layer = model.createLayer();
    model.beginPolygon(layer.id);
    [[1, 1], [3, 1], [2, 3]].forEach(vertex => model.addVertex(vertex));
    const polygon = model.savePolygon();
    model.beginPolygon(layer.id, polygon.id);
    let captured = null;
    const target = { setPointerCapture: id => { captured = id; },
        hasPointerCapture: id => captured === id,
        releasePointerCapture: () => { captured = null; } };
    const editor = Object.create(AnnotationMapEditor.prototype);
    editor.labelLayout = { schedule() {} };
    editor.draft = model.draft;
    editor.polygonDrag = null;
    editor.map = { getZoom: () => 5,
        mouseEventToContainerPoint: event => point(event.clientX, event.clientY),
        project: ([lat, lng]) => point(lng * 10, lat * 10),
        unproject: position => ({ lng: position.x / 10, lat: position.y / 10 }),
        dragging: { enabled: () => mapDragging, disable: () => { mapDragging = false; }, enable: () => { mapDragging = true; } },
        getContainer: () => ({ classList: { add() {}, remove() {} } }) };
    editor.vertexMarkers = model.draft.polygon.vertices.map(() => ({ setLatLng() {} }));
    editor.style = { labels: false, notes: false };
    const shape = { setLatLngs() {}, unbindTooltip() {} };
    const event = (x, y) => ({ pointerId: 7, button: 0, isPrimary: true,
        currentTarget: target, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} });
    return { model, editor, target, shape, event, panEnabled: () => mapDragging };
}

test("interior dragging translates the draft as a whole and leaves saved geometry untouched", () => {
    const { model, editor, target, shape, event, panEnabled } = setup();
    const saved = model.document();
    editor.startPolygonDrag(event(100, 100), shape);
    assert.equal(panEnabled(), false);
    assert.equal(target.hasPointerCapture(7), true);
    editor.movePolygon(event(120, 130));
    assert.deepEqual(model.draft.polygon.vertices, [[3, 4], [5, 4], [4, 6]]);
    assert.deepEqual(model.document(), saved);
    editor.finishPolygonDrag(false);
    assert.equal(target.hasPointerCapture(7), false);
    assert.equal(panEnabled(), true);
    assert.equal(editor.suppressClick, true);
    assert.deepEqual(model.savePolygon().vertices, [[3, 4], [5, 4], [4, 6]]);
});

test("canceling a drag restores its starting vertices without enabling disabled map panning", () => {
    const { model, editor, shape, event, panEnabled } = setup(false);
    const original = structuredClone(model.draft.polygon.vertices);
    editor.startPolygonDrag(event(10, 10), shape);
    editor.movePolygon(event(30, 40));
    editor.finishPolygonDrag(true);
    assert.deepEqual(model.draft.polygon.vertices, original);
    assert.equal(panEnabled(), false);
    editor.finishPolygonDrag(true);
});

test("a click or another pointer cannot accidentally move the polygon", () => {
    const { model, editor, shape, event } = setup();
    const original = structuredClone(model.draft.polygon.vertices);
    editor.startPolygonDrag({ ...event(10, 10), button: 2 }, shape);
    assert.equal(editor.polygonDrag, null);
    editor.startPolygonDrag(event(10, 10), shape);
    editor.movePolygon({ ...event(100, 100), pointerId: 9 });
    editor.movePolygon(event(11, 11));
    assert.deepEqual(model.draft.polygon.vertices, original);
    assert.equal(editor.polygonDrag.moved, false);
    editor.finishPolygonDrag(false);
});


/**
 * Provide screen-coordinate points for edge hit-testing, without a DOM or geographic projection.
 * @param {number} x Horizontal coordinate.
 * @param {number} y Vertical coordinate.
 * @return {Object} Point supporting Leaflet's distance contract.
 */
function screenPoint(x, y) {
    return { x, y, distanceTo: other => Math.hypot(x - other.x, y - other.y) };
}

/**
 * Connect edge selection to an identity projection and the closest-segment provider contract.
 * The real Leaflet implementation is also exercised in browser verification.
 * @param {number[][]} vertices Polygon vertices in test screen coordinates.
 * @return {AnnotationMapEditor} Editor that can identify insertions in the supplied ring.
 */
function edgeEditor(vertices) {
    const editor = Object.create(AnnotationMapEditor.prototype);
    editor.draft = { polygon: { vertices } };
    editor.map = { latLngToContainerPoint: ([lat, lng]) => screenPoint(lng, lat),
        containerPointToLatLng: point => ({ lng: point.x, lat: point.y }) };
    editor.leaflet = { LineUtil: { closestPointOnSegment(point, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const lengthSquared = dx * dx + dy * dy;
        const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
        return screenPoint(a.x + t * dx, a.y + t * dy);
    } } };
    return editor;
}

test("edge hit-testing snaps to the segment and includes the closing edge without moving the first vertex", () => {
    const editor = edgeEditor([[0, 0], [100, 0], [100, 100], [0, 100]]);
    assert.deepEqual(editor.findEdgeInsertion(screenPoint(35, 7)), { index: 1, position: [35, 0] });
    assert.deepEqual(editor.findEdgeInsertion(screenPoint(-6, 40)), { index: 4, position: [0, 40] });
    assert.equal(editor.findEdgeInsertion(screenPoint(50, 50)), null, "interior remains a whole-polygon drag target");
    assert.equal(editor.findEdgeInsertion(screenPoint(50, 11)), null, "preview only appears close to an edge");
    assert.equal(editor.findEdgeInsertion(screenPoint(0, 0)), null, "first vertex keeps its closing action");
    assert.equal(editor.findEdgeInsertion(screenPoint(90, 1)), null, "existing handles take priority");
    assert.equal(editor.findEdgeInsertion(screenPoint(120, 0)), null, "edge extensions are not insertions");
});

test("an unfinished line supports edge insertion but zero or one vertex has no edge", () => {
    for (const vertices of [[], [[0, 0]]]) assert.equal(edgeEditor(vertices).findEdgeInsertion(screenPoint(40, 0)), null);
    const editor = edgeEditor([[0, 0], [100, 0]]);
    assert.deepEqual(editor.findEdgeInsertion(screenPoint(40, -5)), { index: 1, position: [40, 0] });
    editor.draft = null;
    assert.equal(editor.findEdgeInsertion(screenPoint(40, 0)), null);
});
