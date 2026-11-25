/** Edit the calculator's named raster bindings, formula and output grid. */
import { describeRasterSource } from "../raster-source-api.js";
import { captureModelRaster, modelSourceKey } from "./raster-input.js";

const RESAMPLING = [
    {value: "nearest", label: "Nearest"}, {value: "bilinear", label: "Bilinear"},
    {value: "mode", label: "Mode"}, {value: "min", label: "Minimum"},
    {value: "max", label: "Maximum"}, {value: "mean", label: "Mean"},
];
const FUNCTIONS = ["min", "max", "area_max"];
const OPERATORS = ["+", "-", "*", "/", "^"];
const EPSG = /^EPSG:[1-9][0-9]{0,8}$/;
const CUSTOM_GRID = "custom-grid";

/** @typedef {{alias:string, key:string, resampling:string}} FormulaLayer */
/** @typedef {{sources:Object[], layers:FormulaLayer[], nextAlias:number, expression:string,
 *   grid:string, crs:string, cellWidth:string, cellHeight:string}} RasterFormulaDraft */

/** Create one editable raster binding with the default resampling.
 * @param {string} alias Stable variable name.
 * @param {string} [key] Selected source identity.
 * @return {FormulaLayer} Draft raster row.
 */
function newLayer(alias, key = "") { return {alias, key, resampling: "nearest"}; }

/** Create a formula draft with one row and the current raster choices.
 * @param {Object} definition Recipe input declaration.
 * @param {{rasters?:Object[]}} context Current original raster and completed-run choices.
 * @return {RasterFormulaDraft} Editable calculator settings.
 */
function createDraft(definition, context) {
    const sources = structuredClone(context.rasters ?? []);
    const initial = sources.length === 1 ? modelSourceKey(sources[0]) : "";
    return {sources, layers: [newLayer("a", initial)], nextAlias: 2, expression: "a",
        grid: "a", crs: "EPSG:4326", cellWidth: "", cellHeight: ""};
}

/** Replace available source choices while retaining formula aliases and choices.
 * @param {RasterFormulaDraft} state Current draft.
 * @param {Object} definition Recipe input declaration.
 * @param {{rasters?:Object[]}} context Updated raster choices.
 * @return {void}
 */
function refreshDraft(state, definition, context) {
    state.sources = structuredClone(context.rasters ?? []);
}

/** Return sources bound to formula rows for completed-run status observation.
 * @param {RasterFormulaDraft} state Current calculator settings.
 * @return {Object[]} Selected source metadata from the current choices.
 */
function getRasterSources(state) {
    const selected = new Set(state.layers.map(layer => layer.key));
    return state.sources.filter(source => selected.has(modelSourceKey(source)));
}

/** Capture path-free inputs and validate the fields needed to submit the formula.
 * @param {RasterFormulaDraft} state Current calculator settings.
 * @return {Object} Raster formula input for the existing model-run endpoint.
 * @throws {Error} If a layer, variable or output grid is incomplete.
 */
