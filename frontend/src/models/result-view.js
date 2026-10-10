/** Present shared output types using the labels captured from a model's YAML. */
import { processingDownloadUrl, processingArtifactDownloadUrl } from "../processing/api.js";
import { formatDownloadBytes } from "../processing/presentation.js";
import { calculationValue } from "../processing/calculation-result-view.js";

const RESULT_STATES = {no_matches: "No cells matched the condition.", no_valid_data: "No valid cells in this area.",
    invalid_arithmetic: "The expression has no defined numeric result.", overflow: "The result exceeded the supported numeric range."};

/** Build a raster file card from validated output metadata.
 * @param {Object} result Raster output.
 * @param {Function} element Owning view's DOM element factory.
 * @return {HTMLElement[]} Result cards.
 */
function rasterCards(result, element) {
    const card = element("article", "", "models-result");
    card.append(element("strong", result.label), element("span", result.filename),
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
    ["raster", {cards: rasterCards, download: "Download GeoTIFF"}],
    ["statistics", {cards: statisticsCards, download: "Download CSV"}],
]);

/** Render a validated model output and its owned download links.
 * @param {HTMLElement} root Container owned by the model run view.
 * @param {Object} result Output validated at the Processing API boundary.
 * @param {string} jobId Owning run's opaque identity.
 * @param {Function} element Owning view's DOM element factory.
 * @param {boolean} [showDownloads=true] Include legacy links when no file inventory is available.
 * @return {void}
 * @throws {TypeError} If an internal caller bypasses output-type validation.
 */
export function renderModelResult(root, result, jobId, element, showDownloads = true) {
    const view = RESULT_VIEWS.get(result.kind);
    if (!view) throw new TypeError("Unsupported model output type.");
    root.append(...view.cards(result, element));
    if (!showDownloads) return;
    const links = element("div", "", "models-actions");
    for (const [kind, label, url] of [["result", view.download, result.url], ["provenance", "Download provenance", result.provenanceUrl]]) {
        const link = element("a", label);
        link.href = processingDownloadUrl(url, jobId, kind); link.download = ""; links.append(link);
    }
    root.append(links);
}

/** Show each complete result and retained intermediate in its owning run.
 * @param {HTMLElement} root Container owned by the run view.
 * @param {Object} manifest Validated available file inventory.
 * @param {Function} element Owning view's DOM element factory.
 * @param {Object} [previews={}] Composition-supplied inclusion and loading states keyed by file ID.
 * @param {(artifactId:string)=>void} [showOutput] Request display of one file.
 * @return {void}
 */
export function renderModelFiles(root, manifest, element, previews = {}, showOutput = () => {}) {
    root.append(element("h4", "Files from this run"));
    for (const file of manifest.files) {
        const card = element("article", "", "models-result");
        const label = file.role === "provenance" ? "Calculation details" : file.label;
        const link = element("a", `Download ${label}`);
        link.href = processingArtifactDownloadUrl(file.url, manifest.jobId, file.artifactId);
        link.download = "";
        const role = {result: "Result", intermediate: "Intermediate result", provenance: "Inputs and calculation settings"}[file.role];
        card.append(link, element("span", `${role} · ${formatDownloadBytes(file.bytes)}`), element("span", file.filename));
        const state = previews[file.artifactId] ?? {};
        if (state.canShow) {
            const button = element("button", state.onMap ? "On map" : state.busy ? "Adding to map…" : "Show on map", "secondary-button");
            button.type = "button"; button.disabled = Boolean(state.onMap || state.busy);
            button.setAttribute("aria-label", `${button.textContent}: ${label}`);
            button.addEventListener("click", () => showOutput(file.artifactId)); card.append(button);
            if (state.error) {
                const error = element("p", state.error, "models-error"); error.setAttribute("role", "alert"); card.append(error);
            }
        }
        root.append(card);
    }
}
