/** One pointer-following card for local and server-queried map features. */
export class MapFeatureHover {
    /**
     * Connect hover feedback without intercepting map gestures or clicks.
     * Local hits are immediate once the card is open. Server queries always wait
     * for an 80 ms pause; moving again cancels them and clears stale text.
     * @param {Object} map Leaflet map.
     * @param {Object} queries Composition-supplied feature lookups.
     * @param {(event:Object)=>string|null} queries.findLocalText Synchronous hit text.
     * @param {(event:Object,signal:AbortSignal)=>Promise<string|null>} queries.findRemoteText Asynchronous hit text.
     */
    constructor(map, { findLocalText, findRemoteText }) {
        this.map = map;
        this.findLocalText = findLocalText;
        this.findRemoteText = findRemoteText;
        this.enabled = true;
        this.moving = false;
        this.generation = 0;
        this.timer = null;
        this.abortController = null;
        this.card = map.getContainer().ownerDocument.createElement("div");
        this.card.className = "map-feature-hover-card";
        this.card.hidden = true;
        map.getContainer().append(this.card);
        this.onMove = event => {
            if (!this.enabled || this.moving) return;
            const wasVisible = !this.card.hidden;
            this.hide();
            const localText = wasVisible ? this.findLocalText(event) : null;
            if (localText) this.showText(event, localText);
            else this.timer = setTimeout(() => { void this.findAt(event); }, 80);
        };
        this.onLeave = () => this.hide();
        this.onMoveStart = () => { this.moving = true; this.hide(); };
        this.onMoveEnd = () => { this.moving = false; };
        this.onRemove = () => this.dispose();
        map.on("mousemove", this.onMove);
        map.on("movestart zoomstart", this.onMoveStart);
        map.on("moveend zoomend", this.onMoveEnd);
        map.on("click", this.onLeave);
        map.on("remove", this.onRemove);
        map.getContainer().addEventListener("pointerleave", this.onLeave);
    }

    /**
     * Find a feature at a settled pointer, discarding cancelled or late replies.
     * Failed/slow remote lookups leave the card hidden; click inspection remains available.
     * @param {Object} event Leaflet pointer event.
     * @return {Promise<void>} Completes after local or remote identification.
     */
    async findAt(event) {
        this.timer = null;
        if (!this.enabled || this.moving) return;
        const localText = this.findLocalText(event);
        if (localText) { this.showText(event, localText); return; }
        const generation = this.generation;
        const controller = new AbortController();
        this.abortController = controller;
        try {
            const text = await this.findRemoteText(event, controller.signal);
            if (generation === this.generation && text) this.showText(event, text);
        } catch {
            // Hover is optional. The existing click inspector reports query failures.
        } finally {
            if (this.abortController === controller) this.abortController = null;
        }
    }

    /**
     * Show plain text beside the pointer, keeping it inside the map.
     * @param {{containerPoint:{x:number,y:number}}} event Map pointer event.
     * @param {string} text Layer identity and optional feature details.
     * @return {void}
     */
    showText(event, text) {
        if (this.card.textContent !== text) this.card.textContent = text;
        this.card.hidden = false;
        const container = this.map.getContainer();
        const { x, y } = event.containerPoint;
        this.card.style.left = `${Math.max(4, Math.min(x + 16, container.clientWidth - this.card.offsetWidth - 4))}px`;
        this.card.style.top = `${Math.max(4, Math.min(y + 16, container.clientHeight - this.card.offsetHeight - 4))}px`;
    }

    /** Cancel pending queries and clear visible feedback. @return {void} */
    hide() {
        clearTimeout(this.timer);
        this.timer = null;
        this.generation++;
        this.abortController?.abort();
        this.abortController = null;
        this.card.hidden = true;
    }

    /**
     * Suppress hover while the map is being used for editing.
     * @param {boolean} enabled Whether inspection is active.
     * @return {void}
     */
    setEnabled(enabled) { this.enabled = enabled; if (!enabled) this.hide(); }

    /** Release listeners, queries and presentation on map removal. @return {void} */
    dispose() {
        this.hide();
        this.map.off("mousemove", this.onMove);
        this.map.off("movestart zoomstart", this.onMoveStart);
        this.map.off("moveend zoomend", this.onMoveEnd);
        this.map.off("click", this.onLeave);
        this.map.off("remove", this.onRemove);
        this.map.getContainer().removeEventListener("pointerleave", this.onLeave);
        this.card.remove();
    }
}
