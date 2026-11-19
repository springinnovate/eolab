/** Edit one original GeoPackage polygon in a private browser draft. */

import {readPolygonEdit, savePolygonEdit} from "./api.js";

const MAX_VERTICES = 2000;
const EDGE_DISTANCE = 12;
const VERTEX_CLEARANCE = 14;
const MAP_LATITUDE_LIMIT = 85.05112878;

/** @typedef {{part:number,ring:number,index:number}} VertexIndex */
/** @typedef {{position:[number,number],original:number|null}} Vertex */
/** @typedef {{featureId:string,parts:Vertex[][][],saveId:string,dirty:boolean}} PolygonDraft */
/**
 * @typedef {Object} PolygonEditTarget
 * @property {string} key Retained map view.
 * @property {string} label Layer name for the editor and saved copy.
 * @property {Object} source Authorized original source and applied filter.
 * @property {()=>boolean} isCurrent Whether the same view and predicate remain applicable.
 * @property {(upload:import("../uploads/api.js").VectorUpload, signal:AbortSignal)=>Promise<void>} showSavedCopy Install the newly admitted source.
 */

/** Own the vertex overlay and its draft until the user saves or cancels. */
export class PolygonGeometryEditor {
    /**
     * Install the map gestures without taking over any input until a layer is selected.
     * @param {Object} options Editor dependencies.
     * @param {Object} options.leaflet Leaflet namespace.
     * @param {Object} options.map Leaflet map.
     * @param {(editing:boolean,key:string)=>void} options.onEditingChange Composition-owned map mode and return focus.
     */
    constructor({leaflet, map, onEditingChange}) {
        this.leaflet = leaflet;
        this.map = map;
        this.onEditingChange = onEditingChange;
        this.container = map.getContainer();
        this.document = this.container.ownerDocument;
        this.overlay = leaflet.layerGroup();
        this.session = null;
        this.selected = null;
        this.hovered = null;
        this.markers = [];
        this.dragging = false;

        this.strip = this.document.createElement("section");
        this.strip.className = "vector-geometry-editor";
        this.strip.hidden = true;
        this.strip.setAttribute("aria-label", "Polygon geometry editor");
        this.heading = this.document.createElement("strong");
        this.status = this.document.createElement("p");
        this.status.setAttribute("role", "status");
        this.notice = this.document.createElement("p");
        this.notice.textContent = "Each save uses one private file slot for seven days.";
        this.error = this.document.createElement("p");
        this.error.className = "vector-geometry-error";
        this.error.setAttribute("role", "alert");
        this.choices = this.document.createElement("select");
        this.choices.setAttribute("aria-label", "Polygon at the selected position");
        this.choices.addEventListener("change", () => {
            if (this.choices.value) void this.read({featureId: this.choices.value});
        });
        this.actions = this.document.createElement("div");
        this.actions.className = "vector-geometry-actions";
        this.save = this.button("Save changes", () => void this.commit());
        this.cancel = this.button("Cancel", () => this.close());
        this.remove = this.button("Remove vertex", () => this.removeVertex(this.selected));
        this.actions.append(this.save, this.cancel, this.remove);
        this.strip.append(this.heading, this.status, this.choices, this.notice, this.actions, this.error);
        leaflet.DomEvent.disableClickPropagation(this.strip);
        leaflet.DomEvent.disableScrollPropagation(this.strip);
        this.container.append(this.strip);

        this.click = event => this.clickMap(event);
        this.pointer = event => this.previewEdge(event);
        this.clearPreview = () => this.clearEdgePreview();
        this.keydown = event => this.handleKey(event);
        this.map.on("click", this.click);
        this.map.on("movestart zoomstart", this.clearPreview);
        this.container.addEventListener("pointermove", this.pointer);
        this.container.addEventListener("pointerleave", this.clearPreview);
        this.document.addEventListener("keydown", this.keydown, true);
        this.map.once("unload", () => this.dispose());
    }

    /** Return the retained view being edited, or null. @return {string|null} */
    get key() { return this.session?.target.key ?? null; }

    /**
     * Create a labeled editor action.
     * @param {string} text Visible button label.
     * @param {()=>void} action Behavior when activated.
     * @return {HTMLButtonElement} Button for the editing strip.
     */
    button(text, action) {
        const button = this.document.createElement("button");
        button.type = "button";
        button.textContent = text;
        button.addEventListener("click", action);
        return button;
    }

