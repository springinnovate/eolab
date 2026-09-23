/** Latitude/longitude rulers and a pointer crosshair for the Leaflet viewport. */

/**
 * Choose a readable degree interval with roughly one label per 100 pixels.
 * @param {number} degrees Visible geographic span.
 * @param {number} pixels Available axis length.
 * @return {number} Tick interval using 1, 2 or 5 times a power of ten, capped at 180°.
 */
export function coordinateTickInterval(degrees, pixels) {
    const desired = Math.max(degrees, 1e-9) / Math.max(1, pixels / 100);
    const magnitude = 10 ** Math.floor(Math.log10(desired));
    return Math.min(180, [1, 2, 5, 10].find(value => value * magnitude >= desired) * magnitude);
}

/**
 * Format decimal degrees with a direction and enough precision for the interval.
 * @param {number} value Latitude or longitude in degrees.
 * @param {"latitude"|"longitude"} axis Geographic axis.
 * @param {number} interval Tick interval or pointer precision in degrees.
 * @return {string} Degree label; zero has no direction suffix.
 */
export function formatCoordinate(value, axis, interval) {
    const digits = Math.min(8, Math.max(0, -Math.floor(Math.log10(interval))));
    const rounded = Number(value.toFixed(digits));
    const suffix = rounded === 0 ? "" : axis === "latitude"
        ? (rounded < 0 ? "S" : "N") : (rounded < 0 ? "W" : "E");
    return `${Math.abs(rounded).toFixed(digits)}°${suffix}`;
}

/**
 * List canonical tick values for one visible geographic axis.
 * @param {number} minimum Lower viewport coordinate.
 * @param {number} maximum Upper viewport coordinate.
 * @param {number} interval Tick interval in degrees.
 * @param {number} limit Absolute canonical coordinate limit.
 * @return {number[]} Ordered tick values within the viewport and domain.
 */
export function coordinateTicks(minimum, maximum, interval, limit) {
    const first = Math.ceil(Math.max(minimum, -limit) / interval);
    const last = Math.floor(Math.min(maximum, limit) / interval);
    return Array.from({length: Math.max(0, last - first + 1)}, (_, index) => (first + index) * interval);
}

/**
 * Add optional edge rulers and a mouse crosshair without changing map interaction.
 * The guide follows Leaflet's projection and stays within its single world.
 * @param {Object} leaflet Leaflet namespace.
 * @param {Object} map Initialized Leaflet map.
 * @return {Object} Leaflet control; removing it releases all guide listeners.
 */
