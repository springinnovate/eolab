/** Accessible categorical ground-area bars; no sampling or style decisions. */
/** @typedef {import("./categorical-presentation.js").CategoricalAreaPresentation} CategoricalAreaPresentation */
/** @typedef {import("./categorical-presentation.js").CategoricalAreaRow} CategoricalAreaRow */

/**
 * Format estimated hectares without rounding tiny nonzero areas to zero.
 * @param {number} hectares Finite nonnegative ground area.
 * @return {string} Localized four-significant-digit area.
 */
function formatHectares(hectares) {
    return hectares.toLocaleString(undefined, { maximumSignificantDigits: 4 });
}

/**
 * Create one label/code, bar, percentage and hectare row.
 * @param {CategoricalAreaRow} row Trusted presentation row.
 * @param {Document} documentContext Owning document.
 * @return {HTMLElement} Readable row with decorative color and opacity overlays.
 */
function createAreaRow(row, documentContext) {
    const root = documentContext.createElement("div");
    root.className = "categorical-area-row";
    const name = documentContext.createElement("span");
    name.className = "categorical-area-name";
    name.textContent = row.code === null ? row.label : row.label + " (" + row.code + ")";
    name.title = name.textContent;
    const track = documentContext.createElement("span");
    track.className = "categorical-area-track";
    track.setAttribute("aria-hidden", "true");
    const bar = documentContext.createElement("span");
    bar.className = "categorical-area-bar";
    bar.style.width = Math.min(100, row.percentage) + "%";
    const fill = documentContext.createElement("span");
    fill.className = "categorical-area-fill";
    fill.style.backgroundColor = row.color;
    fill.style.opacity = String(row.opacity);
    bar.append(fill);
    track.append(bar);
    const percent = documentContext.createElement("span");
    percent.className = "categorical-area-number";
    percent.textContent = row.percentage > 0 && row.percentage < 0.1
        ? "<0.1%" : row.percentage.toLocaleString(undefined, { maximumFractionDigits: 1 }) + "%";
    const hectares = documentContext.createElement("span");
    hectares.className = "categorical-area-number";
    hectares.textContent = formatHectares(row.hectares) + " ha";
    root.append(name, track, percent, hectares);
    return root;
}

/**
 * Build a bounded categorical distribution with a keyboard-accessible expansion.
 * The first twelve rows retain an aggregated remainder; expansion exposes every
 * category. Opacity affects only the fill over a hatch, never the numeric text.
 * @param {CategoricalAreaPresentation} presentation Prepared numeric and style rows.
 * @param {Document} documentContext Owning document.
 * @param {Object} [options={}] View-owned expansion preferences.
 * @param {boolean} [options.expanded=false] Initially expose all rows.
 * @param {(expanded:boolean)=>void} [options.onExpandedChange] Retain expansion.
 * @return {HTMLElement} Chart region with readable totals and estimate provenance.
 */
export function createCategoricalRasterHistogram(presentation, documentContext, options = {}) {
    const root = documentContext.createElement("div");
    root.className = "categorical-area-chart";
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "Estimated categorical ground area");
    const heading = documentContext.createElement("p");
    heading.className = "categorical-area-caption";
    heading.textContent = "Estimated ground area · % of valid area · hectares";
    const rows = documentContext.createElement("div");
    rows.className = "categorical-area-rows";
    const toggle = documentContext.createElement("button");
    toggle.type = "button";
    toggle.className = "secondary-button categorical-area-toggle";
    toggle.hidden = presentation.rows.length <= 12;
    let expanded = options.expanded ?? false;
    /** Update only the row list, preserving the expansion button's focus. @return {void} */
    function renderRows() {
        const visible = expanded ? presentation.rows : presentation.rows.slice(0, 12);
        const elements = visible.map((row) => createAreaRow(row, documentContext));
        if (!expanded && presentation.rows.length > 12) {
            const remaining = presentation.rows.slice(12);
            elements.push(createAreaRow({ label: remaining.length + " more categories", code: null,
                color: "#808080", opacity: 1,
                hectares: remaining.reduce((sum, row) => sum + row.hectares, 0),
                percentage: remaining.reduce((sum, row) => sum + row.percentage, 0),
            }, documentContext));
        }
        rows.replaceChildren(...elements);
        toggle.textContent = expanded ? "Show largest 12 categories" : "Show all " + presentation.rows.length + " categories";
        toggle.setAttribute("aria-expanded", String(expanded));
    }
    toggle.addEventListener("click", () => {
        expanded = !expanded;
        renderRows();
        options.onExpandedChange?.(expanded);
    });
    renderRows();
    const note = documentContext.createElement("p");
    note.className = "categorical-area-caption";
    note.textContent = "Valid: " + formatHectares(presentation.validHectares) + " ha. " +
        "NoData excluded: " + formatHectares(presentation.nodataHectares) + " ha. " +
        presentation.sampledPixelCount.toLocaleString() + " native samples; area-weighted estimates. " +
        "Thin or rare categories may be missed by sampling.";
    root.append(heading, rows, toggle, note);
    return root;
}