    /**
     * Enter geometry editing for a single retained vector view.
     * @param {PolygonEditTarget} target Editable view and its ordinary source installation callback.
     * @return {void}
     */
    open(target) {
        if (this.session) return;
        this.session = {target, draft: null, operation: null, saving: false, upload: null, worldOffset: 0};
        this.heading.textContent = "Edit geometry · " + target.label;
        this.status.textContent = "Click a polygon in this layer to edit its vertices.";
        this.error.textContent = "";
        this.choices.hidden = true;
        this.strip.hidden = false;
        this.overlay.addTo(this.map);
        this.onEditingChange(true, target.key);
        this.renderActions();
        this.cancel.focus();
    }

    /** Discard the local draft and restore the prior map tool. @return {void} */
    close() {
        const session = this.session;
        if (!session) return;
        this.session = null;
        session.operation?.abort();
        this.strip.hidden = true;
        this.overlay.clearLayers();
        this.overlay.remove();
        this.shape = null;
        this.hint = null;
        this.markers = [];
        this.selected = this.hovered = null;
        this.dragging = false;
        this.onEditingChange(false, session.target.key);
    }

    /** Release listeners and layers when the map closes. @return {void} */
    dispose() {
        this.close();
        this.map.off("click", this.click);
        this.map.off("movestart zoomstart", this.clearPreview);
        this.container.removeEventListener("pointermove", this.pointer);
        this.container.removeEventListener("pointerleave", this.clearPreview);
        this.document.removeEventListener("keydown", this.keydown, true);
        this.strip.remove();
    }

    /**
     * Pick a feature before editing, or insert a vertex on an active ring.
     * @param {{latlng:Object,containerPoint:Object}} event Completed Leaflet map click.
     * @return {void}
     */
    clickMap(event) {
        const session = this.session;
        if (!session || session.saving || session.upload) return;
        if (session.draft) {
            const edge = this.nearestEdge(event.containerPoint);
            if (edge) this.addVertex(edge.index, edge.position);
            return;
        }
        const position = this.map.wrapLatLng(event.latlng);
        if (Math.abs(position.lat) > MAP_LATITUDE_LIMIT) return;
        session.worldOffset = event.latlng.lng - position.lng;
        void this.read({point: [position.lng, position.lat]});
    }

    /**
     * Load the authorized original rings or disambiguate overlapping polygons.
     * @param {{point:[number,number]}|{featureId:string}} target Coordinate or selected native ID.
     * @return {Promise<void>} Completion after the active edit session receives its result.
     */
    async read(target) {
        const session = this.session;
        if (!session.target.isCurrent()) {
            this.error.textContent = "The layer or its filter changed. Open Edit geometry again.";
            return;
        }
        session.operation?.abort();
        const operation = session.operation = new AbortController();
        this.error.textContent = "";
        this.choices.disabled = true;
        this.status.textContent = "Loading polygon…";
        try {
            const result = await readPolygonEdit(session.target.source, target, operation.signal);
            if (this.session !== session || operation.signal.aborted) return;
            this.choices.hidden = result.featureIds.length < 2;
            if (result.feature) {
                session.draft = {featureId: result.feature.featureId, saveId: crypto.randomUUID(), dirty: false,
                    parts: result.feature.parts.map(part => part.map(ring => ring.map((position, original) => ({position, original}))))};
                this.status.textContent = "Drag a vertex or click an edge to add one. Hover or focus a vertex and press Delete to remove it.";
                this.drawDraft();
                this.markers[0].marker.getElement().focus({preventScroll: true});
                this.renderActions();
            } else if (result.featureIds.length) {
                const prompt = new Option("Choose a polygon", "", true, true);
                prompt.disabled = true;
                this.choices.replaceChildren(prompt, ...result.featureIds.map(id => new Option("Polygon " + id, id)));
                this.status.textContent = "Several polygons overlap here.";
                this.choices.disabled = false;
                this.choices.focus();
            } else {
                this.status.textContent = "Click inside a polygon visible in this layer’s filter.";
                if ("featureId" in target) this.error.textContent = "That polygon is no longer in the selected view.";
            }
        } catch (error) {
            if (this.session !== session || operation.signal.aborted) return;
            this.status.textContent = "Choose a polygon to edit.";
            this.error.textContent = error.message;
        } finally {
            if (session.operation === operation) session.operation = null;
            if (this.session === session && !this.choices.hidden) this.choices.disabled = false;
        }
    }

    /**
     * Convert WGS84 coordinates into the map's visible copy of the world.
     * @param {[number,number]} position Longitude and latitude.
     * @return {[number,number]} Leaflet latitude and possibly wrapped longitude.
     */
    mapPosition([longitude, latitude]) {
        return [latitude, longitude + this.session.worldOffset];
    }

