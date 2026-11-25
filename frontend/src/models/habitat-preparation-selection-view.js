/** Present Catalog preparation selections and their current coverage in Habitat setup. */
import { vectorSelectionsEqual } from "../selected-area.js";

/** Keep Catalog preparation choices separate from manual area and reference controls. */
export class HabitatPreparationSelectionView {
    /** Create the area chooser, map outline toggle and coverage status.
     * @param {Object} helpers Existing Models form and selection helpers.
     * @param {(draft:Object)=>Object} helpers.captureSelection Capture the chosen prepared Catalog features.
     * @param {(filter:Object)=>string} helpers.describeFilter Describe the exact feature predicate.
     * @param {(source:Object)=>string} helpers.sourceKey Identify the Catalog Item for display titles.
     * @param {(tag:string,text?:string,className?:string)=>HTMLElement} helpers.element Create text-only elements.
     * @param {(id:string,caption:string,input:HTMLElement)=>HTMLLabelElement} helpers.field Label a control.
     * @param {(select:HTMLSelectElement,choices:Object[],selected:string)=>void} helpers.options Update select choices.
     * @param {{onHabitatPreparationSelection:(selection:Object|null)=>void,onShowOutline:(visible:boolean)=>void}} handlers Choose an area or change its map visibility.
     * @param {string} name Recipe input name for unique accessible IDs.
     * @param {string} label Analysis-area label supplied by the recipe.
     */
    constructor({element, field, options, captureSelection, describeFilter, sourceKey}, handlers, name, label) {
        Object.assign(this, {options, captureSelection, describeFilter, sourceKey}); this.selections = [];
        this.root = element("div", "", "models-spatial-input");
        this.source = element("select"); this.source.required = true;
        this.source.addEventListener("change", () => handlers.onHabitatPreparationSelection(
            this.source.value === "" ? null : this.selections[Number(this.source.value)]));
        this.help = element("p", "Areas are configured by your administrator.", "models-help");
        this.selectionDetails = element("p", "", "models-help");
        this.sourceDetails = element("details", "", "models-details");
        this.sourceDetails.append(element("summary", "Area source"), this.selectionDetails);
        this.status = element("p", "", "models-help"); this.status.setAttribute("role", "status");
        this.status.id = "models-" + name + "-prepared-coverage";
        this.source.setAttribute("aria-describedby", this.status.id);
        this.outline = element("input"); this.outline.type = "checkbox";
        this.outline.addEventListener("change", () => handlers.onShowOutline(this.outline.checked));
        const outlineField = field("models-" + name + "-outline", "Show analysis area on map", this.outline);
        outlineField.classList.add("models-boolean");
        this.outlineStatus = element("p", "", "models-help"); this.outlineStatus.setAttribute("role", "status");
        this.root.append(field("models-" + name + "-preparation-selection", label, this.source),
            outlineField, this.outlineStatus, this.help, this.sourceDetails, this.status);
    }

    /** Show the selected Catalog polygons, their outline status and prepared-input coverage.
     * Preserve full titles without repeating an already named trailing layer.
     * Option indexes belong only to this DOM list; the controller receives the descriptor.
     * @param {Object} draft Habitat draft with selections, optional Catalog titles and coverage.
     * @return {boolean} Whether a selected Catalog descriptor has any prepared input tiles.
     */
    render(draft) {
        const value = draft.setupState;
        this.selections = value.selections;
        const selectedIndex = value.selections.findIndex(selection => vectorSelectionsEqual(selection, value.selectedSelection));
        const identities = value.selections.map(selection =>
            `${selection.collectionId} / ${selection.itemId} / ${selection.assetKey}`);
        const labels = value.selections.map(selection => {
            const title = value.titles[this.sourceKey(selection)];
            const name = title && title !== selection.itemId ? title : selection.layerName;
            const layerAlreadyNamed = name === selection.layerName || name.endsWith(` — ${selection.layerName}`);
            return [name, layerAlreadyNamed ? null : selection.layerName, this.describeFilter(selection.filter)]
                .filter(part => part !== null).join(" · ");
        });
        const labelCounts = new Map();
        for (const label of labels) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
        this.options(this.source, [{value: "", label: "Choose an area…"},
            ...labels.map((label, index) => ({value: String(index),
                label: labelCounts.get(label) > 1 ? `${label} · Source: ${identities[index]}` : label}))], selectedIndex < 0 ? "" : String(selectedIndex));
        this.selectionDetails.textContent = selectedIndex < 0 ? "" : `${labels[selectedIndex]} · Source: ${identities[selectedIndex]}`;
        this.sourceDetails.hidden = selectedIndex < 0;
        this.source.disabled = value.loading || !value.loaded || Boolean(value.error) || !value.selections.length;
        this.outline.disabled = this.source.disabled || selectedIndex < 0;
        this.outline.checked = value.outlineStatus === "loading" || value.outlineStatus === "visible";
        this.outlineStatus.textContent = value.outlineStatus === "loading" ? "Loading area outline…"
            : value.outlineStatus === "unavailable" ? "Could not show the area outline. Select the checkbox to try again." : "";
        this.outlineStatus.hidden = !this.outlineStatus.textContent;
        const choosingArea = value.loaded && !value.loading && !value.error && value.selections.length > 0 &&
            selectedIndex < 0 && !value.unavailable;
        this.status.hidden = choosingArea;
        if (choosingArea) { this.status.textContent = ""; return false; }
        let error = "";
        try { this.captureSelection(draft); } catch (problem) { error = problem.message; }
        const coverage = value.coverage;
        this.status.textContent = error || (coverage.missingTiles
            ? "Prepared inputs cover " + coverage.cachedTiles + " of " + coverage.requiredTiles + " tiles. You can run, but results will be missing where inputs are unavailable."
            : "Prepared inputs cover all " + coverage.requiredTiles + " required tiles.");
        return !error;
    }
}
