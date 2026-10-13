/** Present shared output types using the labels captured from a model's YAML. */
import { processingDownloadUrl, processingArtifactDownloadUrl } from "../processing/api.js";
import { formatDownloadBytes } from "../processing/presentation.js";
import { calculationValue } from "../processing/calculation-result-view.js";

const RESULT_STATES = {no_matches: "No cells matched the condition.", no_valid_data: "No valid cells in this area.",
    invalid_arithmetic: "The expression has no defined numeric result.", overflow: "The result exceeded the supported numeric range."};

/** Offer the complete run or output name without making every card taller.
 * @param {(tag:string,text?:string,className?:string)=>HTMLElement} element Owning view's text-only DOM element factory.
 * @param {Clipboard|undefined} clipboard Browser clipboard, when available.
 * @return {{root:HTMLDetailsElement,name:HTMLElement,filename:HTMLElement,copy:HTMLButtonElement,status:HTMLElement}} Full-name details and copy feedback.
 */
export function createModelNameDetails(element, clipboard) {
    const root = element("details", "", "models-details models-name-details");
    root.append(element("summary", "Full name"));
    const name = element("p"), filename = element("p"); filename.hidden = true;
    const copy = element("button", "Copy name", "secondary-button"); copy.type = "button";
    const status = element("span", "", "models-help"); status.setAttribute("role", "status");
    /** Copy the complete displayed name and retain selectable text if copying fails.
     * @return {Promise<void>} Completion after clipboard feedback is displayed.
     */
    async function copyDisplayedName() {
        const value = name.textContent;
        copy.disabled = true; status.textContent = "";
        try {
            if (typeof clipboard?.writeText !== "function") throw new Error("Clipboard unavailable");
            await clipboard.writeText(value);
            if (name.textContent === value) status.textContent = "Name copied.";
        } catch {
            if (name.textContent === value) status.textContent = "Could not copy. Select the full name above to copy it.";
        } finally { copy.disabled = false; }
    }
    copy.addEventListener("click", () => void copyDisplayedName());
    root.append(name, filename, copy, status);
    return {root, name, filename, copy, status};
}

/** Build a raster file card from validated output metadata.
 * @param {Object} result Raster output.
 * @param {(tag:string,text?:string,className?:string)=>HTMLElement} element Owning view's DOM element factory.
 * @return {HTMLElement[]} Result cards.
 */
function rasterCards(result, element) {
    const card = element("article", "", "models-result");
    const filename = element("span", result.filename, "models-compact-name"); filename.title = result.filename; filename.tabIndex = 0;
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
 * @param {(tag:string,text?:string,className?:string)=>HTMLElement} element Owning view's DOM element factory.
 * @param {Object} [previews={}] Composition-supplied inclusion and loading states keyed by file ID.
 * @param {(artifactId:string)=>void} [showOutput] Request display of one file.
 * @param {Clipboard|undefined} [clipboard=globalThis.navigator?.clipboard] Browser clipboard for full names.
 * @return {void}
 */
export function renderModelFiles(root, manifest, element, previews = {}, showOutput = () => {}, clipboard = globalThis.navigator?.clipboard) {
    root.append(element("h4", "Files from this run"));
    for (const file of manifest.files) {
        const card = element("article", "", "models-result");
        const label = file.role === "provenance" ? "Calculation details" : file.label;
        const link = element("a", `Download ${label}`);
        link.href = processingArtifactDownloadUrl(file.url, manifest.jobId, file.artifactId);
        link.download = ""; link.title = file.displayName ?? file.label;
        const role = {result: "Result", intermediate: "Intermediate result", provenance: "Inputs and calculation settings"}[file.role];
        const filename = element("span", file.filename, "models-compact-name"); filename.title = file.filename;
        const details = createModelNameDetails(element, clipboard);
        details.name.textContent = file.displayName ?? file.label;
        details.filename.textContent = file.filename; details.filename.hidden = false;
        card.append(link, element("span", `${role} · ${formatDownloadBytes(file.bytes)}`), filename);
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
        card.append(details.root); root.append(card);
    }
}