    /**
     * Convert a map handle to canonical coordinates without changing the native draft.
     * @param {{lat:number,lng:number}} position Leaflet handle position.
     * @return {[number,number]|null} Longitude and latitude, or null outside the editable map.
     */
    editPosition({lat, lng}) {
        const longitude = lng - this.session.worldOffset;
        if (Math.abs(longitude) > 180 || Math.abs(lat) > MAP_LATITUDE_LIMIT) return null;
        return [longitude, lat];
    }

    /**
     * Return the current vertices in one ring.
     * @param {VertexIndex} index Part and ring identifier.
     * @return {Vertex[]} Open ring from the browser draft.
     */
    ring({part, ring}) { return this.session.draft.parts[part][ring]; }

    /** Replace draft outlines and vertex handles after inserting or deleting a vertex. @return {void} */
    drawDraft() {
        this.overlay.clearLayers();
        this.markers = [];
        this.hint = null;
        this.hovered = null;
        this.shape = this.leaflet.polygon([], {
            color: "#00756e", weight: 3, fillOpacity: 0.20, interactive: false, smoothFactor: 0,
        }).addTo(this.overlay);
        this.session.draft.parts.forEach((part, p) => part.forEach((ring, r) => {
            ring.forEach((vertex, index) => this.addHandle(vertex, {part: p, ring: r, index}));
        }));
        this.paintShape();
    }

    /**
     * Add one draggable and keyboard-operable vertex marker.
     * @param {Vertex} vertex Original or revised draft vertex.
     * @param {VertexIndex} index Its current address in the draft.
     * @return {void}
     */
    addHandle(vertex, index) {
        const marker = this.leaflet.marker(this.mapPosition(vertex.position), {
            draggable: true, keyboard: true, bubblingMouseEvents: false, zIndexOffset: 1000,
            icon: this.leaflet.divIcon({
                className: "vector-geometry-handle", iconSize: [30, 30], iconAnchor: [15, 15],
            }),
        }).addTo(this.overlay);
        const handle = marker.getElement();
        handle.setAttribute("aria-label",
            "Vertex " + (index.index + 1) + ", ring " + (index.ring + 1) + ", part " + (index.part + 1));
        handle.addEventListener("pointerenter", () => {
            this.hovered = index;
            this.clearEdgePreview();
        });
        handle.addEventListener("pointerleave", () => { if (this.hovered === index) this.hovered = null; });
        handle.addEventListener("focus", () => this.selectVertex(index));
        handle.addEventListener("keydown", event => this.moveWithKeyboard(event, index));
        marker.on("click", event => {
            this.leaflet.DomEvent.stopPropagation(event);
            this.selectVertex(index);
            handle.focus({preventScroll: true});
        });
        marker.on("dragstart", () => {
            this.dragging = true;
            this.clearEdgePreview();
            this.selectVertex(index);
        });
        marker.on("drag", () => this.paintShape(index, this.editPosition(marker.getLatLng())));
        marker.on("dragend", () => {
            this.dragging = false;
            const position = this.editPosition(marker.getLatLng());
            this.moveVertex(index, position);
            marker.setLatLng(this.mapPosition(vertex.position));
        });
        this.markers.push({marker, index});
    }

    /**
     * Repaint the shape, optionally with the live position of a dragged handle.
     * @param {VertexIndex|null} [moving=null] Handle currently moving.
     * @param {[number,number]|null} [position=null] Valid current drag position.
     * @return {void}
     */
    paintShape(moving = null, position = null) {
        this.shape.setLatLngs(this.session.draft.parts.map((part, p) => part.map((ring, r) =>
            ring.map((vertex, index) => this.mapPosition(position && moving.part === p &&
                moving.ring === r && moving.index === index ? position : vertex.position))
        )));
    }

