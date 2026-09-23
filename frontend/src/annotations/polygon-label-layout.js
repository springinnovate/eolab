/** Screen-space label placement shared by annotation layers and the polygon editor. */

const MAP_LAYOUT_EVENTS = "moveend zoomend resize layeradd layerremove";
const LABEL_GAP = 4;
const MIN_POLYGON_SPAN = 24;

/** Keep readable annotation labels without covering tiny polygons or other labels. */
export class PolygonLabelLayout {
    /**
     * Create a map-local layout; listeners are attached only while renderers are registered.
     * @param {Object} map Leaflet map supplying screen coordinates and layer visibility.
     */
    constructor(map) {
        this.map = map;
        this.window = map.getContainer().ownerDocument.defaultView;
        this.renderers = new Map();
        this.frame = null;
        /** Combine renderer refreshes and map events into one layout per frame. @type {()=>void} */
        this.schedule = () => {
            if (this.frame !== null || !this.renderers.size) return;
            this.frame = this.window.requestAnimationFrame(() => {
                this.frame = null;
                this.updateLabelVisibility();
            });
        };
    }

    /**
     * Register a renderer's current polygons in stable display order.
     * @param {Object} owner Renderer identity, used only for removal.
     * @param {()=>Object[]} polygons Current Leaflet polygons; exclude fully transparent layers.
     * @param {boolean} [editing=false] Whether these are editing drafts whose enabled labels must stay visible.
     * @return {void}
     */
    register(owner, polygons, editing = false) {
        if (!this.renderers.size) this.map.on(MAP_LAYOUT_EVENTS, this.schedule);
        this.renderers.set(owner, { polygons, editing });
        this.schedule();
    }

    /**
     * Stop observing a removed renderer and release listeners after the final removal.
     * @param {Object} owner Previously registered renderer.
     * @return {void}
     */
    unregister(owner) {
        this.renderers.delete(owner);
        if (this.renderers.size) { this.schedule(); return; }
        this.map.off(MAP_LAYOUT_EVENTS, this.schedule);
        if (this.frame !== null) this.window.cancelAnimationFrame(this.frame);
        this.frame = null;
    }

    /**
     * Measure labels once, then apply visibility without changing polygons or tooltip content.
     * Hide saved labels only when the polygon's longest screen dimension is below
     * 24 pixels, or the label overlaps an earlier label. Names may extend beyond
     * their polygon. Drafts take priority; other ties use renderer and polygon order.
     * Hidden labels retain their dimensions so zooming back in can reveal them.
     * @return {void}
     */
    updateLabelVisibility() {
        const viewport = this.map.getContainer().getBoundingClientRect();
        const candidates = [];
        for (const { polygons, editing } of this.renderers.values()) {
            for (const shape of polygons()) {
                const element = shape.getTooltip()?.getElement();
                if (!element || !this.map.hasLayer(shape)) continue;
                const label = element.getBoundingClientRect();
                const bounds = shape.getBounds();
                const topLeft = this.map.latLngToContainerPoint(bounds.getNorthWest());
                const bottomRight = this.map.latLngToContainerPoint(bounds.getSouthEast());
                const polygonSpan = Math.max(Math.abs(bottomRight.x - topLeft.x),
                    Math.abs(bottomRight.y - topLeft.y));
                const onScreen = label.right > viewport.left && label.left < viewport.right &&
                    label.bottom > viewport.top && label.top < viewport.bottom;
                candidates.push({ element, label, editing, eligible: editing || (polygonSpan >= MIN_POLYGON_SPAN && onScreen) });
            }
        }
        // Stable sorting keeps otherwise equal labels from swapping after pans or refreshes.
        candidates.sort((a, b) => Number(b.editing) - Number(a.editing));
        const occupied = [];
        for (const { element, label, editing, eligible } of candidates) {
            const overlaps = occupied.some(other => label.left < other.right + LABEL_GAP &&
                label.right + LABEL_GAP > other.left && label.top < other.bottom + LABEL_GAP &&
                label.bottom + LABEL_GAP > other.top);
            const visible = eligible && (editing || !overlaps);
            element.style.visibility = visible ? "visible" : "hidden";
            if (visible) occupied.push(label);
        }
    }
}
