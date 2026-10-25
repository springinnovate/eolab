/** Present the primary model result with supporting files under Details. */
import { processingArtifactDownloadUrl } from "../processing/api.js";
import { formatDownloadBytes } from "../processing/presentation.js";
import { calculationValue } from "../processing/calculation-result-view.js";

const RESULT_STATES = {no_matches: "No cells matched the condition.", no_valid_data: "No valid cells in this area.",
    invalid_arithmetic: "The expression has no defined numeric result.", overflow: "The result exceeded the supported numeric range."};

/** Format an observation's saved timestamp with an explicit UTC timezone.
 * @param {string} timestamp Validated ISO observation timestamp.
 * @return {string} UTC date and time for the completed run.
 */
function formatObservationTime(timestamp) {
    return new Date(timestamp).toISOString().replace("T", " ").replace(/(?:\.000)?Z$/, " UTC");
}

/** Build a raster file card and its saved temporal coverage, when applicable.
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
    if (result.temporalCoverage !== undefined) {
        const coverage = result.temporalCoverage;
        card.append(
            element("span", `Units: ${coverage.unit}`),
            element("span", `Observations in this run: ${coverage.observationCount.toLocaleString()}`),
            element("span", `First observation: ${formatObservationTime(coverage.firstObservation)}`),
            element("span", `Last observation: ${formatObservationTime(coverage.lastObservation)}`),
            element("p", "Missing values are excluded at each pixel. The count map shows how many valid observations contributed there.", "models-help"));
    }
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

const AREA_STATISTIC_LABELS = new Map([
    ["count", "Valid-pixel count"], ["sum", "Sum"], ["mean", "Mean"], ["min", "Minimum"], ["max", "Maximum"],
    ["stdev", "Population standard deviation"],
]);

/** Name a built-in area statistic or retain the label of a user-defined calculation.
 * @param {string} statistic Saved statistic identifier or calculation label.
 * @return {string} Human-readable statistic name or the unchanged calculation label.
 */
export function describeAreaStatistic(statistic) {
    return AREA_STATISTIC_LABELS.get(statistic) ?? statistic;
}

/** Build a time-series summary for the downloadable CSV without loading its rows.
 * @param {Object} result Time-series output with its saved calculations and coverage.
 * @param {(tag:string,text?:string,className?:string)=>HTMLElement} element Owning view's DOM element factory.
 * @return {HTMLElement[]} Summary card naming the calculations performed for each observation.
 */
function timeSeriesCards(result, element) {
    const card = element("article", "", "models-result");
    const coverage = result.temporalCoverage;
    card.append(element("strong", result.label), element("span", result.filename, "models-name"));
    for (const calculation of result.calculations)
        card.append(element("span", `Statistic: ${describeAreaStatistic(calculation.label)}`), element("code", calculation.expression));
    if (coverage.unit) card.append(element("span", `Units: ${coverage.unit}`));
    card.append(
        element("span", `Observations in this run: ${coverage.observationCount.toLocaleString()}`),
        element("span", `First observation: ${formatObservationTime(coverage.firstObservation)}`),
        element("span", `Last observation: ${formatObservationTime(coverage.lastObservation)}`),
        element("p", "Download the CSV for values and per-calculation pixel counts.", "models-help"));
    return [card];
}

const RESULT_VIEWS = new Map([
    ["raster", {cards: rasterCards}],
    ["statistics", {cards: statisticsCards}],
    ["timeSeries", {cards: timeSeriesCards}],
]);

/** Show the primary output and its actions before a collapsed list of supporting files.
 * @param {HTMLElement} root Container owned by the model run view.
 * @param {Object} result Output validated at the Processing API boundary.
 * @param {Object|null} manifest Available file inventory, or null while files are unavailable.
 * @param {(tag:string,text?:string,className?:string)=>HTMLElement} element Owning view's DOM element factory.
 * @param {(artifactId:string)=>void} showOutput Request display of one file.
 * @return {Array<{artifactId:string,label:string,button:HTMLButtonElement,error:HTMLElement}>} Stable file controls for map-state updates.
 * @throws {TypeError} If an internal caller bypasses output-type validation.
 */
export function renderModelResult(root, result, manifest, element, showOutput) {
    const view = RESULT_VIEWS.get(result.kind);
    if (!view) throw new TypeError("Unsupported model output type.");
    const cards = view.cards(result, element);
    root.append(...cards);
    if (!manifest) return [];
    const primary = manifest.files.find(file => file.name === result.name);
    const controls = [appendFileActions(result.kind === "statistics" ? root : cards[0], primary, result.label, manifest.jobId, element, showOutput)];
    const supporting = manifest.files.filter(file => file !== primary);
    if (supporting.length) {
        const details = element("details", "", "models-details");
        details.append(element("summary", "Details"));
        for (const file of supporting) {
            const card = element("article", "", "models-result");
            const label = file.displayName ?? (file.role === "provenance" ? "Calculation details" : file.label);
            const role = {result: "Result", intermediate: "Intermediate result", provenance: "Inputs and calculation settings"}[file.role];
            card.append(element("h5", label, "models-name"), element("span", `${role} · ${formatDownloadBytes(file.bytes)}`, "models-help"),
                element("span", file.filename, "models-help models-name"));
            controls.push(appendFileActions(card, file, label, manifest.jobId, element, showOutput));
            details.append(card);
        }
        root.append(details);
    }
    return controls;
}

/** Append one file's download, map action and display error to its result card.
 * @param {HTMLElement} root Result card or scalar-results container.
 * @param {Object} file Published file from the available inventory.
 * @param {string} label Human-readable result name for accessible actions.
 * @param {string} jobId Owning run identifier.
 * @param {(tag:string,text?:string,className?:string)=>HTMLElement} element Owning view's DOM element factory.
 * @param {(artifactId:string)=>void} showOutput Request display of one file.
 * @return {{artifactId:string,label:string,button:HTMLButtonElement,error:HTMLElement}} Stable controls for this file.
 */
function appendFileActions(root, file, label, jobId, element, showOutput) {
    const link = element("a", "Download", "models-action");
    link.href = processingArtifactDownloadUrl(file.url, jobId, file.artifactId);
    link.download = ""; link.title = label;
    link.setAttribute("aria-label", `Download ${label}`);
    const actions = element("div", "", "models-actions");
    const button = element("button", "Show on map", "models-action");
    button.type = "button"; button.hidden = true;
    button.setAttribute("aria-live", "polite"); button.setAttribute("aria-atomic", "true");
    button.addEventListener("click", () => {
        if (!button.hidden && button.getAttribute("aria-disabled") !== "true") showOutput(file.artifactId);
    });
    const error = element("p", "", "models-error"); error.setAttribute("role", "alert"); error.hidden = true;
    actions.append(button, link);
    root.append(actions, error);
    return {artifactId: file.artifactId, label, button, error};
}

/** Update each file's map action while preserving its button and download link.
 * @param {Array<{artifactId:string,label:string,button:HTMLButtonElement,error:HTMLElement}>} controls File controls returned by renderModelResult.
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
