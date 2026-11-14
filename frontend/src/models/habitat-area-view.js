/** Present saved preparation areas and current coverage in Habitat setup. */
import { captureHabitatPreparedArea } from "./inputs.js";

/** Keep the Earth Engine area chooser separate from manual area and reference controls. */
export class HabitatAreaView {
    /** Create stable area, coverage and retry controls using the existing form helpers.
     * @param {Object} helpers Existing Models element/field/options/button helpers.
     * @param {(tag:string,text?:string,className?:string)=>HTMLElement} helpers.element Create text-only elements.
     * @param {(id:string,caption:string,input:HTMLElement)=>HTMLLabelElement} helpers.field Label a control.
     * @param {(select:HTMLSelectElement,choices:Object[],selected:string)=>void} helpers.options Update select choices.
     * @param {(label:string,action:()=>void,className?:string)=>HTMLButtonElement} helpers.button Create an action.
     * @param {{onHabitatArea:(id:string)=>void,onRefreshHabitatAreas:()=>void,onRefreshHabitatCoverage:()=>void}} handlers Controller-owned selection and retries.
     * @param {string} name Recipe input name for unique accessible IDs.
     * @param {string} label Analysis-area label supplied by the recipe.
     */
    constructor({element, field, options, button}, handlers, name, label) {
        this.options = options;
        this.root = element("div", "", "models-spatial-input");
        this.source = element("select"); this.source.required = true;
        this.source.addEventListener("change", () => handlers.onHabitatArea(this.source.value));
        this.help = element("p", "Choose an area saved by the administrator for input preparation.", "models-help");
        this.status = element("p", "", "models-help"); this.status.setAttribute("role", "status");
        this.status.id = "models-" + name + "-prepared-coverage";
        this.source.setAttribute("aria-describedby", this.status.id);
        this.refresh = button("Refresh saved areas", handlers.onRefreshHabitatAreas, "models-action");
        this.retry = button("Check coverage again", handlers.onRefreshHabitatCoverage, "models-action");
        this.root.append(field("models-" + name + "-prepared-area", "Prepared " + label.toLowerCase(), this.source), this.help, this.status, this.refresh, this.retry);
    }

    /** Show readiness and missing-input warnings without changing the selected area.
     * @param {Object} draft Habitat draft with active year and current area/coverage state.
     * @return {boolean} Whether a selected area has any prepared input tiles.
     */
    render(draft) {
        const value = draft.habitatArea;
        this.options(this.source, [{value: "", label: "Choose a saved preparation area…"},
            ...value.areas.map(area => ({value: area.id, label: area.name}))], value.selectedId);
        this.source.disabled = value.loading || !value.loaded || Boolean(value.error) || !value.areas.length;
        this.refresh.disabled = value.loading;
        this.refresh.textContent = value.loading ? "Loading saved areas…" : "Refresh saved areas";
        this.retry.hidden = !value.selectedId || value.loading || Boolean(value.error);
        this.retry.disabled = value.coverageLoading;
        let error = "";
        try { captureHabitatPreparedArea(draft); } catch (problem) { error = problem.message; }
        const coverage = value.coverage;
        this.status.textContent = error || (coverage.missingTiles
            ? "Prepared inputs cover " + coverage.cachedTiles + " of " + coverage.requiredTiles + " tiles. You can run, but results will be missing where inputs are unavailable."
            : "Prepared inputs cover all " + coverage.requiredTiles + " required tiles.");
        return !error;
    }
}
