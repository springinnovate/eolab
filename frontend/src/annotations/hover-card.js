/** Identify browser-owned polygons without intercepting map gestures. */
export class AnnotationHoverCard {
    /**
     * Connect a pointer-following card to the map's existing mouse events.
     * @param {Object} map Leaflet map.
     * @param {(position:{lat:number,lng:number})=>{layerName:string,polygon:import("./model.js").AnnotationPolygon}[]} findPolygons Top-first annotation hits.
     */
    constructor(map, findPolygons) {
        this.map = map;
        this.findPolygons = findPolygons;
        this.enabled = true;
        this.moving = false;
        this.timer = null;
        this.card = map.getContainer().ownerDocument.createElement("div");
        this.card.className = "annotation-hover-card";
        this.card.hidden = true;
        map.getContainer().append(this.card);
        this.onMove = event => {
            if (!this.enabled || this.moving) return;
            clearTimeout(this.timer);
            if (!this.card.hidden) this.showAt(event);
            else this.timer = setTimeout(() => this.showAt(event), 80);
        };
        this.onLeave = () => this.hide();
        this.onMoveStart = () => { this.moving = true; this.hide(); };
        this.onMoveEnd = () => { this.moving = false; };
        this.onRemove = () => this.dispose();
        map.on("mousemove", this.onMove);
        map.on("movestart zoomstart", this.onMoveStart);
        map.on("moveend zoomend", this.onMoveEnd);
        map.on("remove", this.onRemove);
        map.getContainer().addEventListener("pointerleave", this.onLeave);
    }

    /**
     * Show the topmost polygon's identity as text and keep the card inside the map.
     * @param {{latlng:{lat:number,lng:number},containerPoint:{x:number,y:number}}} event Map pointer event.
     * @return {void}
     */
    showAt(event) {
        this.timer = null;
        if (!this.enabled || this.moving) return;
        const hit = this.findPolygons(event.latlng)[0];
        if (!hit) { this.hide(); return; }
        const text = `${hit.layerName}\n${hit.polygon.name}${hit.polygon.contributor ? ` — ${hit.polygon.contributor}` : ""}`;
        if (this.card.textContent !== text) this.card.textContent = text;
        this.card.hidden = false;
        const container = this.map.getContainer();
        const { x, y } = event.containerPoint;
        this.card.style.left = `${Math.max(4, Math.min(x + 16, container.clientWidth - this.card.offsetWidth - 4))}px`;
        this.card.style.top = `${Math.max(4, Math.min(y + 16, container.clientHeight - this.card.offsetHeight - 4))}px`;
    }

    /** Hide both pending and visible feedback. @return {void} */
    hide() { clearTimeout(this.timer); this.timer = null; this.card.hidden = true; }

    /**
     * Disable feedback while drawing or editing, without changing map event propagation.
     * @param {boolean} enabled Whether map inspection is active.
     * @return {void}
     */
    setEnabled(enabled) { this.enabled = enabled; if (!enabled) this.hide(); }

    /** Release timers, map listeners and the card when the map is removed. @return {void} */
    dispose() {
        this.hide();
        this.map.off("mousemove", this.onMove);
        this.map.off("movestart zoomstart", this.onMoveStart);
        this.map.off("moveend zoomend", this.onMoveEnd);
        this.map.off("remove", this.onRemove);
        this.map.getContainer().removeEventListener("pointerleave", this.onLeave);
        this.card.remove();
    }
}
