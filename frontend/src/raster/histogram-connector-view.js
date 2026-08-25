/**
 * Map-associated presentation for the sampled-area-to-histogram connector.
 *
 * This adapter consumes canonical geographic bounds and Leaflet projection,
 * then draws a viewport SVG from the nearest histogram edge to the nearest
 * visible edge or corner of the sampled bounds. It owns no sampling choice,
 * statistics state, AOI lifecycle, or map-layer lifecycle.
 */
import { validateRasterSelectedBounds } from "./geometry.js";
import { requireRasterControl } from "./required-control.js";

const ARROW_LENGTH = 10;
const ARROW_HALF_WIDTH = 5;

/**
 * Clamp one coordinate into a closed interval.
 *
 * @param {number} value Candidate coordinate.
 * @param {number} minimum Interval minimum.
 * @param {number} maximum Interval maximum.
 * @return {number} Clamped coordinate.
 */
function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Return whether one point lies strictly inside a rectangle.
 *
 * @param {{left:number,top:number,right:number,bottom:number}} rectangle Area.
 * @param {{x:number,y:number}} point Candidate point.
 * @return {boolean} Whether the point is covered by the rectangle interior.
 */
function containsPoint(rectangle, point) {
    return point.x > rectangle.left && point.x < rectangle.right &&
        point.y > rectangle.top && point.y < rectangle.bottom;
}

/**
 * Return the closest point on a rectangle perimeter to another point.
 *
 * @param {{left:number,top:number,right:number,bottom:number}} rectangle Area.
 * @param {{x:number,y:number}} point Candidate external or internal point.
 * @return {{x:number,y:number}} Nearest perimeter point.
 */
function nearestPerimeterPoint(rectangle, point) {
    const clamped = {
        x: clamp(point.x, rectangle.left, rectangle.right),
        y: clamp(point.y, rectangle.top, rectangle.bottom),
    };
    if (!containsPoint(rectangle, point)) {
        return clamped;
    }
    const distances = [
        { distance: point.x - rectangle.left, x: rectangle.left, y: point.y },
        { distance: rectangle.right - point.x, x: rectangle.right, y: point.y },
        { distance: point.y - rectangle.top, x: point.x, y: rectangle.top },
        { distance: rectangle.bottom - point.y, x: point.x, y: rectangle.bottom },
    ];
    distances.sort((first, second) => first.distance - second.distance);
    return { x: distances[0].x, y: distances[0].y };
}

/**
 * Compute a connector between two viewport rectangles.
 *
 * Target candidates include corners and source-aligned edge positions. A
 * covered target point is excluded so the arrow always terminates on a
 * visible sampled-area boundary.
 *
 * @param {{left:number,top:number,right:number,bottom:number}} sourceRectangle
 * Histogram widget rectangle.
 * @param {{left:number,top:number,right:number,bottom:number}} targetRectangle
 * Visible sampled-area rectangle.
 * @return {{start:{x:number,y:number},end:{x:number,y:number},
 * arrowPoints:string}|null} Shortest visible connector, or null when no
 * distinct endpoint exists.
 */
export function nearestRectangleConnector(sourceRectangle, targetRectangle) {
    const sourceCenter = {
        x: (sourceRectangle.left + sourceRectangle.right) / 2,
        y: (sourceRectangle.top + sourceRectangle.bottom) / 2,
    };
    const targetCenter = {
        x: (targetRectangle.left + targetRectangle.right) / 2,
        y: (targetRectangle.top + targetRectangle.bottom) / 2,
    };
    const targetCandidates = [
        { x: targetRectangle.left, y: targetRectangle.top },
        { x: targetRectangle.right, y: targetRectangle.top },
        { x: targetRectangle.right, y: targetRectangle.bottom },
        { x: targetRectangle.left, y: targetRectangle.bottom },
        {
            x: clamp(sourceCenter.x, targetRectangle.left, targetRectangle.right),
            y: targetRectangle.top,
        },
        {
            x: clamp(sourceCenter.x, targetRectangle.left, targetRectangle.right),
            y: targetRectangle.bottom,
        },
        {
            x: targetRectangle.left,
            y: clamp(sourceCenter.y, targetRectangle.top, targetRectangle.bottom),
        },
        {
            x: targetRectangle.right,
            y: clamp(sourceCenter.y, targetRectangle.top, targetRectangle.bottom),
        },
        nearestPerimeterPoint(targetRectangle, sourceCenter),
        nearestPerimeterPoint(targetRectangle, targetCenter),
    ];
    let best = null;
    for (const end of targetCandidates) {
        if (containsPoint(sourceRectangle, end)) {
            continue;
        }
        const start = nearestPerimeterPoint(sourceRectangle, end);
        const deltaX = end.x - start.x;
        const deltaY = end.y - start.y;
        const distance = Math.hypot(deltaX, deltaY);
        if (distance < 1 || (best !== null && distance >= best.distance)) {
            continue;
        }
        const unitX = deltaX / distance;
        const unitY = deltaY / distance;
        const baseX = end.x - unitX * ARROW_LENGTH;
        const baseY = end.y - unitY * ARROW_LENGTH;
        const perpendicularX = -unitY * ARROW_HALF_WIDTH;
        const perpendicularY = unitX * ARROW_HALF_WIDTH;
        best = {
            distance,
            start,
            end,
            arrowPoints: [
                `${end.x},${end.y}`,
                `${baseX + perpendicularX},${baseY + perpendicularY}`,
                `${baseX - perpendicularX},${baseY - perpendicularY}`,
            ].join(" "),
        };
    }
    return best === null
        ? null
        : {
            start: best.start,
            end: best.end,
            arrowPoints: best.arrowPoints,
        };
}

