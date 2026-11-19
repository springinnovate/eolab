/** Display a single statistic's geographic context using the configured base tiles. */
import { samplingBoxBounds, tessellateSamplingBox } from "../sampling-box.js";
import { vectorSelectionsEqual } from "../selected-area.js";

const outlineStyle = {className: "map-selection-footprint", interactive: false};

/** Convert an admitted two- or three-dimensional geographic extent into Leaflet corners.
 * An east longitude beyond 180 keeps a dateline-crossing footprint contiguous on the thumbnail.
 * @param {number[]|undefined|null} bbox Geographic bounds from source or polygon metadata.
 * @return {number[][]|null} Southwest and northeast corners, if available.
 */
function extentCorners(bbox) {
    if (!bbox || ![4, 6].includes(bbox.length) || !bbox.every(Number.isFinite)) return null;
    const [west, south] = bbox;
    const [east, north] = bbox.slice(bbox.length / 2);
    if (Math.abs(west) > 180 || Math.abs(east) > 180 || south < -90 || north > 90 || south > north) return null;
    return [[south, west], [north, east < west ? east + 360 : east]];
}

/** Own the optional thumbnail independently of the interactive map and statistics requests. */
export class RasterResultLocator {
    /** @param {Document} documentContext Panel document.
     * @param {Object} leaflet Leaflet presentation library supplied by composition.
     * @param {{url:string,attribution:string}} background Site's configured background tiles and attribution.
     */
    constructor(documentContext, leaflet, background) {
        this.figure = documentContext.querySelector("#raster-series-locator");
        this.container = documentContext.querySelector("#raster-series-locator-map");
        this.caption = documentContext.querySelector("#raster-series-locator-caption");
        this.leaflet = leaflet;
        this.background = background;
        this.polygon = null;
    }

    /** Update the display outline for the prepared polygon selection. A late outline is shown
     * only if its source and filter still match the result.
     * @param {{selection?:Object,polygonArea?:Object,bbox?:number[]}} area Prepared polygon selection.
     * @param {Object|null} [geometry] Optional display-only GeoJSON from the shared outline or current drawing.
     * @return {void}
     */
    setPolygon(area, geometry = null) {
        this.polygon = {selection: area.selection, reference: area.polygonArea, bbox: area.bbox, geometry};
        this.signature = null;
        if (this.state) this.render(this.state, this.expression);
    }

    /** Fit the captured geographic area beside a scalar. Hide the thumbnail when no matching
     * footprint is available. Repeated progress updates reuse the same map, tiles and overlay.
     * @param {import("./series-view.js").SeriesPresentation|null} state Single result, or null when hidden.
     * @param {string} expression Statistic whose area or clicked pixel is shown.
     * @return {void}
     */
    render(state, expression) {
        this.state = state;
        this.expression = expression;
        const area = state?.area.area;
        if (!area) {
            if (!this.figure.hidden) this.figure.hidden = true;
            this.signature = null;
            return;
        }
        const pixel = /^\s*pixelValue\s*\(\s*a\s*\)\s*$/.test(expression);
        const point = pixel ? state.pixelPoint : null;
        const signature = JSON.stringify([area, state.resultBounds, pixel, point, this.figure.parentElement.clientWidth]);
        if (signature === this.signature) return;
        this.signature = signature;
        let corners, geometry, box, caption;
        if (pixel && point) {
            corners = [[point.latitude, point.longitude], [point.latitude, point.longitude]];
            caption = "Sampled pixel";
        } else if (!pixel) {
            if (area.kind === "samplingBox" || area.kind === "selectedArea") {
                box = area.samplingBox;
                const bounds = box ? samplingBoxBounds(box) : area.selectedBounds;
                corners = [[bounds.south, bounds.west], [bounds.north, bounds.east]];
                caption = box ? box.sideLengthKm + " km sampling box" : "Sampling box";
            } else if (area.kind === "wholeRaster") {
                corners = extentCorners(state.resultBounds);
                caption = "Whole raster extent";
            } else if (this.polygon && (area.kind === "polygonArea" ? area.polygonArea.id === this.polygon.reference?.id
                : vectorSelectionsEqual(area.catalogSelection, this.polygon.selection))) {
                geometry = this.polygon.geometry;
                corners = extentCorners(this.polygon.bbox);
                caption = geometry ? "Selected polygons" : "Selected polygon extent";
            }
        }
        this.figure.hidden = !corners && !geometry;
        if (this.figure.hidden) return;
        try {
            this.draw(corners, geometry, point, box, caption);
        } catch {
            // An undisplayable map or outline cannot invalidate a statistic.
            this.figure.hidden = true;
        }
    }

    /** Fit the thumbnail and draw the available footprint or sampled point.
     * @param {number[][]|null|undefined} corners Southwest and northeast corners.
     * @param {Object|undefined} geometry Display outline for selected polygons.
     * @param {{longitude:number,latitude:number}|null} point Sampled pixel, if applicable.
     * @param {import("../sampling-box.js").SamplingBox|undefined} box Geodesic box to draw at thumbnail resolution.
     * @param {string} caption Description of the geographic mark.
     * @return {void}
     * @throws {Error} If Leaflet cannot display the configured map or shape.
     */
    draw(corners, geometry, point, box, caption) {
        const L = this.leaflet;
        if (!this.map) {
            this.map = L.map(this.container, {zoomControl: false, dragging: false, keyboard: false, touchZoom: false,
                doubleClickZoom: false, scrollWheelZoom: false, boxZoom: false, zoomAnimation: false, fadeAnimation: false});
            this.map.attributionControl.setPrefix(false);
            L.tileLayer(this.background.url, {className: "eolab-basemap", attribution: this.background.attribution,
                maxNativeZoom: 17, maxZoom: 22}).addTo(this.map);
        }
        this.map.invalidateSize({pan: false});
        this.layer?.remove();
        this.layer = null;
        if (geometry) {
            const outline = L.geoJSON(geometry, {style: outlineStyle, interactive: false});
            if (outline.getBounds().isValid()) {
                this.layer = outline;
                corners = outline.getBounds();
            } else if (!corners) {
                this.figure.hidden = true;
                return;
            } else caption = "Selected polygon extent";
        }
        this.map.fitBounds(corners, {padding: [8, 8], maxZoom: point ? 13 : 18, animate: false});
        if (!this.layer) {
            if (point) this.layer = L.circleMarker(corners[0], {...outlineStyle, radius: 4});
            else if (box) {
                const ring = tessellateSamplingBox(box, positions => positions.map(([lon, lat]) => {
                    const projected = this.map.project([lat, lon]); return [projected.x, projected.y];
                }));
                this.layer = L.polygon(ring.map(([lon, lat]) => [lat, lon]), outlineStyle);
            } else this.layer = L.rectangle(corners, outlineStyle);
        }
        this.layer.addTo(this.map);
        this.caption.textContent = caption;
        this.container.setAttribute("aria-label", caption);
    }
}