    /**
     * Move an active vertex four screen pixels or insert on its following edge.
     * @param {KeyboardEvent} event Focused handle's key press.
     * @param {VertexIndex} index Focused vertex.
     * @return {void}
     */
    moveWithKeyboard(event, index) {
        if (this.session.saving || this.session.upload) return;
        const movement = {
            ArrowLeft: [-4, 0], ArrowRight: [4, 0], ArrowUp: [0, -4], ArrowDown: [0, 4],
        }[event.key];
        if (!movement && event.key !== "Insert") return;
        event.preventDefault();
        event.stopPropagation();
        const ring = this.ring(index);
        const point = this.map.latLngToContainerPoint(this.mapPosition(ring[index.index].position));
        if (movement) {
            this.moveVertex(index, this.editPosition(this.map.containerPointToLatLng(point.add(movement))));
            this.markers.find(entry => entry.index === index).marker.setLatLng(this.mapPosition(ring[index.index].position));
        } else {
            const next = this.map.latLngToContainerPoint(this.mapPosition(ring[(index.index + 1) % ring.length].position));
            const position = this.editPosition(this.map.containerPointToLatLng(point.add(next).divideBy(2)));
            if (position) this.addVertex({...index, index: index.index + 1}, position);
        }
    }

    /**
     * Give Delete to the hovered or focused vertex while the edit is active.
     * @param {KeyboardEvent} event Document key press.
     * @return {void}
     */
    handleKey(event) {
        if (!this.session?.draft || event.key !== "Delete" || event.repeat || this.dragging ||
            event.target?.closest?.("input, textarea, select, [contenteditable]")) return;
        const focused = event.target?.closest?.(".vector-geometry-handle");
        const vertex = this.hovered ?? (focused ? this.selected : null);
        if (!vertex) return;
        event.preventDefault();
        event.stopPropagation();
        this.removeVertex(vertex);
    }

    /**
     * Find the nearest ring edge within a small pixel tolerance, clear of handles.
     * @param {Object} pointer Leaflet point relative to the map canvas.
     * @return {{index:VertexIndex,position:[number,number]}|null} Snapped insertion, including closing edges.
     */
    nearestEdge(pointer) {
        let nearest = null;
        let radius = EDGE_DISTANCE;
        const projected = this.session.draft.parts.map(part => part.map(ring =>
            ring.map(vertex => this.map.latLngToContainerPoint(this.mapPosition(vertex.position)))));
        if (projected.some(part => part.some(ring => ring.some(point => point.distanceTo(pointer) < VERTEX_CLEARANCE)))) return null;
        projected.forEach((part, p) => part.forEach((ring, r) => ring.forEach((start, index) => {
            const end = ring[(index + 1) % ring.length];
            const point = this.leaflet.LineUtil.closestPointOnSegment(pointer, start, end);
            const distance = pointer.distanceTo(point);
            if (distance > radius || point.distanceTo(start) < VERTEX_CLEARANCE ||
                point.distanceTo(end) < VERTEX_CLEARANCE) return;
            const position = this.editPosition(this.map.containerPointToLatLng(point));
            if (!position) return;
            radius = distance;
            nearest = {index: {part: p, ring: r, index: index + 1}, position};
        })));
        return nearest;
    }

    /**
     * Show a plus sign at the prospective insertion point without capturing clicks.
     * @param {PointerEvent} event Pointer movement in the map.
     * @return {void}
     */
    previewEdge(event) {
        if (!this.session?.draft || this.session.saving || this.session.upload || this.dragging ||
            event.buttons || event.pointerType === "touch" ||
            event.target.closest(".vector-geometry-editor, .vector-geometry-handle, .leaflet-control")) {
            this.clearEdgePreview();
            return;
        }
        const edge = this.nearestEdge(this.map.mouseEventToContainerPoint(event));
        if (!edge) {
            this.clearEdgePreview();
            return;
        }
        const position = this.mapPosition(edge.position);
        if (this.hint) this.hint.setLatLng(position);
        else this.hint = this.leaflet.marker(position, {
            interactive: false, keyboard: false, zIndexOffset: 900,
            icon: this.leaflet.divIcon({className: "vector-geometry-insert", html: "+", iconSize: [20, 20], iconAnchor: [10, 10]}),
        }).addTo(this.overlay);
    }

    /** Remove the insertion hint while keeping the draft. @return {void} */
    clearEdgePreview() {
        if (this.hint) this.overlay.removeLayer(this.hint);
        this.hint = null;
    }

    /**
     * Select one vertex and show its action state.
     * @param {VertexIndex} index Vertex selected by click or keyboard focus.
     * @return {void}
     */
    selectVertex(index) {
        this.selected = index;
        this.renderActions();
    }

    /**
     * Make a vertex change at its map position, retaining other native vertices.
     * @param {VertexIndex} index Vertex address.
     * @param {[number,number]|null} position Proposed map coordinates.
     * @return {void}
     */
    moveVertex(index, position) {
        if (!position) {
            this.error.textContent = "Keep the vertex within the editable map.";
            this.paintShape();
            return;
        }
        const vertex = this.ring(index)[index.index];
        if (vertex.position[0] === position[0] && vertex.position[1] === position[1]) return;
        vertex.position = position;
        vertex.original = null;
        this.draftChanged();
    }

