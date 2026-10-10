/** Reuse the raster appearance form for display-only model outputs. */
import { RasterAppearanceControlsView } from "../raster/appearance-controls-view.js";
import { RASTER_COLOR_PALETTES, applyRasterColorPalette } from "../raster/style.js";

/** Bind an independent instance of the existing raster appearance form to preview styles. */
export class ArtifactRasterStyleControls {
    /** Copy the existing form with unique IDs and compose its existing presentation adapter.
     * @param {Object} options Display-style callbacks, independent of map/controller implementations.
     * @param {Document} options.documentContext Owning application document.
     * @param {(key:string)=>Object|null} options.getTarget Current preview appearance and initial style.
     * @param {(key:string,appearance:Object)=>void} options.apply Commit an existing appearance contract.
     */
    constructor({documentContext, getTarget, apply}) {
        Object.assign(this, {getTarget, apply}); this.key = null; this.current = null;
        this.root = documentContext.querySelector("#raster-appearance-controls").cloneNode(true);
        for (const id of ["raster-style-histogram", "raster-percentile-controls", "open-raster-histogram-analysis"]) this.root.querySelector(`#${id}`)?.remove();
        const nodes = [this.root, ...this.root.querySelectorAll("*")];
        for (const node of nodes) {
            if (node.id) node.id = `artifact-${node.id}`;
            for (const attribute of ["for", "aria-labelledby", "aria-describedby", "aria-controls"]) {
                if (node.hasAttribute(attribute)) node.setAttribute(attribute, node.getAttribute(attribute).split(" ").map(id => `artifact-${id}`).join(" "));
            }
        }
        this.root.hidden = true; documentContext.querySelector("#layer-raster-style").append(this.root);
        // The appearance view asks only for elements and new DOM nodes. Scope
        // those lookups to this form while retaining its established markup.
        const context = {createElement: tag => documentContext.createElement(tag),
            querySelector: selector => selector === "#raster-appearance-controls" ? this.root : this.root.querySelector(selector.replaceAll("#", "#artifact-"))};
        this.view = new RasterAppearanceControlsView(context);
        this.view.palette.replaceChildren(); this.view.populatePalettes(RASTER_COLOR_PALETTES);
        this.view.bind({onStyleInput: () => this.commitContinuous(), onStyleChange: () => this.commitContinuous(),
            onPaletteChange: () => this.commitContinuous(true), onResetStyle: () => {
                const target = this.getTarget(this.key); if (target) this.apply(this.key, target.initial);
            }, onAppearanceModeChange: mode => {
                if (mode === "categorical") this.commitCategories(); else this.commitContinuous();
            }, onCategoricalStyleInput: () => this.commitCategories(), onCategoricalStyleChange: () => this.commitCategories()});
    }

    /** Open the standard raster form for one private preview.
     * @param {string} key Local map identity.
     * @return {boolean} Whether this component owns the requested raster appearance.
     */
    open(key) {
        this.close(); const target = this.getTarget(key); if (target?.kind !== "raster") return false;
        this.key = key; this.root.hidden = false; this.view.setActiveRasterAvailable(true); this.view.setEnabled(true);
        this.refresh(); return true;
    }

    /** Preserve pending edits unless a committed style or the target has changed.
     * @return {void}
     */
    refresh() {
        if (!this.key) return;
        const target = this.getTarget(this.key); if (!target) { this.close(); return; }
        if (this.current !== target.appearance) {
            this.current = target.appearance;
            this.view.setAppearanceMode(this.current.mode);
            this.view.setStyle(this.current.continuous.definition, this.current.continuous.paletteName);
            this.view.setCategoricalStyle(this.current.categorical);
        }
        this.view.setStatus("Colors use a small display sample. Download the GeoTIFF for its full resolution. Styling does not change the result file.");
    }

    /** Commit a valid color range or palette while keeping incomplete edits visible.
     * @param {boolean} [palette=false] Apply the selected named palette first.
     * @return {void}
     */
    commitContinuous(palette = false) {
        const target = this.getTarget(this.key); if (!target) return;
        try {
            const paletteName = palette ? this.view.getPaletteName() : "custom";
            const definition = palette && paletteName !== "custom"
                ? applyRasterColorPalette(this.view.readStyle(), paletteName) : this.view.readStyle();
            this.apply(this.key, {...target.appearance, mode: "continuous", continuous: {definition, paletteName, styleWasEdited: true}});
            this.view.renderStyleError();
        } catch (error) { this.view.renderStyleError(error); }
    }

    /** Commit the existing manual/CSV category contract once its table is valid.
     * @return {void}
     */
    commitCategories() {
        const target = this.getTarget(this.key); if (!target) return;
        try { this.apply(this.key, {...target.appearance, mode: "categorical", categorical: this.view.readCategoricalStyle()}); this.view.renderCategoricalError(); }
        catch (error) { this.view.renderCategoricalError(error); }
    }

    /** Hide the form and cancel an unfinished CSV import without changing the map style.
     * @return {void}
     */
    close() { this.key = null; this.current = null; this.view.cancelCategoricalImport(); this.root.hidden = true; }

    /** Remove this form and its listeners when the application is disposed.
     * @return {void}
     */
    destroy() { this.close(); this.view.unbind(); this.root.remove(); }
}
