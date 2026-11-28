/** Present mutually exclusive map modes and capture a transient freehand selection. */

/** @typedef {"pan"|"pixel"|"box"|"lasso"} MapMode */
/** @typedef {{rasterValues:boolean,featurePicking:boolean,histogramBox:boolean}} MapPointerActions */
/** @typedef {MapPointerActions & {lasso:boolean}} MapToolAvailability */

/** Map-tool controls and lasso drawing, independent of raster and vector implementations. */
export class MapInteractionTools {
    /**
     * Activate an allowed starting mode and connect its controls and gestures.
     * @param {Object} options Map and UI dependencies.
     * @param {Document} options.documentContext Owning document.
     * @param {Object} options.map Leaflet map used to capture geographic positions.
     * @param {Object} options.leaflet Leaflet geometry and display adapter.
     * @param {()=>Array<{key:string,label:string,selection:Object}>} options.getTargets Retained vector views, including hidden views.
     * @param {Readonly<MapToolAvailability>} options.availability Effective choices for this viewer.
     * @param {boolean} [options.editing=false] Whether a layer editor already owns the map pointer.
     * @param {(actions:Readonly<MapPointerActions>)=>void} options.onActionsChange Active pointer actions after mode and editing state are applied.
     * @param {(target:Object,polygon:Object,signal:AbortSignal)=>Promise<void>} options.selectFeatures Acquisition request passed to the selection owner through composition.
     * @param {()=>void} options.onClearSelection Explicit intent to clear selected features and plots.
     */
    constructor({documentContext, map, leaflet, getTargets, availability, editing = false, onActionsChange, selectFeatures, onClearSelection}) {
        Object.assign(this, {document:documentContext, map, leaflet, getTargets, availability, onActionsChange, selectFeatures, onClearSelection});
        this.root = documentContext.querySelector('#map-interaction-tools');
        this.buttons = [...this.root.querySelectorAll('[data-map-mode]')];
        this.controls = this.root.querySelector('#lasso-controls');
        this.layerSelect = this.root.querySelector('#lasso-layer');
        this.status = this.root.querySelector('#map-interaction-status');
        this.clearButton = this.root.querySelector('#clear-lasso-selection');
        this.container = map.getContainer();
        /** @type {MapMode} */
        this.mode = this.#isModeAvailable('pixel') ? 'pixel' : 'pan';
        this.editing = editing;
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
        this.listen(this.layerSelect, 'change', () => { this.#cancelLassoWork(); this.refresh(); });
        this.listen(this.clearButton, 'click', () => { this.clear(); this.onClearSelection(); });
        this.listen(this.container, 'pointerdown', event => this.beginStroke(event), true);
        this.listen(this.container, 'pointermove', event => this.moveStroke(event), true);
        this.listen(this.container, 'pointerup', event => this.finishStroke(event), true);
        this.listen(this.container, 'pointercancel', () => this.cancelStroke(), true);
        this.listen(this.container, 'lostpointercapture', () => this.cancelStroke(), true);
        this.listen(documentContext, 'keydown', event => {
            if ((event.key === 'p' || event.key === 'P') && !this.editing && this.#isModeAvailable('pixel') &&
                !event.ctrlKey && !event.metaKey && !event.altKey &&
                !event.target?.closest?.('input, textarea, select, [contenteditable]')) {
                event.preventDefault(); this.setMode('pixel'); return;
            }
            if (event.key !== 'Escape' || this.mode !== 'lasso' || this.editing) return;
            if (!this.stroke && !this.abort) return;
            event.preventDefault(); event.stopPropagation();
            this.#cancelLassoWork();
            this.status.textContent = 'Lasso cancelled. '+(this.selectionMessage || 'Drag around features to try again.');
        });
        this.onMapMove = () => this.cancelStroke();
        map.on('movestart zoomstart', this.onMapMove);
        this.refresh();
        this.#activateMode(this.mode);
        this.root.hidden = false;
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

    /** Choose an available map action while the map is free for navigation and inspection.
     * @param {MapMode} mode Requested map action.
     * @return {void}
     */
    setMode(mode) {
        if (this.editing || !this.#isModeAvailable(mode)) return;
        this.#activateMode(mode);
    }

    /** Apply effective choices and return to Pan if the current mode is no longer available.
     * @param {Readonly<MapToolAvailability>} availability Resolved inspection choices for this viewer.
     * @return {void}
     */
    setAvailability(availability) {
        this.availability = availability;
        this.#activateMode(this.#isModeAvailable(this.mode) ? this.mode : 'pan');
    }

    /** Determine whether a mode has an enabled action.
     * @param {string} mode Requested tool.
     * @return {boolean} True for Pan or an enabled inspection mode.
     */
    #isModeAvailable(mode) {
        switch (mode) {
            case 'pan': return true;
            case 'pixel': return this.availability.rasterValues || this.availability.featurePicking;
            case 'box': return this.availability.histogramBox;
            case 'lasso': return this.availability.lasso;
            default: return false;
        }
    }

    /** Apply the allowed mode to the map and inform composition which actions can run.
     * @param {MapMode} mode Available mode to present, including during drawing suspension.
     * @return {void}
     */
    #activateMode(mode) {
        if (mode !== this.mode || this.editing) this.#cancelLassoWork();
        this.mode = mode;
        const { rasterValues, featurePicking } = this.availability;
        this.controls.hidden = mode !== 'lasso';
        const focused = this.document.activeElement;
        for (const button of this.buttons) {
            button.hidden = !this.#isModeAvailable(button.dataset.mapMode);
            button.disabled = this.editing || button.hidden;
            button.setAttribute('aria-pressed', String(button.dataset.mapMode === mode));
            if (button.dataset.mapMode === 'pixel') {
                button.textContent = featurePicking ? 'Picker' : 'Pixel picker';
            }
        }
        if (!this.editing && this.buttons.includes(focused) && focused.hidden) {
            this.buttons.find(button => button.dataset.mapMode === mode).focus({preventScroll:true});
        }
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
            mode === 'box' ? 'Click the map to place a histogram box.' : 'Drag to move the map.';
        if (mode === 'pixel') {
            this.status.textContent = [
                rasterValues && 'Point at the map to pick pixel values.',
                featurePicking && 'Click the map to inspect features.',
            ].filter(Boolean).join(' ');
        }
        this.onActionsChange({
            rasterValues: !this.editing && mode === 'pixel' && rasterValues,
            featurePicking: !this.editing && mode === 'pixel' && featurePicking,
            histogramBox: !this.editing && mode === 'box',
        });
    }

    /** Suspend map modes while another owner edits a drawing.
     * @param {boolean} editing Whether the composition root has an active drawing editor.
     * @return {void}
     */
    setEditing(editing) {
        this.editing = editing;
        this.layerSelect.disabled = editing || !this.targets.length;
        this.#activateMode(this.mode);
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
            this.#cancelLassoWork();
            if (this.mode === 'lasso') this.status.textContent = target ? 'Drag around features; release to select. Esc cancels.' : 'Add a vector layer to the map to use Lasso.';
        }
        this.targetSignature = signature;
    }

    /** Start a shaded preview of the area that releasing the pointer would select.
     * Leaflet controls receive their own pointer input.
     * @param {PointerEvent} event Primary pointer inside the map.
     * @return {void}
     */
    beginStroke(event) {
        if (this.mode !== 'lasso' || this.editing || event.button !== 0 || event.isPrimary === false ||
            event.target.closest('.leaflet-control')) return;
        const target = this.targets.find(value => value.key === this.layerSelect.value);
        if (!target) return;
        event.preventDefault(); event.stopImmediatePropagation();
        this.#cancelLassoWork();
        this.container.setPointerCapture(event.pointerId);
        const preview = this.leaflet.polygon([], {color:this.color, weight:2, dashArray:'6 4', fillOpacity:0.2, interactive:false}).addTo(this.map);
        this.stroke = {pointer:event.pointerId, points:[], target:structuredClone(target), screen:null, preview};
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
        this.stroke.preview.setLatLngs(this.stroke.points.map(([lng,lat])=>[lat,lng]));
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
        if (!stroke) return;
        this.stroke = null;
        if (this.container.hasPointerCapture(stroke.pointer)) this.container.releasePointerCapture(stroke.pointer);
        stroke.preview.remove();
        this.status.textContent = this.selectionMessage || 'Lasso cancelled. Drag around features to try again.';
    }

    /** Release an unfinished Lasso gesture and supersede its read, preserving completed results.
     * @return {void}
     */
    #cancelLassoWork() {
        this.cancelStroke();
        if (!this.abort) return;
        ++this.generation;
        this.pendingOutline.remove();
        this.pendingOutline = null;
        this.abort.abort();
        this.abort = null;
        this.root.setAttribute('aria-busy','false');
        this.clearButton.hidden = this.selectionMessage === null;
    }