/**
 * Intersect projected sampled bounds with the visible map rectangle.
 *
 * @param {{left:number,top:number,right:number,bottom:number}} sampledRectangle
 * Projected geographic bounds.
 * @param {{left:number,top:number,right:number,bottom:number}} mapRectangle
 * Visible Leaflet container.
 * @return {{left:number,top:number,right:number,bottom:number}|null} Visible
 * sampled rectangle or null when the sampled bounds are outside the map.
 */
function visibleSampleRectangle(sampledRectangle, mapRectangle) {
    const intersection = {
        left: Math.max(sampledRectangle.left, mapRectangle.left),
        top: Math.max(sampledRectangle.top, mapRectangle.top),
        right: Math.min(sampledRectangle.right, mapRectangle.right),
        bottom: Math.min(sampledRectangle.bottom, mapRectangle.bottom),
    };
    return intersection.left < intersection.right &&
        intersection.top < intersection.bottom
        ? intersection
        : null;
}

/** Draw and maintain the dynamic histogram connector in viewport space. */
export class RasterHistogramConnectorView {
    /**
     * Resolve connector markup and projection dependencies.
     *
     * @param {Object} leafletMap Leaflet map with projection and events.
     * @param {Document} [documentContext=globalThis.document] Application DOM.
     * @param {Object} [viewport=globalThis] Window-like resize and observer
     * provider.
     * @throws {Error} If connector markup or required map methods are absent.
     */
    constructor(
        leafletMap,
        documentContext = globalThis.document,
        viewport = globalThis
    ) {
        if (
            typeof leafletMap?.getContainer !== "function" ||
            typeof leafletMap?.latLngToContainerPoint !== "function" ||
            typeof leafletMap?.on !== "function" ||
            typeof leafletMap?.off !== "function"
        ) {
            throw new Error("Histogram connector requires Leaflet projection.");
        }
        this.leafletMap = leafletMap;
        this.viewport = viewport;
        this.mapContainer = leafletMap.getContainer();
        this.histogram = requireRasterControl(
            documentContext,
            "#raster-histogram"
        );
        this.connector = requireRasterControl(
            documentContext,
            "#raster-histogram-connector"
        );
        this.line = requireRasterControl(
            documentContext,
            "#raster-histogram-connector-line"
        );
        this.targetOutline = requireRasterControl(
            documentContext,
            "#raster-histogram-connector-target"
        );
        this.arrow = requireRasterControl(
            documentContext,
            "#raster-histogram-connector-arrow"
        );
        this.samplingBounds = null;
        this.samplingMode = "none";
        this.boundRequestRender = this.#requestRender.bind(this);
        this.frameIdentifier = null;
        this.isBound = false;
        this.mutationObserver = typeof viewport.MutationObserver === "function"
            ? new viewport.MutationObserver(this.boundRequestRender)
            : null;
        this.resizeObserver = typeof viewport.ResizeObserver === "function"
            ? new viewport.ResizeObserver(this.boundRequestRender)
            : null;
    }

    /**
     * Observe map movement, viewport reflow, and histogram disclosure.
     *
     * @return {void}
     * @throws {Error} If the connector is already bound.
     */
    bind() {
        if (this.isBound) {
            throw new Error("Histogram connector view is already bound.");
        }
        this.isBound = true;
        for (const eventName of ["move", "zoom", "resize"]) {
            this.leafletMap.on(eventName, this.boundRequestRender);
        }
        this.viewport.addEventListener?.("resize", this.boundRequestRender);
        this.mutationObserver?.observe(this.histogram, {
            attributes: true,
            attributeFilter: ["hidden"],
        });
        this.resizeObserver?.observe(this.histogram);
        this.resizeObserver?.observe(this.mapContainer);
        this.#requestRender();
    }

