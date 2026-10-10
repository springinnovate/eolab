import { rasterSourceKey } from "../raster-source.js";
/** Compact, accessible statistic cards. No expression evaluation happens in the view. */
import { calculationValue } from "./calculation-result-view.js";
import { processingDownloadUrl } from "./api.js";
import { describeClipArea } from "./presentation.js";

const RESULT_STATES = { no_matches: "No cells matched the condition.", no_valid_data: "No valid cells in this area.",
    invalid_arithmetic: "Undefined arithmetic; no numeric result.", overflow: "Numeric overflow; no finite result." };

/**
 * @typedef {Object} SummaryCurrentWork
 * @property {ReturnType<typeof import("./calculation-session.js").calculationIntent>} calculation Immutable submitted inputs.
 * @property {string} message Current progress or recovery feedback.
 * @property {boolean} cancelling Cancellation was recorded or acknowledged by Processing.
 */

/** Keep DOM identities stable during edits, progress, removal, and undo. */
export class SummaryStatisticsView {
    /**
     * Bind statistic presentation and the browser's optional clipboard writer.
     * @param {Document} [documentContext=globalThis.document] Owning document.
     * @param {Object} [browserContext] Browser capabilities supplied at the view boundary.
     * @param {{writeText:(text:string)=>Promise<void>}|null} [browserContext.clipboard]
     * Clipboard writer; unavailable or denied access is presented in the card.
     * @param {(context:{source:string,scope:string})=>void} [browserContext.onContextChange]
     * Publish display-only source/area context through browser composition.
     */
    constructor(documentContext = globalThis.document, {
        clipboard = documentContext.defaultView?.navigator?.clipboard ?? null,
        onContextChange = () => {},
    } = {}) {
        this.document = documentContext;
        this.onContextChange = onContextChange;
        this.elements = Object.fromEntries(["area", "area-description", "rows",
            "retry", "close", "edit-area", "template"]
            .map(name => [name, documentContext.querySelector(`#calculations-${name}`)]));
        this.openers = ["open-calculations", "open-calculations-dock"].map(id => documentContext.querySelector(`#${id}`));
        this.listeners = [];
        this.signatures = {};
        this.clipboard = clipboard;
        this.cards = new Map();
        this.scheduledRenderFrame = null;
        this.latestState = null;
        this.focusAfterRender = null;
        this.vectorAreaControls = documentContext.querySelector("#calculations-vector-area");
        this.extra = Object.fromEntries(["source-mode", "auto", "undo", "undo-button", "current-work", "current-work-context", "current-work-status", "cancel-work"]
            .map(name => [name, documentContext.querySelector(`#summary-${name}`)]));
    }
    /** Make a text-only card node. @param {string} tag HTML tag. @param {string} [text=""] Text. @return {HTMLElement} Node. */
    element(tag, text = "") { const node = this.document.createElement(tag); node.textContent = text; return node; }