    /**
     * Insert a new vertex before its ring index.
     * @param {VertexIndex} index Insertion position, including the closing edge.
     * @param {[number,number]} position Snapped longitude and latitude.
     * @return {void}
     */
    addVertex(index, position) {
        const count = this.session.draft.parts.reduce((total, part) =>
            total + part.reduce((subtotal, ring) => subtotal + ring.length, 0), 0);
        if (count >= MAX_VERTICES) {
            this.error.textContent = "This polygon already has 2,000 editable vertices.";
            return;
        }
        this.ring(index).splice(index.index, 0, {position, original: null});
        this.rebuildAfterChange(index);
    }

    /**
     * Remove one vertex while leaving at least three vertices in that ring.
     * @param {VertexIndex|null} index Selected or hovered vertex.
     * @return {void}
     */
    removeVertex(index) {
        if (!index || this.session.saving || this.session.upload || this.dragging) return;
        const ring = this.ring(index);
        if (ring.length <= 3) {
            this.error.textContent = "A ring needs at least three vertices.";
            return;
        }
        ring.splice(index.index, 1);
        this.rebuildAfterChange({...index, index: Math.min(index.index, ring.length - 1)});
    }

    /**
     * Rebuild edit handles after a ring changes length and focus the resulting vertex.
     * @param {VertexIndex} focus Address of the vertex to select.
     * @return {void}
     */
    rebuildAfterChange(focus) {
        this.selected = null;
        this.drawDraft();
        this.markers.find(({index}) => index.part === focus.part && index.ring === focus.ring &&
            index.index === focus.index).marker.getElement().focus({preventScroll: true});
        this.draftChanged();
    }

    /** Redraw a changed draft and allow it to be submitted. @return {void} */
    draftChanged() {
        this.session.draft.dirty = true;
        this.error.textContent = "";
        this.paintShape();
        this.renderActions();
    }

    /** Reflect the draft, selection and save state in the visible controls. @return {void} */
    renderActions() {
        const {draft, saving, upload} = this.session;
        this.save.disabled = saving || !draft?.dirty || this.dragging;
        this.save.textContent = upload ? "Retry showing layer" : "Save changes";
        this.cancel.textContent = upload ? "Close" : "Cancel";
        this.remove.hidden = !draft || Boolean(upload);
        this.remove.disabled = saving || !this.selected || this.ring(this.selected).length <= 3;
        this.notice.hidden = !draft || Boolean(upload);
        for (const {marker, index} of this.markers) {
            marker.getElement().setAttribute("aria-pressed", String(index === this.selected));
            if (saving || upload) marker.dragging.disable();
            else marker.dragging.enable();
        }
    }

    /**
     * Save the draft once, then show the ordinary private vector in the same view.
     * A failed map installation can be retried without creating another revision.
     * @return {Promise<void>} Completion after save, display, or an actionable error.
     */
    async commit() {
        const session = this.session;
        if (!session || this.save.disabled) return;
        if (!session.target.isCurrent() && !session.upload) {
            this.error.textContent = "The layer or its filter changed. Open Edit geometry again.";
            return;
        }
        const {target, draft} = session;
        const operation = session.operation = new AbortController();
        session.saving = true;
        this.status.textContent = session.upload ? "Showing the saved layer…" : "Saving a private copy…";
        this.error.textContent = "";
        this.clearEdgePreview();
        this.renderActions();
        try {
            if (!session.upload) {
                session.upload = await savePolygonEdit({
                    source: target.source, featureId: draft.featureId, saveId: draft.saveId,
                    name: [...target.label].slice(0, 160).join(""),
                    parts: draft.parts.map(part => part.map(ring => ring.map(vertex => vertex.original ?? vertex.position))),
                }, operation.signal);
            }
            if (this.session !== session || operation.signal.aborted) return;
            this.status.textContent = "Showing the saved layer…";
            await target.showSavedCopy(session.upload, operation.signal);
            if (this.session === session && !operation.signal.aborted) this.close();
        } catch (error) {
            if (this.session !== session || operation.signal.aborted) return;
            this.status.textContent = session.upload ? "Saved in Your uploads." : "Your changes are still open.";
            this.error.textContent = error.message;
        } finally {
            session.saving = false;
            if (session.operation === operation) session.operation = null;
            if (this.session === session) this.renderActions();
        }
    }
}
