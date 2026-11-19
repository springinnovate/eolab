/** Present mutually exclusive map modes and capture a transient freehand selection. */

/** Map-tool controls and lasso drawing, independent of raster and vector implementations. */
export class MapInteractionTools {
    /**
     * Connect the tool strip, P/Escape keys and composition-supplied source choices.
     * @param {Object} options Map and UI dependencies.
     * @param {Document} options.documentContext Owning document.
     * @param {Object} options.map Leaflet map used to capture geographic positions.
     * @param {Object} options.leaflet Leaflet geometry and display adapter.
     * @param {()=>Array<{key:string,label:string,selection:Object}>} options.getTargets Retained vector views, including hidden views.
     * @param {(mode:string,enabled:boolean)=>void} options.onModeChange Composition coordinates independent tools; false suspends interaction during editing.
     * @param {(selection:Object,polygon:Object,signal:AbortSignal)=>Promise<Object>} options.selectFeatures Exact original-source selection API.
     */
    constructor({documentContext, map, leaflet, getTargets, onModeChange, selectFeatures}) {
        Object.assign(this, {document:documentContext, map, leaflet, getTargets, onModeChange, selectFeatures});
        this.root = documentContext.querySelector('#map-interaction-tools');
        this.buttons = [...this.root.querySelectorAll('[data-map-mode]')];
        this.controls = this.root.querySelector('#lasso-controls');
        this.layerSelect = this.root.querySelector('#lasso-layer');
        this.status = this.root.querySelector('#map-interaction-status');
        this.clearButton = this.root.querySelector('#clear-lasso-selection');
        this.container = map.getContainer();
        this.mode = 'pixel';
        this.editing = false;
        this.generation = 0;
        this.targetSignature = null;
        this.stroke = null;
        this.outline = null;
        this.highlight = null;
        this.abort = null;
        this.dragWasEnabled = null;
        this.selectionMessage = null;
        this.color = documentContext.defaultView?.getComputedStyle(this.root).getPropertyValue('--brand').trim() || '#007ac2';
        this.bindings = [];
        for (const button of this.buttons) this.listen(button, 'click', () => this.setMode(button.dataset.mapMode));
        this.listen(this.layerSelect, 'change', () => { this.clear(); this.refresh(); });
        this.listen(this.clearButton, 'click', () => { this.clear(); this.clearButton.hidden = true; });
        this.listen(this.container, 'pointerdown', event => this.beginStroke(event), true);
        this.listen(this.container, 'pointermove', event => this.moveStroke(event), true);
        this.listen(this.container, 'pointerup', event => this.finishStroke(event), true);
        this.listen(this.container, 'pointercancel', () => this.cancelStroke(), true);
        this.listen(this.container, 'lostpointercapture', () => this.cancelStroke(), true);
        this.listen(documentContext, 'keydown', event => {
            if ((event.key === 'p' || event.key === 'P') && !this.editing &&
                !event.ctrlKey && !event.metaKey && !event.altKey &&
                !event.target?.closest?.('input, textarea, select, [contenteditable]')) {
                event.preventDefault(); this.setMode('pixel'); return;
            }
            if (event.key !== 'Escape' || this.mode !== 'lasso' || this.editing) return;
            if (!this.stroke && !this.abort) return;
            event.preventDefault(); event.stopPropagation();
            this.cancelStroke(); this.abort?.abort(); this.abort = null; ++this.generation;
            this.status.textContent = 'Lasso cancelled. '+(this.selectionMessage || 'Drag around features to try again.');
            this.root.setAttribute('aria-busy','false');
        });
        this.onMapMove = () => this.cancelStroke();
        map.on('movestart zoomstart', this.onMapMove);
        this.refresh();
        this.setMode('pixel');
    }

    /** Register an event released when the map closes.
     * @param {EventTarget} target Event owner.
     * @param {string} name Event name.
     * @param {EventListener} handler Listener.
     * @param {boolean} [capture=false] Capture before Leaflet's pointer handlers.
     * @return {void}
     */
    listen(target, name, handler, capture = false) {
        target.addEventListener(name, handler, capture);
        this.bindings.push(() => target.removeEventListener(name, handler, capture));
    }

