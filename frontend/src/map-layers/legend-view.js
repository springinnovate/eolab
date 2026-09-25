/** Shared DOM rendering for layer-list and on-map legends. */
/** @typedef {import('./layer-stack-view.js').LayerLegend} LayerLegend */
/** @typedef {import('./layer-stack-view.js').LegendSymbol} LegendSymbol */
/**
 * Draw a representative polygon, line, or point using its fill and stroke settings.
 * Large strokes and points are scaled to fit the compact key.
 * @param {Document} documentContext Owning document.
 * @param {LegendSymbol} symbol Adapter-supplied geometry appearance.
 * @param {number} opacity Effective layer opacity, from zero through one.
 * @return {SVGElement} Decorative symbol with independent fill and stroke opacity.
 */
export function buildLegendSymbol(documentContext, symbol, opacity) {
    const svg = documentContext.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 28 22");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const tag = symbol.shape === "point" ? "circle" : symbol.shape === "line" ? "path" : "rect";
    const shape = documentContext.createElementNS("http://www.w3.org/2000/svg", tag);
    const dimensions = tag === "circle" ? { cx: 14, cy: 11, r: Math.min(symbol.pointSize / 2, 8) }
        : tag === "path" ? { d: "M 3 17 L 11 6 L 18 15 L 25 5" }
        : { x: 4, y: 4, width: 20, height: 14, rx: 1 };
    for (const [name, value] of Object.entries(dimensions)) shape.setAttribute(name, String(value));
    shape.setAttribute("fill", symbol.fill ?? "none");
    shape.setAttribute("fill-opacity", String(symbol.fillOpacity * opacity));
    shape.setAttribute("stroke", symbol.stroke);
    shape.setAttribute("stroke-opacity", String(symbol.strokeOpacity * opacity));
    shape.setAttribute("stroke-width", String(Math.min(symbol.strokeWidth, 6)));
    shape.setAttribute("stroke-linecap", "round");
    shape.setAttribute("stroke-linejoin", "round");
    svg.append(shape);
    return svg;
}

/**
 * Draw the raster owner's color ramp over a transparency checkerboard.
 * @param {Document} documentContext Owning document.
 * @param {LayerLegend} legend Raster gradient and text alternative.
 * @param {number} opacity Effective layer opacity.
 * @return {HTMLSpanElement} Decorative gradient strip.
 */
export function buildLegendGradient(documentContext, legend, opacity) {
    const background = documentContext.createElement("span");
    background.className = "map-layer-legend-gradient";
    background.setAttribute("aria-hidden", "true");
    const ramp = documentContext.createElement("span");
    ramp.style.background = legend.gradient;
    ramp.style.opacity = String(opacity);
    background.append(ramp);
    return background;
}


/**
 * Draw the complete symbol key or color ramp supplied by a layer owner.
 * @param {Document} documentContext Owning document.
 * @param {LayerLegend} legend Layer-owned legend snapshot.
 * @param {number} opacity Effective whole-layer opacity.
 * @return {HTMLDivElement} All legend entries, without disclosure or styling controls.
 */
export function buildLegendContents(documentContext, legend, opacity) {
    const details = documentContext.createElement("div");
    details.className = "map-layer-legend-contents";
    const field = documentContext.createElement("span");
    field.className = "map-layer-legend-field";
    field.textContent = typeof legend.label === "string" ? legend.label : "";
    details.append(field);
    if (legend.kind === "gradient") {
        const ramp = buildLegendGradient(documentContext, legend, opacity);
        ramp.title = legend.description;
        const labels = documentContext.createElement("div");
        labels.className = "map-layer-legend-values";
        for (const [index, value] of legend.labels.entries()) {
            const text = documentContext.createElement("span");
            const caption = documentContext.createElement("span");
            caption.className = "map-layer-legend-value-label";
            caption.textContent = ["Minimum", "Midpoint", "Maximum"][index];
            const number = documentContext.createElement("span");
            number.textContent = String(value);
            text.append(caption, number);
            labels.append(text);
        }
        details.append(ramp, labels);
        return details;
    }
    const list = documentContext.createElement("ul");
    list.className = "map-layer-legend-list";
    for (const entry of (legend.entries ?? (legend.symbol ? [{ label: legend.label ?? "", symbol: legend.symbol }] : []))) {
        const item = documentContext.createElement("li");
        const swatch = documentContext.createElement("span");
        swatch.className = "map-layer-legend-swatch";
        swatch.append(buildLegendSymbol(documentContext, entry.symbol, opacity));
        swatch.setAttribute("aria-hidden", "true");
        const text = documentContext.createElement("span");
        text.textContent = entry.label;
        item.append(swatch, text);
        list.append(item);
    }
    details.append(list);
    return details;
}