    /** Request a selection from its owner while showing the submitted outline immediately.
     * @param {Object} target Captured view identity, label and source predicate.
     * @param {Object} polygon Closed WGS84 selection polygon.
     * @return {Promise<void>} Selection presentation completion; errors remain in the strip.
     */
    async select(target, polygon) {
        if (this.mode !== 'lasso' || this.editing) return;
        this.#cancelLassoWork();
        const generation = ++this.generation;
        const abort = new AbortController(); this.abort = abort;
        this.clearButton.hidden = false;
        this.status.textContent = `Selecting features in ${target.label}…`;
        this.root.setAttribute('aria-busy','true');
        this.pendingOutline = this.leaflet.geoJSON(polygon, {style:{color:this.color,weight:2,dashArray:'6 4',fillOpacity:.06},interactive:false}).addTo(this.map);
        try {
            await this.selectFeatures(target, polygon, abort.signal);
        } catch (error) {
            if (generation !== this.generation || abort.signal.aborted) return;
            this.status.textContent = error.name === 'AbortError' ? this.selectionMessage || 'Lasso cancelled.' : error.message;
        } finally {
            if (generation === this.generation) {
                this.abort = null;
                this.pendingOutline.remove();
                this.pendingOutline = null;
                this.root.setAttribute('aria-busy','false');
            }
        }
    }

