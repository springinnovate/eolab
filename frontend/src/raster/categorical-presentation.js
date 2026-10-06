/** Display-only projections of committed raster categories and sampled values. */

/** @typedef {import("./categorical-style.js").CategoricalRasterStyle} CategoricalRasterStyle */
/** @typedef {import("../map-layers/layer-stack-view.js").LayerLegend} LayerLegend */

/**
 * Raw pixel outcome with optional display text supplied by composition.
 *
 * @typedef {Object} RasterPixelPresentationSample
 * @property {string} key Stable participant identity.
 * @property {string} label Readable raster name.
 * @property {"X"|"Y"|null} [axis] Optional point-sample axis.
 * @property {"loading"|"value"|"nodata"|"outside"|"error"} state Raw outcome.
 * @property {number|null} value Finite sampled value only in value state.
 * @property {string} errorMessage Failure detail only in error state.
 * @property {string} [displayValue] Prepared categorical label and exact code.
 */

/**
 * Point or cursor result whose geographic identity remains independent of style.
 *
 * @typedef {Object} RasterPixelPresentationSnapshot
 * @property {Readonly<{longitude:number,latitude:number}>} position Sample point.
 * @property {ReadonlyArray<Readonly<RasterPixelPresentationSample>>} samples Outcomes.
 * @property {number} [omittedCount] Additional cursor participants beyond its cap.
 */

/**
 * Express a finite sampled number in plain decimal notation without rounding.
 * Expands only the exponent in JavaScript's round-trip number representation;
 * it does not invent precision that the numeric source response did not retain.
 *
 * @param {number} value Finite value established by the sampling contract.
 * @return {string} Full round-trip decimal representation without an exponent.
 */
function formatExactRasterCode(value) {
    const text = String(value);
    if (!text.includes("e")) return text;
    const [coefficient, exponent] = text.split("e");
    const sign = coefficient.startsWith("-") ? "-" : "";
    const unsigned = sign === "" ? coefficient : coefficient.slice(1);
    const decimal = unsigned.indexOf(".");
    const digits = unsigned.replace(".", "");
    const position = (decimal === -1 ? unsigned.length : decimal) + Number(exponent);
    if (position <= 0) return `${sign}0.${"0".repeat(-position)}${digits}`;
    if (position >= digits.length) {
        return `${sign}${digits}${"0".repeat(position - digits.length)}`;
    }
    return `${sign}${digits.slice(0, position)}.${digits.slice(position)}`;
}

/**
 * Describe one raster fill using the existing neutral legend symbol contract.
 *
 * @param {{color:string,opacity:number}} appearance Normalized row or fallback.
 * @return {Readonly<import("../map-layers/layer-stack-view.js").LegendSymbol>}
 * Immutable fill symbol; the consuming view applies whole-layer opacity.
 */
function categoryLegendSymbol(appearance) {
    return Object.freeze({
        shape: "polygon",
        fill: appearance.color,
        fillOpacity: appearance.opacity,
        stroke: appearance.color,
        strokeOpacity: 0,
        strokeWidth: 0,
    });
}

/**
 * Project an already normalized category table into the neutral legend contract.
 * Entries retain table order and exact codes, followed by the unmapped fallback.
 * Transparent entries remain present; source NoData is not a category.
 *
 * @param {Readonly<CategoricalRasterStyle>} style Committed normalized style.
 * @return {Readonly<LayerLegend>} Deeply frozen category legend.
 */
export function buildCategoricalRasterLegend(style) {
    const entries = style.categories.map((category) => Object.freeze({
        label: `${category.label} (${formatExactRasterCode(category.value)})`,
        symbol: categoryLegendSymbol(category),
    }));
    entries.push(Object.freeze({
        label: "Unmapped",
        symbol: categoryLegendSymbol(style.unmapped),
    }));
    return Object.freeze({
        kind: "categories",
        label: "Categories",
        description: `${style.categories.length} ${style.categories.length === 1 ? "category" : "categories"} and unmapped values`,
        entries: Object.freeze(entries),
    });
}

/**
 * Project pixel results through the current committed layer appearance.
 * Exact equality determines membership, including transparent categories. The
 * numeric value and state are never changed, rounded, or used to authorize a
 * read. Non-value outcomes and continuous layers have no display override.
 * Re-projecting removes any prior override, so mode changes use the same raw
 * result without another sample. Inputs already satisfy their owning contracts.
 *
 * @param {Readonly<RasterPixelPresentationSnapshot>|null} snapshot Raw or
 * previously projected sample snapshot; null represents a cleared result.
 * @param {(key:string)=>Readonly<CategoricalRasterStyle>|null} resolveStyle
 * Composition callback returning the committed categorical style, or null.
 * @return {Readonly<RasterPixelPresentationSnapshot>|null} Deeply frozen copy.
 * @throws {Error} If the injected style resolver fails.
 */
export function presentRasterPixelSnapshot(snapshot, resolveStyle) {
    if (snapshot === null) return null;
    const samples = snapshot.samples.map((sample) => {
        const { displayValue: _previousDisplayValue, ...result } = sample;
        const style = sample.state === "value" ? resolveStyle(sample.key) : null;
        if (style !== null) {
            const category = style.categories.find((row) => row.value === sample.value);
            result.displayValue = `${category?.label ?? "Unmapped"} (${formatExactRasterCode(sample.value)})`;
        }
        return Object.freeze(result);
    });
    return Object.freeze({
        ...snapshot,
        position: Object.freeze({ ...snapshot.position }),
        samples: Object.freeze(samples),
    });
}