    /** Choose a map action without changing any source or existing layer filter.
     * @param {"pan"|"pixel"|"box"|"lasso"} mode Requested map action.
     * @return {void}
     */
    setMode(mode) {
        this.cancelStroke();
        if (mode !== this.mode && this.abort) {
            this.abort.abort(); this.abort = null; ++this.generation;
            this.root.setAttribute('aria-busy','false');
        }
        this.mode = mode;
        this.controls.hidden = mode !== 'lasso';
        for (const button of this.buttons) button.setAttribute('aria-pressed', String(button.dataset.mapMode === mode));
        this.container.classList.toggle('is-lasso-active', mode === 'lasso' && !this.editing);
        this.container.classList.toggle('leaflet-crosshair', ['pixel','box','lasso'].includes(mode) && !this.editing);
        if (mode === 'lasso' && !this.editing) {
            if (this.dragWasEnabled === null) this.dragWasEnabled = this.map.dragging.enabled();
            this.map.dragging.disable();
        } else if (this.dragWasEnabled !== null) {
            if (this.dragWasEnabled) this.map.dragging.enable();
            this.dragWasEnabled = null;
        }
        this.status.textContent = mode === 'lasso' ? this.selectionMessage || (this.layerSelect.value
            ? 'Drag around features; release to select. Esc cancels.' : 'Add a vector layer to the map to use Lasso.') :
            mode === 'box' ? 'Click the map to place a histogram box.' : mode === 'pixel' ? 'Point at the map to pick pixel values; click to inspect features.' : 'Drag to move the map.';
        this.onModeChange(mode, !this.editing);
    }

    /** Suspend map modes while another owner edits a drawing.
     * @param {boolean} editing Whether the composition root has an active drawing editor.
     * @return {void}
     */
    setEditing(editing) {
        this.editing = editing;
        for (const button of this.buttons) button.disabled = editing;
        this.layerSelect.disabled = editing || !this.targets.length;
        this.setMode(this.mode);
    }

    /** Refresh choices and invalidate results whose original source or predicate changed.
     * @return {void}
     */
    refresh() {
        const previous = this.layerSelect.value;
        this.targets = this.getTargets();
        const options = this.targets.map(target => {
            const option = this.document.createElement('option'); option.value = target.key; option.textContent = target.label; return option;
        });
        this.layerSelect.replaceChildren(...options);
        if (this.targets.some(target => target.key === previous)) this.layerSelect.value = previous;
        this.layerSelect.disabled = this.editing || !this.targets.length;
        const target = this.targets.find(value => value.key === this.layerSelect.value);
        const signature = target ? JSON.stringify([target.key, target.selection]) : null;
        if (this.targetSignature !== signature) {
            this.clear();
            if (this.mode === 'lasso') this.status.textContent = target ? 'Drag around features; release to select. Esc cancels.' : 'Add a vector layer to the map to use Lasso.';
        }
        this.targetSignature = signature;
    }

    /** Start a freehand stroke and capture this pointer until release or cancellation.
     * @param {PointerEvent} event Primary pointer inside the map.
     * @return {void}
     */
    beginStroke(event) {
        if (this.mode !== 'lasso' || this.editing || event.button !== 0 || event.isPrimary === false) return;
        const target = this.targets.find(value => value.key === this.layerSelect.value);
        if (!target) return;
        event.preventDefault(); event.stopImmediatePropagation();
        this.cancelStroke(); this.abort?.abort(); this.abort = null; ++this.generation;
        this.container.setPointerCapture(event.pointerId);
        this.stroke = {pointer:event.pointerId, points:[], target:structuredClone(target), screen:null};
        this.preview?.remove();
        this.preview = this.leaflet.polyline([], {color:this.color, weight:2, dashArray:'6 4', interactive:false}).addTo(this.map);
        this.status.textContent = 'Drawing lasso… Release to select; Esc cancels.';
        this.moveStroke(event);
    }

    /** Add geographic positions only after a few screen pixels of pointer movement.
     * @param {PointerEvent} event Captured pointer movement.
     * @return {void}
     */
    moveStroke(event) {
        if (!this.stroke || this.stroke.pointer !== event.pointerId) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const last = this.stroke.screen;
        if (last && Math.hypot(event.clientX-last[0], event.clientY-last[1]) < 3) return;
        if (this.stroke.points.length >= 2000) {
            this.cancelStroke(); this.status.textContent = 'The outline is too long. Draw a shorter lasso.'; return;
        }
        const position = this.map.mouseEventToLatLng(event);
        this.stroke.points.push([position.lng, position.lat]);
        this.stroke.screen = [event.clientX,event.clientY];
        this.preview.setLatLngs(this.stroke.points.map(([lng,lat])=>[lat,lng]));
    }