function captureDraft(state) {
    const sources = new Map(state.sources.map(source => [modelSourceKey(source), source]));
    const layers = state.layers.map(({alias, key, resampling}) => {
        if (!key) throw new Error("Choose a raster for " + alias + ".");
        const raster = sources.get(key);
        if (!raster) throw new Error("Raster " + alias + " is unavailable. Choose another layer.");
        return {alias, source: captureModelRaster(raster, state.sources), resampling};
    });
    const aliases = new Set(layers.map(row => row.alias));
    const tokens = state.expression.matchAll(/(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?|([a-zA-Z][a-zA-Z0-9_]*)(\s*\()?/g);
    const names = [...tokens].flatMap(match => match[1] && !(match[2] && FUNCTIONS.includes(match[1])) ? [match[1]] : []);
    if (!names.length) throw new Error("Use at least one raster variable in the formula.");
    const unknown = names.find(name => !aliases.has(name));
    if (unknown) throw new Error("The formula uses an unknown variable, " + unknown + ".");
    let grid;
    if (state.grid === CUSTOM_GRID) {
        const crs = state.crs.trim().toUpperCase();
        const pixelSize = [Number(state.cellWidth), Number(state.cellHeight)];
        if (!EPSG.test(crs)) throw new Error("Enter an EPSG code such as EPSG:4326.");
        if (!pixelSize.every(size => Number.isFinite(size) && size > 0))
            throw new Error("Enter a positive cell width and height.");
        grid = {kind: "custom", crs, pixelSize};
    } else {
        if (!aliases.has(state.grid)) throw new Error("Choose an input raster or a custom grid.");
        grid = {kind: "match", alias: state.grid};
    }
    return {layers, expression: state.expression.trim(), grid};
}

/** Restore the exact raster, formula and grid bindings from a completed model run.
 * @param {RasterFormulaDraft} state New calculator draft.
 * @param {Object} saved Previously captured calculator inputs.
 * @return {void}
 */
function restoreDraft(state, saved) {
    state.layers = saved.layers.map(({alias, source, resampling}) => ({alias, key: modelSourceKey(source), resampling}));
    state.nextAlias = 1 + Math.max(0, ...state.layers.map(({alias}) =>
        /^[a-z]$/.test(alias) ? alias.charCodeAt(0) - 96 : /^r[0-9]{1,8}$/.test(alias) ? Number(alias.slice(1)) : 0));
    state.expression = saved.expression;
    state.grid = saved.grid.kind === "match" ? saved.grid.alias : CUSTOM_GRID;
    if (saved.grid.kind === "custom") {
        state.crs = saved.grid.crs;
        [state.cellWidth, state.cellHeight] = saved.grid.pixelSize.map(String);
    }
}

/** Describe the captured formula and resampling choices beside completed results.
 * @param {Object} value Captured calculator settings.
 * @return {string} Readable formula, grid and per-layer settings.
 */
function describeFormula(value) {
    const grid = value.grid.kind === "match" ? "Grid of " + value.grid.alias :
        [value.grid.crs, value.grid.pixelSize.join(" × ")].join(" · ");
    const methods = value.layers.map(layer =>
        layer.alias + " (" + RESAMPLING.find(option => option.value === layer.resampling).label + ")");
    return [value.expression, grid, methods.join(", ")].join(" · ");
}

/** Create controls whose row elements and aliases survive edits to the formula. */
class RasterFormulaView {
    /** Build the repeatable raster inputs, formula editor and grid controls.
     * @param {Object} ui Owning Data tools element builders.
     * @param {{onInput:(name:string,change:Object)=>void}} callbacks Draft edit actions.
     * @param {string} name Declared recipe input name.
     * @param {{label:string}} definition Input label from the recipe.
     */
    constructor(ui, callbacks, name, definition) {
        this.ui = ui; this.name = name;
        this.change = change => callbacks.onInput(name, change);
        this.rows = new Map(); this.metadata = new Map();
        this.root = ui.element("fieldset", "", "models-input-configuration");
        this.root.append(ui.element("legend", definition.label));
        this.layers = ui.element("div", "", "models-formula-layers");
        this.add = this.button("Add raster", () => this.addLayer());
        this.formula = ui.element("textarea"); this.formula.rows = 2; this.formula.maxLength = 4096; this.formula.spellcheck = false;
        this.formula.addEventListener("input", () => this.change({expression: this.formula.value}));
        this.variables = ui.element("div", "", "models-formula-insert");
        this.variableNames = "";
        const operators = ui.element("div", "", "models-formula-insert");
        operators.append(...OPERATORS.map(token => this.button(token, () => this.insert(" " + token + " "))));
        for (const name of FUNCTIONS) {
            const suffix = name === "area_max" ? ")" : ", )";
            operators.append(this.button(name + "(…)", () => this.insert(name + "(", suffix)));
        }
        this.grid = ui.element("select");
        this.grid.addEventListener("change", () => this.change({grid: this.grid.value}));
        this.custom = ui.element("div", "", "models-formula-grid");
        this.crs = ui.element("input"); this.crs.type = "text";
        this.cellWidth = ui.element("input"); this.cellHeight = ui.element("input");
        for (const control of [this.cellWidth, this.cellHeight]) {
            control.type = "number"; control.min = "0"; control.step = "any";
        }
        for (const [key, label] of [["crs", "Projection (EPSG code)"], ["cellWidth", "Cell width"], ["cellHeight", "Cell height"]]) {
            const control = this[key];
            control.addEventListener("input", () => this.change({[key]: control.value}));
            this.custom.append(ui.field("models-" + name + "-" + key, label, control));
        }
        this.gridInfo = ui.element("p", "", "models-help");
        this.status = ui.element("p", "", "models-help"); this.status.setAttribute("aria-live", "polite");
        this.root.append(this.layers, this.add, ui.field("models-" + name + "-expression", "Formula", this.formula),
            this.variables, operators, ui.element("p", "Uses the values stored in each raster. area_max(a) finds the highest valid value of a in the selected area on the output grid.", "models-help"),
            ui.field("models-" + name + "-grid", "Output grid", this.grid), this.custom, this.gridInfo, this.status);
    }

    /** Build a form-local action that leaves submission to Run tool.
     * @param {string} label Visible button label.
     * @param {()=>void} action Local edit.
     * @return {HTMLButtonElement} Non-submit button.
     */
    button(label, action) {
        const button = this.ui.element("button", label, "models-action");
        button.type = "button"; button.addEventListener("click", action);
        return button;
    }

    /** Add a new alias without rebinding names already used in formulas. @return {void} */
    addLayer() {
        let index = this.state.nextAlias;
        let alias;
        do {
            alias = index <= 26 ? String.fromCharCode(96 + index) : "r" + index;
            index += 1;
        } while (this.state.layers.some(layer => layer.alias === alias));
        this.change({layers: [...this.state.layers, newLayer(alias)], nextAlias: index});
        this.rows.get(alias)?.source.focus();
    }

    /** Insert a variable or operator, or wrap the selected text in a function call.
     * @param {string} token Variable, spaced operator or opening function call.
     * @param {string} [suffix] Text to insert after the selected function argument.
     * @return {void}
     */
    insert(token, suffix = "") {
        const start = this.formula.selectionStart, end = this.formula.selectionEnd;
        const prefix = suffix ? token + this.formula.value.slice(start, end) : token;
        this.formula.setRangeText(prefix + suffix, start, end, "end");
        if (suffix) this.formula.setSelectionRange(start + prefix.length, start + prefix.length);
        this.formula.focus();
        this.change({expression: this.formula.value});
    }

    /** Build a raster row with accessible source and resampling controls.
     * @param {string} alias Stable formula variable.
     * @return {{root:HTMLElement,source:HTMLSelectElement,method:HTMLSelectElement,metadata:HTMLElement,remove:HTMLButtonElement}} Row controls.
     */
    buildRow(alias) {
        const {ui, name} = this;
        const root = ui.element("fieldset", "", "models-formula-row");
        const source = ui.element("select"), method = ui.element("select");
        const metadata = ui.element("p", "", "models-help");
        const id = "models-" + name + "-" + alias;
        metadata.id = id + "-metadata"; source.setAttribute("aria-describedby", metadata.id);
        const update = change => this.change({layers: this.state.layers.map(
            layer => layer.alias === alias ? {...layer, ...change} : layer
        )});
        source.addEventListener("change", () => update({key: source.value}));
        method.addEventListener("change", () => update({resampling: method.value}));
        const remove = this.button("Remove", () => {
            this.change({layers: this.state.layers.filter(layer => layer.alias !== alias),
                grid: this.state.grid === alias ? "" : this.state.grid});
            this.add.focus();
        });
        remove.setAttribute("aria-label", "Remove raster " + alias);
        root.append(ui.element("legend", alias), ui.field(id + "-source", "Raster " + alias, source),
            ui.field(id + "-resampling", "Resampling for " + alias, method), metadata, remove);
        this.layers.append(root);
        return {root, source, method, metadata, remove};
    }

    /** Fetch selected source metadata independently of map rendering and job admission.
     * @param {Map<string,Object>} sources Available source choices.
     * @param {FormulaLayer[]} layers Currently selected raster rows.
     * @return {void}
     */
    refreshMetadata(sources, layers) {
        const selected = new Set(layers.map(layer => layer.key).filter(key => sources.has(key)));
        for (const [key, record] of this.metadata) {
            if (!selected.has(key)) { record.request.abort(); this.metadata.delete(key); }
        }
        for (const key of selected) {
            if (this.metadata.has(key)) continue;
            const record = {request: new AbortController(), description: "Reading grid…"};
            this.metadata.set(key, record);
            void describeRasterSource(sources.get(key), record.request.signal).then(metadata => {
                const [x, rotationX, , rotationY, y] = metadata.transform;
                const sizes = [Math.hypot(x, rotationY), Math.hypot(y, rotationX)];
                record.description = metadata.crs + " · " + sizes.map(size => Number(size.toPrecision(9))).join(" × ") + " cell size";
            }).catch(() => { record.description = "Grid details unavailable."; }).then(() => {
                if (!record.request.signal.aborted) this.render(this.state);
            });
        }
    }

    /** Render current raster options, formula and effective grid while retaining focus.
     * @param {RasterFormulaDraft} state Calculator draft.
     * @return {boolean} Whether the captured fields are ready to submit.
     */
    render(state) {
        this.state = state;
        const {ui} = this;
        const sources = new Map(state.sources.map(source => [modelSourceKey(source), source]));
        this.refreshMetadata(sources, state.layers);
        const layerNames = new Set(state.layers.map(layer => layer.alias));
        for (const [alias, row] of this.rows) {
            if (!layerNames.has(alias)) { row.root.remove(); this.rows.delete(alias); }
        }
        const choices = [{value: "", label: "Choose a raster…"}, ...[...sources].map(([key, source]) => ({
            value: key, label: source.label, disabled: source.available === false,
            group: source.kind === "uploadedRaster" ? "Your uploads" : source.kind === "runArtifact" ? "Completed runs" : "Catalog layers",
        }))];
        for (const layer of state.layers) {
            const row = this.rows.get(layer.alias) ?? this.buildRow(layer.alias);
            this.rows.set(layer.alias, row);
            const missing = layer.key && !sources.has(layer.key);
            ui.options(row.source, missing ? [...choices, {value: layer.key, label: "Previous raster (unavailable)", disabled: true}] : choices, layer.key);
            ui.options(row.method, RESAMPLING, layer.resampling);
            row.metadata.textContent = this.metadata.get(layer.key)?.description ?? "";
            row.remove.disabled = state.layers.length === 1;
        }
        const names = [...layerNames].join(",");
        if (this.variableNames !== names) {
            this.variableNames = names;
            this.variables.replaceChildren(...[...layerNames].map(alias => this.button(alias, () => this.insert(alias))));
        }
        if (this.formula.value !== state.expression) this.formula.value = state.expression;
        ui.options(this.grid, [{value: "", label: "Choose a grid…"}, ...state.layers.map(layer => ({
            value: layer.alias, label: "Match " + layer.alias + (sources.has(layer.key) ? " · " + sources.get(layer.key).label : ""),
        })), {value: CUSTOM_GRID, label: "Custom grid"}], state.grid);
        this.custom.hidden = state.grid !== CUSTOM_GRID;
        for (const key of ["crs", "cellWidth", "cellHeight"]) {
            if (this[key].value !== state[key]) this[key].value = state[key];
        }
        const reference = state.layers.find(layer => layer.alias === state.grid);
        this.gridInfo.textContent = this.custom.hidden ? this.metadata.get(reference?.key)?.description ?? "" :
            (state.crs.trim().toUpperCase() === "EPSG:4326" ? "Enter cell sizes in degrees." : "Enter cell sizes in the projection’s units.");
        let message = "";
        try { captureDraft(state); } catch (error) { message = error.message; }
        if (this.status.textContent !== message) this.status.textContent = message;
        return !message;
    }

    /** Cancel reads when Data tools discards this setup. @return {void} */
    dispose() {
        for (const record of this.metadata.values()) record.request.abort();
        this.metadata.clear();
    }
}

/** Create the registered formula input view.
 * @param {Object} ui Data tools element builders.
 * @param {{onInput:(name:string,change:Object)=>void}} callbacks Draft edit actions.
 * @param {string} name Declared input name.
 * @param {{label:string}} definition Recipe input declaration.
 * @return {RasterFormulaView} Editable formula controls.
 */
function buildView(ui, callbacks, name, definition) {
    return new RasterFormulaView(ui, callbacks, name, definition);
}

/** Registered calculator input behavior within Data tools.
 * @type {import("./input-handlers.js").ModelInputHandler}
 */
export const rasterFormulaInputHandler = Object.freeze({
    createDraft, refresh: refreshDraft, capture: captureDraft, restore: restoreDraft,
    describe: describeFormula, buildView, getRasterSources,
});
