/** Present Catalog preparation selections and their current coverage in Habitat setup. */
import { captureHabitatPreparationSelection, describeModelFilter, modelSourceKey } from "./inputs.js";
import { vectorSelectionsEqual } from "../selected-area.js";

/** Keep Catalog preparation choices separate from manual area and reference controls. */
export class HabitatPreparationSelectionView {
    /** Create stable selection, coverage and retry controls with existing form helpers.
     * @param {Object} helpers Existing Models element/field/options/button helpers.
     * @param {(tag:string,text?:string,className?:string)=>HTMLElement} helpers.element Create text-only elements.
     * @param {(id:string,caption:string,input:HTMLElement)=>HTMLLabelElement} helpers.field Label a control.
     * @param {(select:HTMLSelectElement,choices:Object[],selected:string)=>void} helpers.options Update select choices.
     * @param {(label:string,action:()=>void,className?:string)=>HTMLButtonElement} helpers.button Create an action.
     * @param {{onHabitatPreparationSelection:(selection:Object|null)=>void,onRefreshHabitatPreparationSelections:()=>void,onRefreshHabitatCoverage:()=>void}} handlers Controller-owned selection and retries.
     * @param {string} name Recipe input name for unique accessible IDs.
     * @param {string} label Analysis-area label supplied by the recipe.
     */
    constructor({element, field, options, button}, handlers, name, label) {
        this.options = options; this.selections = [];
        this.root = element("div", "", "models-spatial-input");
        this.source = element("select"); this.source.required = true;
        this.source.addEventListener("change", () => handlers.onHabitatPreparationSelection(
            this.source.value === "" ? null : this.selections[Number(this.source.value)]));
        this.help = element("p", "Choose Catalog features used by the administrator for input preparation. The listed filters define each analysis area.", "models-help");
        this.selectionDetails = element("p", "", "models-help"); this.selectionDetails.id = "models-" + name + "-preparation-selection-details";
        this.status = element("p", "", "models-help"); this.status.setAttribute("role", "status");
        this.status.id = "models-" + name + "-prepared-coverage";
        this.source.setAttribute("aria-describedby", this.selectionDetails.id + " " + this.status.id);
        this.refresh = button("Refresh preparation selections", handlers.onRefreshHabitatPreparationSelections, "models-action");
        this.retry = button("Check coverage again", handlers.onRefreshHabitatCoverage, "models-action");
        this.root.append(field("models-" + name + "-preparation-selection", "Prepared " + label.toLowerCase(), this.source),
            this.help, this.selectionDetails, this.status, this.refresh, this.retry);
    }

    /** Show exact Catalog layers and filters, readiness and missing-input warnings.
     * Option indexes belong only to this DOM list; the controller receives the descriptor.
     * @param {Object} draft Habitat draft with selections, optional Catalog titles and coverage.
     * @return {boolean} Whether a selected Catalog descriptor has any prepared input tiles.
     */
    render(draft) {
        const value = draft.habitatPreparationSelections;
        this.selections = value.selections;
        const selectedIndex = value.selections.findIndex(selection => vectorSelectionsEqual(selection, value.selectedSelection));
        const labels = value.selections.map(selection => (value.titles[modelSourceKey(selection)] ?? selection.itemId) +
            " · " + selection.layerName + " · " + describeModelFilter(selection.filter));
        this.options(this.source, [{value: "", label: "Choose Catalog features with prepared inputs…"},
            ...labels.map((label, index) => ({value: String(index), label}))], selectedIndex < 0 ? "" : String(selectedIndex));
        this.selectionDetails.textContent = selectedIndex < 0 ? "" : labels[selectedIndex];
        this.selectionDetails.hidden = selectedIndex < 0;
        this.source.disabled = value.loading || !value.loaded || Boolean(value.error) || !value.selections.length;
        this.refresh.disabled = value.loading;
        this.refresh.textContent = value.loading ? "Loading preparation selections…" : "Refresh preparation selections";
        this.retry.hidden = selectedIndex < 0 || value.loading || Boolean(value.error);
        this.retry.disabled = value.coverageLoading;
        let error = "";
        try { captureHabitatPreparationSelection(draft); } catch (problem) { error = problem.message; }
        const coverage = value.coverage;
        this.status.textContent = error || (coverage.missingTiles
            ? "Prepared inputs cover " + coverage.cachedTiles + " of " + coverage.requiredTiles + " tiles. You can run, but results will be missing where inputs are unavailable."
            : "Prepared inputs cover all " + coverage.requiredTiles + " required tiles.");
        return !error;
    }
}