    /** Close the captured polygon and begin exact selection against its captured view.
     * @param {PointerEvent} event Captured pointer release.
     * @return {void}
     */
    finishStroke(event) {
        if (!this.stroke || this.stroke.pointer !== event.pointerId) return;
        this.moveStroke(event);
        if (!this.stroke) return;
        const {points,target} = this.stroke;
        this.cancelStroke();
        if (points.length < 3) { this.status.textContent = 'Drag around an area to select features.'; return; }
        if (points.some(([lng,lat])=>Math.abs(lng)>180 || Math.abs(lat)>85.05112878)) {
            this.status.textContent = 'Draw within the map without crossing the date line.'; return;
        }
        const ring = [...points, points[0]];
        const polygon = {type:'Polygon', coordinates:[ring]};
        void this.select(target, polygon);
    }

    /** Cancel only the unfinished stroke, preserving the last completed selection.
     * @return {void}
     */
    cancelStroke() {
        const stroke = this.stroke;
        this.stroke = null;
        if (stroke && this.container.hasPointerCapture(stroke.pointer)) this.container.releasePointerCapture(stroke.pointer);
        this.preview?.remove(); this.preview = null;
        if (stroke) this.status.textContent = this.selectionMessage || 'Lasso cancelled. Drag around features to try again.';
    }

    /** Replace selected feature highlights after an exact, current source response.
     * @param {Object} target Captured view identity, label and source predicate.
     * @param {Object} polygon Closed WGS84 selection polygon.
     * @return {Promise<void>} Selection presentation completion; errors remain in the strip.
     */
    async select(target, polygon) {
        const generation = ++this.generation;
        const abort = new AbortController(); this.abort = abort;
        this.clearButton.hidden = false;
        this.status.textContent = `Selecting features in ${target.label}…`;
        this.root.setAttribute('aria-busy','true');
        try {
            const result = await this.selectFeatures(target.selection, polygon, abort.signal);
            if (generation !== this.generation) return;
            this.highlight?.remove(); this.highlight = null;
            this.outline?.remove();
            this.outline = this.leaflet.geoJSON(polygon, {style:{color:this.color,weight:2,dashArray:'6 4',fillOpacity:.06},interactive:false}).addTo(this.map);
            if (result.geometry) this.highlight = this.leaflet.geoJSON(result.geometry, {
                style:{color:this.color,weight:3,fillOpacity:.22}, interactive:false,
                pointToLayer:(_feature,latlng)=>this.leaflet.circleMarker(latlng,{color:this.color,radius:6,fillOpacity:.7,interactive:false}),
            }).addTo(this.map);
            this.selectionMessage = `${result.matched.toLocaleString()} ${result.matched===1?'feature':'features'} selected in ${target.label}.`+
                (result.geometry ? ' Drag a new outline to replace the selection.' : ' Selection is complete; map highlights are unavailable.');
            this.status.textContent = this.selectionMessage;
        } catch (error) {
            if (generation !== this.generation || abort.signal.aborted) return;
            this.status.textContent = error.message;
        } finally {
            if (generation === this.generation) { this.abort = null; this.root.setAttribute('aria-busy','false'); }
        }
    }

    /** Clear the transient selection and cancel obsolete work without changing filters.
     * @return {void}
     */
    clear() {
        ++this.generation; this.abort?.abort(); this.abort = null; this.cancelStroke();
        this.highlight?.remove(); this.highlight = null; this.outline?.remove(); this.outline = null;
        this.selectionMessage = null;
        this.clearButton.hidden = true; this.root.setAttribute('aria-busy','false');
        this.status.textContent = 'Selection cleared. Drag around features to select again.';
    }

    /** Release pointer handlers, pending selection work and map-only geometry.
     * @return {void}
     */
    dispose() {
        this.clear(); this.setMode('pan');
        this.map.off('movestart zoomstart', this.onMapMove);
        for (const unbind of this.bindings) unbind();
    }
}