    /** Bind the current summary controls to semantic intents. @param {Object<string, Function>} handlers Controller callbacks. @return {void} */
    bind(handlers) {
        this.handlers = handlers;
        const e = this.elements, x = this.extra;
        this.listeners = [
            ...this.openers.map(node => [node, "click", handlers.onOpen]),
            [e.close, "click", handlers.onClose], [e["edit-area"], "click", handlers.onEditArea],
            [e.area, "change", () => handlers.onArea(e.area.value)],
            [x.auto, "change", () => handlers.onAutomatic(x.auto.checked)],
            [x["source-mode"], "change", () => handlers.onSourceMode(x["source-mode"].value)],
            [e.template, "change", () => { handlers.onAdd(e.template.value); e.template.value = ""; }],
            [x["undo-button"], "click", handlers.onUndo], [e.retry, "click", handlers.onRetry],
            [x["cancel-work"], "click", handlers.onCancelWork],
        ];
        for (const [node, event, callback] of this.listeners) node.addEventListener(event, callback);
    }
    /** Create a stable result-first statistic surface with an inline editor.
     * Presets start compact; a blank custom formula starts open. Calculation
     * feedback and previous-result provenance remain outside the editor.
     * @param {{id:number,expression:string}} card Controller card with a stable identity.
     * @return {Object} Retained result, editor, action and clipboard nodes/state.
     */
    createCard(card) {
        const root = this.element("article"); root.className = "summary-statistic";
        root.setAttribute("aria-label", `Summary statistic ${card.id}`);
        const heading = this.element("div"); heading.className = "summary-statistic-heading";
        const title = this.element("strong"); title.className = "summary-statistic-title";
        const sourceCaption = this.element("p"); sourceCaption.className = "summary-source-caption";
        const label = this.element("input"); label.type = "text"; label.maxLength = 80;
        label.placeholder = "Name this statistic"; label.className = "summary-statistic-name";
        label.setAttribute("aria-label", `Summary statistic ${card.id} name`);
        label.addEventListener("input", () => this.handlers.onEdit(card.id, { label: label.value }));
        const remove = this.element("button", "×"); remove.type = "button"; remove.className = "summary-remove";
        remove.setAttribute("aria-label", `Remove summary statistic ${card.id}`);
        const removeTooltip = this.element("span", "Remove this calculation");
        removeTooltip.className = "summary-remove-tooltip"; removeTooltip.id = `summary-remove-tooltip-${card.id}`;
        removeTooltip.setAttribute("role", "tooltip");
        remove.setAttribute("aria-describedby", removeTooltip.id); remove.append(removeTooltip);
        remove.addEventListener("click", () => this.handlers.onRemove(card.id));
        heading.append(title);
        const binding = this.element("label"); binding.className = "summary-raster-binding";
        const variable = this.element("code", "a"); variable.className = "summary-raster-variable";
        variable.title = "Raster represented by a in the formula";
        const source = this.element("select"); source.setAttribute("aria-label", `Raster for summary statistic ${card.id}`);
        const bindingHelp = this.element("span", "Raster represented by a in the formula");
        bindingHelp.className = "summary-variable-help"; bindingHelp.id = `summary-variable-help-${card.id}`;
        source.setAttribute("aria-describedby", bindingHelp.id);
        source.addEventListener("change", () => this.handlers.onEdit(card.id, { source: this.sources[Number(source.value)] ?? null }));
        binding.append(variable, source, bindingHelp);
        const equation = this.element("div"); equation.className = "summary-equation";
        const expression = this.element("textarea"); expression.rows = 1; expression.maxLength = 4096; expression.spellcheck = false;
        expression.placeholder = "Formula, e.g. mean(a)";
        expression.setAttribute("aria-label", `Summary statistic ${card.id} formula`);
        expression.setAttribute("aria-describedby", `summary-statistic-status-${card.id}`);
        expression.addEventListener("input", () => this.handlers.onEdit(card.id, { expression: expression.value }));
        const valueGroup = this.element("div"); valueGroup.className = "summary-value-group";
        valueGroup.setAttribute("aria-live", "polite");
        const value = this.element("strong"); value.className = "summary-value";
        const valueActions = this.element("div"); valueActions.className = "summary-value-actions"; valueActions.hidden = true;
        const copy = this.element("button"); copy.type = "button"; copy.className = "summary-copy";
        copy.setAttribute("aria-label", `Copy current value for summary statistic ${card.id}`);
        copy.title = "Copy current value (exact)";
        const copyIcon = this.document.createElementNS("http://www.w3.org/2000/svg", "svg");
        for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", width: "15", height: "15", "aria-hidden": "true", focusable: "false" })) copyIcon.setAttribute(name, value);
        const copyPath = this.document.createElementNS("http://www.w3.org/2000/svg", "path");
        for (const [name, value] of Object.entries({ d: "M8 8h12v13H8zM16 8V3H3v13h5", fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linejoin": "round" })) copyPath.setAttribute(name, value);
        copyIcon.append(copyPath); copy.append(copyIcon);
        copy.addEventListener("click", () => void this.copyCurrentValue(card.id));
        const copyStatus = this.element("small"); copyStatus.setAttribute("role", "status"); copyStatus.hidden = true;
        valueActions.append(value, copy);
        valueGroup.append(valueActions);
        const previousContext = this.element("small"); previousContext.className = "summary-previous-context"; previousContext.hidden = true;
        valueGroup.append(previousContext);
        equation.append(expression);
        const statusRow = this.element("div"); statusRow.className = "summary-status-row";
        const status = this.element("span"); status.id = `summary-statistic-status-${card.id}`;
        status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
        const run = this.element("button", "Calculate"); run.type = "button"; run.className = "secondary-button";
        run.addEventListener("click", () => this.handlers.onRun(card.id));
        const stop = this.element("button", "Cancel"); stop.type = "button"; stop.className = "summary-text-button";
        stop.addEventListener("click", () => this.handlers.onStop(card.id));
        statusRow.append(status, run, stop);
        const progress = this.element("progress"); progress.setAttribute("aria-label", `Progress for summary statistic ${card.id}`);
        valueGroup.append(statusRow, progress, copyStatus);
        const details = this.element("details"); details.className = "summary-result-details";
        const detailsTitle = this.element("summary", "Value details & downloads");
        const detailsBody = this.element("div"); details.append(detailsTitle, detailsBody);
        const editor = this.element("details"); editor.className = "summary-statistic-editor";
        editor.open = !card.expression.trim();
        const editorTitle = this.element("summary", "Edit");
        const editorFields = this.element("div"); editorFields.className = "summary-editor-fields";
        const nameField = this.element("label", "Name"); nameField.append(label);
        const formulaField = this.element("label", "Formula"); formulaField.append(equation);
        editorFields.append(nameField, binding, formulaField);
        editor.append(editorTitle, editorFields);
        const queryResults = this.element("div"); queryResults.className = "summary-query-results";
        root.append(heading, sourceCaption, valueGroup, queryResults, editor, details, remove);
        return { root, title, sourceCaption, editor, editorTitle, previousContext, label, binding, source, expression, equation, value, valueActions, copy, copyStatus, copyRevision: 0, status, statusRow, run, stop, progress, details, detailsBody, remove, queryResults, queryRows: new Map() };
    }
    /** Retain current state and schedule one draw while the panel is open.
     * Closed panels update only their visible opener, when its text changes.
     * Result callbacks never wait for drawing; newer state replaces a pending draw.
     * @param {Object} state Latest summary controller state.
     * @param {boolean} state.active Whether composition has opened raster statistics.
     * @param {{pending:boolean,source:{collectionId:string,itemId:string,label:string}|null}[]} state.statistics Owned statistic cards; full state is retained for drawing.
     * @return {void}
     */
    render(state) {
        this.latestState = state;
        const sources = [...new Map(state.statistics.filter(card => card.source).map(card =>
            [rasterSourceKey(card.source), card.source.label])).values()];
        this.onContextChange({ source: state.sourceMode === "query" ? `${state.querySources.length} enabled rasters in this area` : sources.length === 1 ? sources[0]
            : sources.length ? `${sources.length} rasters in statistic cards` : "No raster selected",
            scope: this.areaDescription(state) });
        const working = state.statistics.some(card => card.pending);
        for (const opener of this.openers) {
            const name = opener === this.openers[0] ? "Raster statistics" : "Statistics";
            const label = name + (working ? " · working" : "");
            if (opener.textContent !== label) opener.textContent = label;
        }
        if (!state.active) {
            this.cancelScheduledRender();
            return;
        }
        if (this.scheduledRenderFrame !== null) return;
        this.scheduledRenderFrame = this.document.defaultView.requestAnimationFrame(() => {
            this.scheduledRenderFrame = null;
            this.draw(this.latestState);
            const focus = this.focusAfterRender;
            this.focusAfterRender = null;
            focus?.();
        });
    }
    /** Update cards and unfinished-work feedback, distinguishing input-waiting intent from queued work.
     * Calculation indicators require a raster and area; vector progress belongs
     * to the vector workflow. Missing inputs retain their guidance and no Cancel action.
     * Retained editors preserve their nodes and disclosure state during updates.
     * Previous values identify their captured source/area independently of current
     * editor intent; progress, errors and actions stay visible when editing is closed.
     * @param {Object} state Summary controller state. @return {void}
     * @throws {TypeError} If a result contains an invalid owned download address.
     */
    draw(state) {
        this.sources = state.sources;
        const selecting = !!state.vectorSelecting && (state.areaChoice === "vector" || ["catalogSelection", "polygonArea"].includes(state.area?.kind));
        const sourceSignature = JSON.stringify(state.sources);
        const ids = state.statistics.map(card => card.id).join(",");
        for (const card of state.statistics) if (!this.cards.has(card.id)) this.cards.set(card.id, this.createCard(card));
        if (ids !== this.signatures.cardIds) {
            this.elements.rows.replaceChildren(...state.statistics.map(card => this.cards.get(card.id).root));
            // Removed cards can be recreated on Undo; surviving cards retain their actual nodes.
            for (const id of this.cards.keys()) if (!state.statistics.some(card => card.id === id)) this.cards.delete(id);
            this.signatures.cardIds = ids;
        }
        for (const card of state.statistics) {
            const row = this.cards.get(card.id);
            const query = state.sourceMode === "query";
            row.binding.hidden = query;
            row.queryResults.hidden = !query;
            if (query) this.drawQueryResults(row, card.queryResults, card.id);
            const queued = !!(card.requested && card.source && state.area);
            const title = card.label.trim() || `Summary statistic ${card.id}`;
            if (row.title.textContent !== title) row.title.textContent = title;
            row.editorTitle.setAttribute("aria-label", `Edit ${title}`);
            const sourceCaption = query ? `${state.querySources.length} enabled rasters in this area` : card.source?.label ?? "No raster selected";
            if (row.sourceCaption.textContent !== sourceCaption) row.sourceCaption.textContent = sourceCaption;
            if (row.label.value !== card.label) row.label.value = card.label;
            if (row.expression.value !== card.expression) row.expression.value = card.expression;
            // A hidden, identically styled mirror sizes wrapped and multiline formulas without layout reads.
            if (row.equation.getAttribute("data-expression") !== card.expression) row.equation.setAttribute("data-expression", card.expression);
            if (row.sourceSignature !== sourceSignature) {
                const options = state.sources.map((source, index) => {
                    const option = this.element("option", source.label); option.value = String(index); return option;
                });
                if (!options.length) { const option = this.element("option", "Choose a raster"); option.value = ""; options.push(option); }
                row.source.replaceChildren(...options); row.sourceSignature = sourceSignature;
            }
            row.source.value = String(state.sources.findIndex(source => card.source && rasterSourceKey(source) === rasterSourceKey(card.source)));
            row.source.disabled = !state.sources.length;
            row.expression.setAttribute("aria-invalid", String(card.error && !card.valid));
            row.root.setAttribute("aria-busy", String(!!(card.pending || selecting)));
            row.root.classList.toggle("is-previous", !!card.result && !card.current);
            const message = card.current
                ? [card.result?.job.result?.cacheHit ? "Reused cached result" : "",
                    RESULT_STATES[card.result?.row.state] ?? ""].filter(Boolean).join(" · ")
                : card.message;
            row.status.textContent = state.vectorCalculation && (card.pending || queued) && !message.startsWith("Calculating")
                ? `Calculating · ${message}` : message;
            row.status.hidden = !row.status.textContent;
            row.status.classList.toggle("is-error", card.error);
            row.status.classList.toggle("is-awaiting-map", !!card.awaitingMap);
            row.status.classList.toggle("is-working", !!(card.pending || queued || selecting || (card.checking && card.source && state.area)));
            row.run.hidden = !state.area || card.current || card.pending || queued || selecting;
            row.run.disabled = !card.expression.trim() || (query ? !state.querySources.length || card.checking || !card.valid : !card.source) || !state.area || state.recoverable;
            row.stop.hidden = !card.pending && !queued && !selecting;
            row.statusRow.hidden = row.status.hidden && row.run.hidden && row.stop.hidden;
            const progress = card.progress;
            row.progress.hidden = !(card.pending || queued || selecting);
            if (progress?.phase === "calculating" && progress.totalBlocks > 0) {
                row.progress.max = progress.totalBlocks;
                row.progress.value = progress.completedBlocks ?? 0;
            } else {
                row.progress.removeAttribute("value");
            }
            const result = card.result;
            row.previousContext.hidden = !result || card.current;
            const previousContext = result && !card.current
                ? `Previous result · ${result.source.label} · ${describeClipArea(result.area)}` : "";
            if (row.previousContext.textContent !== previousContext) row.previousContext.textContent = previousContext;
            row.valueActions.hidden = !result;
            const text = result ? `${calculationValue(result.row)}${result.row.unit ? ` ${result.row.unit}` : ""}` : "";
            if (row.value.textContent !== text) row.value.textContent = text;
            row.value.title = result?.row.value ?? result?.row.state ?? "";
            row.details.hidden = !result;
            const resultSignature = JSON.stringify([result?.job.jobId, result?.row]);
            const copyValue = card.current && result?.row.state === "ok" && result.row.value != null ? result.row.value : null;
            const copySignature = JSON.stringify([resultSignature, copyValue]);
            if (row.copySignature !== copySignature) {
                row.copyRevision++; row.copying = false; row.copyValue = copyValue; row.copySignature = copySignature;
                row.copyStatus.textContent = ""; row.copyStatus.hidden = true;
            }
            row.copy.hidden = !result;
            row.copy.disabled = row.copyValue === null || row.copying;
            row.copy.title = row.copyValue === null ? "Only current numeric values can be copied" : "Copy current value (exact)";
            if (result && resultSignature !== row.resultSignature) {
                this.renderValueDetails(row.detailsBody, result); row.resultSignature = resultSignature;
            }
        }
        const e = this.elements, x = this.extra;
        const areaSignature = state.areaChoice;
        if (areaSignature !== this.signatures.area) {
            e.area.replaceChildren(...[["selection", "Current map selection"], ["vector", "Vector layer"], ["whole", "Whole raster"]]
                .map(([value, label]) => { const option = this.element("option", label); option.value = value; return option; }));
            this.signatures.area = areaSignature;
        }
        e.area.value = state.areaChoice;
        this.vectorAreaControls.hidden = state.areaChoice !== "vector";
        e["edit-area"].hidden = state.areaChoice === "vector" || state.areaChoice === "whole";
        e["area-description"].textContent = this.areaDescription(state);
        x.auto.checked = state.automatic;
        x["source-mode"].value = state.sourceMode ?? "single";
        e.template.disabled = state.statistics.length >= 5;
        x.undo.hidden = !state.undo;
        x["undo-button"].disabled = state.statistics.length >= 5;
        e.retry.hidden = !state.recoverable;
        this.renderCurrentWork(state.currentWork);
    }
    /** Describe the summary's own area choice, including its missing-input guidance.
     * @param {{areaChoice:string,area:Object|null,vectorArea:Object|null}} state Current summary presentation.
     * @return {string} Source-independent area label used by the view and composed task context.
     */
    areaDescription(state) {
        return state.areaChoice === "vector" && state.area && state.vectorArea
            ? `Vector selection · ${state.vectorArea.label}` : state.areaChoice === "vector"
                ? "Choose a polygon layer below. Edit its filter, then use the matching features."
                : describeClipArea(state.area);
    }
    /**
     * Copy the exact scalar from the current result, without display rounding or units.
     * Ignore completion if editing, replacement, removal, or teardown changes the card.
     * @param {number} id Stable statistic identifier.
     * @return {Promise<void>} Settles after clipboard feedback is presented, if still relevant.
     */
    async copyCurrentValue(id) {
        const row = this.cards.get(id);
        await this.copyOwnedValue(row, () => this.cards.get(id) === row);
    }
    /** Copy a retained result's exact scalar and suppress obsolete asynchronous feedback.
     * @param {Object|undefined} row Owned result controls with a revision and copy value.
     * @param {()=>boolean} retained Whether the controls still belong to the live view.
     * @return {Promise<void>} Clipboard feedback, if the result remains current.
     */
    async copyOwnedValue(row, retained) {
        if (!row || row.copyValue == null || row.copying) return;
        const revision = row.copyRevision;
        row.copying = true; row.copy.disabled = true;
        const stillCurrent = () => retained() && row.copyRevision === revision;
        try {
            if (typeof this.clipboard?.writeText !== "function") throw new Error("Clipboard unavailable");
            await this.clipboard.writeText(String(row.copyValue));
            if (stillCurrent()) row.copyStatus.textContent = "Copied exact value";
        } catch {
            if (stillCurrent()) {
                row.copyStatus.textContent = "Could not copy. Select the exact value in Value details below.";
                row.details.open = true;
            }
        } finally {
            if (stillCurrent()) { row.copying = false; row.copy.disabled = false; row.copyStatus.hidden = false; }
        }
    }
    /** Draw independent raster rows without replacing focused controls or open details.
     * Previous values carry their captured inputs and cannot be copied as current values.
     * @param {Object} card Retained statistic controls and keyed raster rows.
     * @param {Object[]} results Current raster candidates and per-raster execution snapshots.
     * @param {number} id Owning statistic identity.
     * @return {void}
     * @throws {TypeError} If a result contains an invalid owned download address.
     */
    drawQueryResults(card, results, id) {
        const signature = JSON.stringify(results.map(result => result.key));
        for (const entry of results) {
            let row = card.queryRows.get(entry.key);
            if (!row) {
                const root = this.element("section"); root.className = "summary-query-result";
                const name = this.element("strong"); name.className = "summary-query-name";
                const valueActions = this.element("div"); valueActions.className = "summary-value-actions";
                const value = this.element("strong"); value.className = "summary-value";
                const copy = this.element("button", "Copy"); copy.type = "button"; copy.className = "summary-text-button";
                const status = this.element("small"); status.setAttribute("role", "status");
                const copyStatus = this.element("small"); copyStatus.setAttribute("role", "status"); copyStatus.hidden = true;
                const details = this.element("details"); details.className = "summary-result-details";
                const detailsBody = this.element("div"); details.append(this.element("summary", "Value details & downloads"), detailsBody);
                valueActions.append(value, copy); root.append(name, valueActions, status, copyStatus, details);
                row = { root, name, value, copy, status, copyStatus, details, detailsBody, copyRevision: 0 };
                card.queryRows.set(entry.key, row);
                copy.addEventListener("click", () => void this.copyOwnedValue(row,
                    () => this.cards.get(id) === card && card.queryRows.get(entry.key) === row));
            }
            const result = entry.result;
            row.name.textContent = entry.source.label;
            row.copy.setAttribute("aria-label", `Copy current ${card.title.textContent} value for ${entry.source.label}`);
            row.root.classList.toggle("is-previous", !!result && !entry.current);
            row.root.setAttribute("aria-busy", String(entry.pending));
            row.value.textContent = result ? `${calculationValue(result.row)}${result.row.unit ? ` ${result.row.unit}` : ""}` : "—";
            row.value.title = result?.row.value ?? "";
            row.status.textContent = [entry.message, entry.current ? RESULT_STATES[result?.row.state] : "",
                result && !entry.current ? `Previous result · ${describeClipArea(result.area)} · ${result.row.expression}` : ""].filter(Boolean).join(" · ");
            row.status.hidden = !row.status.textContent;
            row.status.classList.toggle("is-error", !!entry.error);
            const resultSignature = JSON.stringify(result);
            const copyValue = entry.current && result?.row.state === "ok" ? result.row.value : null;
            const copySignature = JSON.stringify([resultSignature, copyValue]);
            if (row.copySignature !== copySignature) {
                row.copySignature = copySignature; row.copyRevision++; row.copyValue = copyValue;
                row.copying = false; row.copyStatus.hidden = true; row.copyStatus.textContent = "";
            }
            row.copy.hidden = !result;
            row.copy.disabled = row.copyValue == null || row.copying;
            row.details.hidden = !result;
            if (result && resultSignature !== row.resultSignature) {
                this.renderValueDetails(row.detailsBody, result); row.resultSignature = resultSignature;
            }
        }
        if (signature !== card.querySignature) {
            for (const key of card.queryRows.keys()) if (!results.some(result => result.key === key)) card.queryRows.delete(key);
            card.queryResults.replaceChildren(...results.map(result => card.queryRows.get(result.key).root));
            card.querySignature = signature;
        }
    }
    /** Cancel queued drawing and focus when closing or destroying the panel. @return {void} */
    cancelScheduledRender() {
        if (this.scheduledRenderFrame !== null) this.document.defaultView.cancelAnimationFrame(this.scheduledRenderFrame);
        this.scheduledRenderFrame = null;
        this.focusAfterRender = null;
    }
    /** Release listeners, cancel drawing and invalidate pending clipboard feedback. @return {void} */
    unbind() {
        this.cancelScheduledRender();
        this.latestState = null;
        for (const [node, event, callback] of this.listeners) node.removeEventListener(event, callback);
        this.listeners = [];
        this.cards.clear();
    }
    /** Render immutable context for one live card's result. @param {HTMLElement} root Details container. @param {Object} result Card result with row, job, source and area snapshots. @return {void} */
    renderValueDetails(root, result) {
        const { row, job, source, area } = result;
        root.replaceChildren(this.element("p", `${source.label} · ${describeClipArea(area)}`),
            this.element("code", row.expression), this.element("p", `Exact value: ${row.value ?? "undefined"}.${row.unit ? ` Result unit: ${row.unit}.` : ` Source unit: ${job.grid?.storedUnit || "unspecified"}; expressions may change units.`}`));
        if (RESULT_STATES[row.state]) root.append(this.element("p", RESULT_STATES[row.state]));
        for (const aggregate of row.aggregates ?? []) root.append(this.element("p", `${aggregate.function}: ${aggregate.matchedPixels.toLocaleString()} matched / ${aggregate.validPixels.toLocaleString()} valid cells; ${aggregate.invalidArithmeticPixels.toLocaleString()} excluded by arithmetic.`));
        if (job.grid?.groundArea) {
            const method = job.grid.groundArea;
            root.append(this.element("p", `Ground area: ${method.ellipsoid} ellipsoid, hectares, including partial pixels. ${method.edgeToleranceMetres} m chord-deviation target; at most ${method.maximumSegmentMetres.toLocaleString()} m per segment. Numeric functions select cell centers.`));
        }
        const links = this.element("div"); links.className = "downloads-actions";
        for (const [kind, label, url] of [["result", "Download CSV", job.result.url], ["provenance", "Download provenance", job.result.provenanceUrl]]) {
            const link = this.element("a", label); link.className = "secondary-button";
            link.href = processingDownloadUrl(url, job.jobId, kind); link.setAttribute("download", ""); links.append(link);
        }
        root.append(this.element("small", "Downloads preserve the formulas and names at the time of calculation."), links);
    }
    /** Present only unfinished work which cannot rely on the current cards for context.
     * Keep controls stable during progress updates; original inputs distinguish a hidden
     * manual scan from the map area or pixel currently being inspected.
     * @param {SummaryCurrentWork|null} work Unfinished summary scan or null.
     * @return {void}
     */
    renderCurrentWork(work) {
        const x = this.extra;
        x["current-work"].hidden = !work;
        if (!work) return;
        const { calculation, message, cancelling } = work;
        const point = calculation.pixelPoint;
        const context = `Unfinished calculation · ${calculation.calculations.map(row => row.label).join(", ")} · ${calculation.source.label} · ${describeClipArea(calculation.area)}${point ? ` · Point: ${point.longitude}, ${point.latitude}` : ""}`;
        if (x["current-work-context"].textContent !== context) x["current-work-context"].textContent = context;
        if (x["current-work-status"].textContent !== message) x["current-work-status"].textContent = message;
        x["cancel-work"].disabled = cancelling;
    }
    /** Apply a user-requested focus action after pending drawing creates its controls.
     * @param {()=>void} focus Focus or reveal an existing control. @return {void}
     */
    focusWhenRendered(focus) {
        if (!this.latestState?.active) return;
        if (this.scheduledRenderFrame !== null) this.focusAfterRender = focus;
        else focus();
    }
    /** Focus a surviving card's editing entry point after add/undo and drawing.
     * Blank custom formulas open their editor and receive direct formula focus.
     * Presets retain the user's disclosure state and focus the Edit control.
     * @param {number} id Stable card identity. @return {void}
     */
    focusStatistic(id) {
        this.focusWhenRendered(() => {
            const row = this.cards.get(id);
            if (!row) return;
            if (!row.expression.value.trim()) { row.editor.open = true; row.expression.focus(); }
            else row.editorTitle.focus();
        });
    }
    /** Focus the editor entry point without inventing a statistic. @return {void} */
    focusAddStatistic() { this.focusWhenRendered(() => this.elements.template.focus()); }
    /** Focus removal recovery. @return {void} */
    focusUndo() { this.focusWhenRendered(() => this.extra["undo-button"].focus()); }
}