export function addMapCoordinateGuide(leaflet, map) {
    const container = map.getContainer();
    const doc = container.ownerDocument;
    const view = doc.defaultView;
    const control = leaflet.control({position: "bottomleft"});
    let enabled = true, frame = null, svg, ticks, crosshair, button;
    let longitudeInterval = 1, latitudeInterval = 1;

    /**
     * Create a presentation-only SVG element.
     * @param {string} tag SVG tag.
     * @param {Object<string,string|number>} attributes SVG attributes.
     * @param {string} [text] Optional label.
     * @return {SVGElement} Detached element.
     */
    function element(tag, attributes, text) {
        const node = doc.createElementNS("http://www.w3.org/2000/svg", tag);
        for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
        if (text !== undefined) node.textContent = text;
        return node;
    }

    /** Clear the pointer marker when it no longer describes the current map. @return {void} */
    function clearPointer() { crosshair.replaceChildren(); }

    /** Draw edge ticks against the current projected viewport. @return {void} */
    function drawTicks() {
        frame = null;
        if (!enabled) return;
        const {x: width, y: height} = map.getSize();
        const bounds = map.getBounds();
        longitudeInterval = coordinateTickInterval(bounds.getEast() - bounds.getWest(), width);
        latitudeInterval = coordinateTickInterval(bounds.getNorth() - bounds.getSouth(), height);
        svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        ticks.replaceChildren();
        for (const lng of coordinateTicks(bounds.getWest(), bounds.getEast(), longitudeInterval, 180)) {
            const {x} = map.latLngToContainerPoint([0, lng]);
            if (x < 65 || x > width - 65) continue;
            const text = formatCoordinate(lng, "longitude", longitudeInterval);
            for (const [y, direction] of [[0, 1], [height, -1]]) {
                ticks.append(element("line", {x1: x, x2: x, y1: y, y2: y + direction * 5}));
                ticks.append(element("text", {x, y: y + (direction > 0 ? 17 : -8), "text-anchor": "middle"}, text));
            }
        }
        let previousY = Infinity;
        for (const lat of coordinateTicks(bounds.getSouth(), bounds.getNorth(), latitudeInterval, 85.0511287798066)) {
            const {y} = map.latLngToContainerPoint([lat, 0]);
            if (y < 32 || y > height - 32 || previousY - y < 48) continue;
            previousY = y;
            const text = formatCoordinate(lat, "latitude", latitudeInterval);
            ticks.append(element("line", {x1: 0, x2: 5, y1: y, y2: y}));
            ticks.append(element("text", {x: 8, y: y + 3}, text));
            ticks.append(element("line", {x1: width, x2: width - 5, y1: y, y2: y}));
            ticks.append(element("text", {x: width - 8, y: y + 3, "text-anchor": "end"}, text));
        }
    }

    /** Coalesce pan, zoom and resize updates into one frame. @return {void} */
    function scheduleTicks() {
        clearPointer();
        if (enabled && frame === null) frame = view.requestAnimationFrame(drawTicks);
    }

    /**
     * Follow the pointer while it is over geographic map content.
     * @param {MouseEvent} event Native map mouse event, including feature targets.
     * @return {void}
     */
    function trackPointer(event) {
        if (!enabled || event.buttons || event.target.closest(".leaflet-control, .map-tool-openers")) {
            clearPointer();
            return;
        }
        const {x, y} = map.mouseEventToContainerPoint(event);
        const {lat, lng} = map.containerPointToLatLng([x, y]);
        if (Math.abs(lng) > 180 || Math.abs(lat) > 85.0511287798066) {
            clearPointer();
            return;
        }
        const {x: width, y: height} = map.getSize();
        const longitude = formatCoordinate(lng, "longitude", Math.min(0.0001, longitudeInterval / 10));
        const latitude = formatCoordinate(lat, "latitude", Math.min(0.0001, latitudeInterval / 10));
        crosshair.replaceChildren(
            element("line", {x1: x, x2: x, y1: 0, y2: height}),
            element("line", {x1: 0, x2: width, y1: y, y2: y}),
        );
        const labelX = Math.max(60, Math.min(width - 60, x));
        const labelY = Math.max(35, Math.min(height - 30, y));
        for (const [tx, ty, anchor, text] of [
            [labelX, 17, "middle", longitude], [labelX, height - 8, "middle", longitude],
            [8, labelY + 3, "start", latitude], [width - 8, labelY + 3, "end", latitude],
        ]) {
            const left = anchor === "middle" ? tx - 56 : anchor === "end" ? tx - 112 : tx - 3;
            crosshair.append(element("rect", {x: left, y: ty - 12, width: 115, height: 17, rx: 2}));
            crosshair.append(element("text", {x: tx, y: ty, "text-anchor": anchor}, text));
        }
    }

    /** Toggle the guide and its accessible button state. @return {void} */
    function toggleGuide() {
        enabled = !enabled;
        svg.style.display = enabled ? "" : "none";
        container.classList.toggle("has-coordinate-guide", enabled);
        button.setAttribute("aria-pressed", String(enabled));
        scheduleTicks();
    }

    /**
     * Keep focused-control keystrokes from also moving the map.
     * @param {KeyboardEvent} event Control key event.
     * @return {void}
     */
    function stopMapKeys(event) { event.stopPropagation(); }

    /** Build the toggle and map overlay, then attach presentation listeners. @return {HTMLElement} */
    control.onAdd = function onAdd() {
        button = doc.createElement("button");
        button.type = "button";
        button.className = "coordinate-guide-toggle secondary-button";
        button.textContent = "Coordinates";
        button.title = "Show latitude/longitude rulers and pointer crosshair";
        button.setAttribute("aria-pressed", "true");
        leaflet.DomEvent.disableClickPropagation(button);
        leaflet.DomEvent.disableScrollPropagation(button);
        button.addEventListener("click", toggleGuide);
        button.addEventListener("keydown", stopMapKeys);
        svg = element("svg", {class: "map-coordinate-guide", "aria-hidden": "true"});
        ticks = element("g", {class: "coordinate-ticks"});
        crosshair = element("g", {class: "coordinate-crosshair"});
        svg.append(ticks, crosshair);
        container.append(svg);
        container.classList.add("has-coordinate-guide");
        container.addEventListener("mousemove", trackPointer);
        container.addEventListener("mouseleave", clearPointer);
        container.addEventListener("mousedown", clearPointer);
        map.on("move zoom resize", scheduleTicks);
        drawTicks();
        return button;
    };

    /** Remove the overlay, pending frame and all installed listeners. @return {void} */
    control.onRemove = function onRemove() {
        if (frame !== null) view.cancelAnimationFrame(frame);
        button.removeEventListener("click", toggleGuide);
        button.removeEventListener("keydown", stopMapKeys);
        container.removeEventListener("mousemove", trackPointer);
        container.removeEventListener("mouseleave", clearPointer);
        container.removeEventListener("mousedown", clearPointer);
        container.classList.remove("has-coordinate-guide");
        map.off("move zoom resize", scheduleTicks);
        svg.remove();
    };
    return control.addTo(map);
}
