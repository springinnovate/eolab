/** Present shared output types using the labels captured from a model's YAML. */
import { processingArtifactDownloadUrl } from "../processing/api.js";
import { formatDownloadBytes } from "../processing/presentation.js";
import { calculationValue } from "../processing/calculation-result-view.js";

const RESULT_STATES = {no_matches: "No cells matched the condition.", no_valid_data: "No valid cells in this area.",
    invalid_arithmetic: "The expression has no defined numeric result.", overflow: "The result exceeded the supported numeric range."};

/** Build a raster file card from validated output metadata.
 * @param {Object} result Raster output.
 * @param {(tag:string,text?:string,className?:string)=>HTMLElement} element Owning view's DOM element factory.
 * @return {HTMLElement[]} Result cards.
 */
function rasterCards(result, element) {
    const card = element("article", "", "models-result");
    const filename = element("span", result.filename, "models-name");
    card.append(element("strong", result.label), filename,
        element("span", `${result.grid.width.toLocaleString()} × ${result.grid.height.toLocaleString()} pixels · ${result.validPixels.toLocaleString()} valid pixels`),
        element("span", `${formatDownloadBytes(result.bytes)} · GeoTIFF`));
    return [card];
}

/** Build statistics cards from validated scalar rows and their recipe label.
 * @param {Object} result Statistics output.
 * @param {Function} element Owning view's DOM element factory.
 * @return {HTMLElement[]} Output heading and scalar cards.
 */
function statisticsCards(result, element) {
    return [element("strong", result.label), ...result.rows.map(row => {
        const card = element("article", "", "models-result");
        card.append(element("strong", row.label), element("code", row.expression),
            element("strong", calculationValue(row), "models-result-value"));
        if (row.state !== "ok") card.append(element("p", RESULT_STATES[row.state] ?? row.state));
        return card;
    })];
}

const RESULT_VIEWS = new Map([
    ["raster", {cards: rasterCards}],
    ["statistics", {cards: statisticsCards}],
]);

/** Render the values or raster dimensions from a validated model output.
 * @param {HTMLElement} root Container owned by the model run view.
 * @param {Object} result Output validated at the Processing API boundary.
 * @param {Function} element Owning view's DOM element factory.
 * @return {void}
 * @throws {TypeError} If an internal caller bypasses output-type validation.
 */
export function renderModelResult(root, result, element) {
    const view = RESULT_VIEWS.get(result.kind);
    if (!view) throw new TypeError("Unsupported model output type.");
    root.append(...view.cards(result, element));
}

/** Show each complete result and retained intermediate in its owning run.
 * @param {HTMLElement} root Container owned by the run view.
 * @param {Object} manifest Validated available file inventory.
 * @param {(tag:string,text?:string,className?:string)=>HTMLElement} element Owning view's DOM element factory.
 * @param {(artifactId:string)=>void} [showOutput] Request display of one file.
 * @return {Array<{artifactId:string,label:string,button:HTMLButtonElement,error:HTMLElement}>} Stable file controls for updating map actions without replacing focused elements.
 */
export function renderModelFiles(root, manifest, element, showOutput = () => {}) {
    root.append(element("h4", "Files from this run"));
    const controls = [];
    for (const file of manifest.files) {
        const card = element("article", "", "models-result");
        const label = file.displayName ?? (file.role === "provenance" ? "Calculation details" : file.label);
        const link = element("a", "Download", "models-action");
        link.href = processingArtifactDownloadUrl(file.url, manifest.jobId, file.artifactId);
        link.download = ""; link.title = file.displayName ?? file.label;
        link.setAttribute("aria-label", `Download ${label}`);
        const role = {result: "Result", intermediate: "Intermediate result", provenance: "Inputs and calculation settings"}[file.role];
        const filename = element("span", file.filename, "models-help models-name");
        const actions = element("div", "", "models-actions");
        const button = element("button", "Show on map", "models-action");
        button.type = "button"; button.hidden = true;
        button.setAttribute("aria-live", "polite"); button.setAttribute("aria-atomic", "true");
        button.addEventListener("click", () => {
            if (!button.hidden && button.getAttribute("aria-disabled") !== "true") showOutput(file.artifactId);
        });
        const error = element("p", "", "models-error"); error.setAttribute("role", "alert"); error.hidden = true;
        actions.append(button, link);
        card.append(element("h5", label, "models-name"), element("span", `${role} · ${formatDownloadBytes(file.bytes)}`, "models-help"), filename, actions, error);
        controls.push({artifactId: file.artifactId, label, button, error});
        root.append(card);
    }
    return controls;
}

/** Update each file's map action while preserving its button and download link.
 * @param {Array<{artifactId:string,label:string,button:HTMLButtonElement,error:HTMLElement}>} controls File controls returned by renderModelFiles.
 * @param {Object<string,{canShow?:boolean,onMap?:boolean,busy?:boolean,error?:string}>} [previews={}] Map availability, inclusion and loading states keyed by file ID.
 * @return {void}
 */
export function updateModelFileActions(controls, previews = {}) {
    for (const {artifactId, label, button, error} of controls) {
        const state = previews[artifactId] ?? {};
        const caption = state.onMap ? "On map" : state.busy ? "Adding to map…" : "Show on map";
        button.hidden = !state.canShow;
        if (button.textContent !== caption) button.textContent = caption;
        button.setAttribute("aria-label", `${caption}: ${label}`);
        button.setAttribute("aria-disabled", String(Boolean(state.onMap || state.busy)));
        button.setAttribute("aria-busy", String(Boolean(state.busy)));
        const message = state.error ?? "";
        if (error.textContent !== message) error.textContent = message;
        error.hidden = !state.canShow || !message;
    }
}