    /**
     * Remove every observer and map/viewport listener installed by bind.
     *
     * @return {void}
     */
    unbind() {
        if (!this.isBound) {
            return;
        }
        for (const eventName of ["move", "zoom", "resize"]) {
            this.leafletMap.off(eventName, this.boundRequestRender);
        }
        this.viewport.removeEventListener?.("resize", this.boundRequestRender);
        this.mutationObserver?.disconnect();
        this.resizeObserver?.disconnect();
        if (this.frameIdentifier !== null) {
            this.viewport.cancelAnimationFrame?.(this.frameIdentifier);
            this.frameIdentifier = null;
        }
        this.isBound = false;
        this.#hide();
    }

    /**
     * Set the canonical bounds represented by the current distribution.
     *
     * Whole-raster results intentionally have no connector because no single
     * selected AOI box owns them.
     *
     * @param {Object|null} bounds Canonical selected bounds or null.
     * @param {"none"|"wholeRaster"|"selectedArea"|"temporaryAoi"} mode
     * Sampling-area discriminator used for connector color.
     * @return {void}
     * @throws {Error} If non-null bounds violate the selected-bounds contract.
     */
    setSamplingArea(bounds, mode) {
        this.samplingBounds = bounds === null
            ? null
            : validateRasterSelectedBounds(bounds);
        this.samplingMode = mode;
        this.connector.setAttribute("data-sampling-area", mode);
        this.#requestRender();
    }

    /**
     * Render immediately for deterministic layout and browser tests.
     *
     * @return {void}
     */
    refresh() {
        this.#render();
    }

    /** Schedule no more than one connector render per animation frame. */
    #requestRender() {
        if (!this.isBound || this.frameIdentifier !== null) {
            return;
        }
        if (typeof this.viewport.requestAnimationFrame !== "function") {
            this.#render();
            return;
        }
        this.frameIdentifier = this.viewport.requestAnimationFrame(() => {
            this.frameIdentifier = null;
            this.#render();
        });
    }

    /** Project current bounds and update the SVG endpoints. */
    #render() {
        if (
            this.histogram.hidden ||
            this.samplingBounds === null ||
            !["selectedArea", "temporaryAoi"].includes(this.samplingMode)
        ) {
            this.#hide();
            return;
        }
        const mapRectangle = this.mapContainer.getBoundingClientRect();
        const northWest = this.leafletMap.latLngToContainerPoint([
            this.samplingBounds.north,
            this.samplingBounds.west,
        ]);
        const southEast = this.leafletMap.latLngToContainerPoint([
            this.samplingBounds.south,
            this.samplingBounds.east,
        ]);
        const sampledRectangle = visibleSampleRectangle({
            left: mapRectangle.left + Math.min(northWest.x, southEast.x),
            top: mapRectangle.top + Math.min(northWest.y, southEast.y),
            right: mapRectangle.left + Math.max(northWest.x, southEast.x),
            bottom: mapRectangle.top + Math.max(northWest.y, southEast.y),
        }, mapRectangle);
        const connection = sampledRectangle === null
            ? null
            : nearestRectangleConnector(
                this.histogram.getBoundingClientRect(),
                sampledRectangle
            );
        if (connection === null) {
            this.#hide();
            return;
        }
        this.line.setAttribute("x1", String(connection.start.x));
        this.line.setAttribute("y1", String(connection.start.y));
        this.line.setAttribute("x2", String(connection.end.x));
        this.line.setAttribute("y2", String(connection.end.y));
        this.arrow.setAttribute("points", connection.arrowPoints);
        this.targetOutline.hidden = this.samplingMode !== "temporaryAoi";
        if (!this.targetOutline.hidden) {
            this.targetOutline.setAttribute("x", String(sampledRectangle.left));
            this.targetOutline.setAttribute("y", String(sampledRectangle.top));
            this.targetOutline.setAttribute(
                "width",
                String(sampledRectangle.right - sampledRectangle.left)
            );
            this.targetOutline.setAttribute(
                "height",
                String(sampledRectangle.bottom - sampledRectangle.top)
            );
        }
        this.connector.hidden = false;
    }

    /** Hide the connector without changing its sampling contract. */
    #hide() {
        this.targetOutline.hidden = true;
        this.connector.hidden = true;
    }
}
