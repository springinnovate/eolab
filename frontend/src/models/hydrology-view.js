/** Present the prepared terrain and watershed dataset selected for a model. */
import { hydrologyKey, hydrologyReference } from "../processing/hydrology.js";
import { modelSourceKey } from "./inputs.js";

/** Describe a dataset's sources and registration or validation evidence.
 * @param {Object} snapshot Checked or captured hydrology report.
 * @param {Object[]} sources Current map source labels, used only for display.
 * @return {Array<[string,string]>} Dataset and topology details.
 */
export function hydrologyDetails(snapshot, sources = []) {
    const definition = snapshot.definition, topology = definition.topology;
    /** Find a human-readable source label without changing its identity.
     * @param {Object} source Catalog reference.
     * @return {string} Map label or catalog identity.
     */
    const sourceLabel = source => sources.find(value => modelSourceKey(value) === modelSourceKey(source))?.label ?? `${source.collectionId} / ${source.itemId}`;
    return [
        ["Dataset", `${definition.title} · version ${definition.version}`],
        ["Description", definition.description],
        ["Elevation raster", sourceLabel(definition.dem)],
        ["Watershed layer", sourceLabel(definition.watersheds)],
        ["Watershed ID field", topology.idField],
        ["Next downstream ID field", topology.downstreamField],
        ["Stop when", `${topology.terminal.field} equals ${topology.terminal.equalsField ?? JSON.stringify(topology.terminal.value)}`],
        ...(topology.terminalIdField ? [["Terminal watershed ID field", topology.terminalIdField]] : []),
        ["Terrain version", definition.terrain.datasetVersion],
        ["Terrain preparation", definition.terrain.conditioning],
        [snapshot.validation.validator === "eolab.hydrology-registration/v1" ? "Registered" : "Validated",
            new Date(snapshot.validation.validatedAt).toLocaleString()],
    ];
}

/** Keep dataset choices, source checks and expandable mappings together in setup. */
export class HydrologyInputView {
    /** Create stable controls using the owning Models view's common controls.
     * @param {Object} view Models element, field, button and options helpers.
     * @param {string} label Input label supplied by the recipe.
     */
    constructor(view, label) {
        this.view = view;
        this.root = view.element("section", "", "models-hydrology");
        this.select = view.element("select");
        this.select.addEventListener("change", () => view.handlers.onHydrology(this.select.value));
        this.status = view.element("p", "", "models-help"); this.status.setAttribute("role", "status");
        this.status.id = "models-hydrology-status"; this.select.setAttribute("aria-describedby", this.status.id);
        this.refresh = view.button("Refresh datasets", () => view.handlers.onRefreshHydrology());
        this.error = view.element("p", "", "models-error"); this.error.setAttribute("role", "alert");
        this.details = view.element("details", "", "models-details");
        this.details.append(view.element("summary", "Terrain, watersheds & field mappings"));
        this.body = view.element("dl"); this.details.append(this.body);
        this.root.append(view.field("models-hydrology", label, this.select), this.status, this.error, this.refresh, this.details);
    }

    /** Update metadata without moving focus or collapsing an open details section.
     * @param {Object} draft Editable Models setup.
     * @return {void}
     */
    render(draft) {
        const choices = draft.hydrologyChoices;
        this.view.options(this.select, [{value: "", label: "Choose a prepared dataset…"}, ...choices.map(snapshot => ({
            value: hydrologyKey(hydrologyReference(snapshot)), label: `${snapshot.definition.title} · ${snapshot.definition.version}`,
        }))], draft.hydrologyKey);
        this.select.disabled = draft.hydrologyLoading;
        this.refresh.disabled = draft.hydrologyLoading || draft.hydrologyChecking;
        this.status.textContent = draft.hydrologyLoading ? "Loading prepared datasets…" : draft.hydrologyChecking ? "Checking elevation and watershed sources…" :
            !choices.length && !draft.hydrologyError ? "No prepared datasets are installed. Ask the administrator to register the terrain and watershed configuration." : draft.hydrologyReason;
        this.error.textContent = draft.hydrologyError; this.error.hidden = !draft.hydrologyError;
        const snapshot = draft.hydrology ?? choices.find(value => hydrologyKey(hydrologyReference(value)) === draft.hydrologyKey);
        this.details.hidden = !snapshot;
        if (!snapshot) return;
        const rows = hydrologyDetails(snapshot, [...draft.sources, ...draft.vectors]);
        const signature = JSON.stringify(rows);
        if (signature !== this.signature) {
            this.signature = signature;
            this.body.replaceChildren(...rows.flatMap(([label, value]) => [this.view.element("dt", label), this.view.element("dd", value)]));
        }
    }
}