    /** Display the selection owner's completed Lasso, including history restoration.
     * This presentation carries no feature IDs or analytical state.
     * @param {{polygon:Object,geometry:Object|null,count:number,label:string}|null} display Current Lasso display, or null for another selection or Clear.
     * @param {Object} [options] Gesture handling for explicit user actions.
     * @param {boolean} [options.cancelGesture=false] Clear or history navigation supersedes a drawing or pending selection.
     * @return {void}
     */
    setSelectionDisplay(display, {cancelGesture = false} = {}) {
        if (cancelGesture) this.#cancelLassoWork();
        this.highlight?.remove(); this.highlight = null;
        this.outline?.remove(); this.outline = null;
        this.selectionMessage = null;
        this.clearButton.hidden = display === null;
        if (display === null) {
            if (this.mode === 'lasso' && !this.stroke) this.status.textContent = 'Use Lasso to select features, then open Features to inspect or plot them.';
            return;
        }
        this.outline = this.leaflet.geoJSON(display.polygon, {style:{color:this.color,weight:2,dashArray:'6 4',fillOpacity:.06},interactive:false}).addTo(this.map);
        if (display.geometry) this.highlight = this.leaflet.geoJSON(display.geometry, {
            style:{color:this.color,weight:3,fillOpacity:.22}, interactive:false,
            pointToLayer:(_feature,latlng)=>this.leaflet.circleMarker(latlng,{color:this.color,radius:6,fillOpacity:.7,interactive:false}),
        }).addTo(this.map);
        this.selectionMessage = `${display.count.toLocaleString()} ${display.count===1?'feature':'features'} selected in ${display.label}.` +
            (display.count > 0 ? ' Open Features to inspect or plot them.' : ' Draw another area to select features.') +
            (display.count > 0 && display.geometry === null ? ' Map highlights are unavailable.' : '');
        if (this.mode === 'lasso' && !this.stroke) this.status.textContent = this.selectionMessage;
    }

    /** Clear the transient selection and cancel obsolete work without changing filters.
     * @return {void}
     */
    clear() {
        this.#cancelLassoWork();
        this.setSelectionDisplay(null);
        this.clearButton.hidden = true; this.root.setAttribute('aria-busy','false');
        this.status.textContent = 'Selection cleared. Drag around features to select again.';
    }

    /** Release pointer handlers, pending selection work and map-only geometry.
     * @return {void}
     */
    dispose() {
        this.clear(); this.#activateMode('pan');
        this.root.hidden = true;
        this.map.off('movestart zoomstart', this.onMapMove);
        for (const unbind of this.bindings) unbind();
    }
}
