/** Compact, accessible statistic cards. No expression evaluation happens in the view. */
import { CalculationsView, calculationValue } from "./calculations-view.js";
import { ACTIVE_JOB_STATES } from "./jobs.js";
import { processingDownloadUrl } from "./api.js";
import { describeClipArea, describeJobProgress, formatDownloadBytes } from "./presentation.js";

const RESULT_STATES = { no_matches: "No cells matched the condition.", no_valid_data: "No valid cells in this area.",
    invalid_arithmetic: "Undefined arithmetic; no numeric result.", overflow: "Numeric overflow; no finite result." };

/** Keep DOM identities stable during edits, progress, removal, and undo. */
export class SummaryStatisticsView extends CalculationsView {
    constructor(documentContext = globalThis.document) {
        super(documentContext);
        this.cards = new Map();
        this.extra = Object.fromEntries(["auto", "undo", "undo-button", "saved-result", "close-saved", "recovery-status"]
            .map(name => [name, documentContext.querySelector(`#summary-${name}`)]));
    }
    bind(handlers) {
        this.handlers = handlers;
        const e = this.elements, x = this.extra;
        this.listeners = [
            ...this.openers.map(node => [node, "click", handlers.onOpen]),
            [e.close, "click", handlers.onClose], [e["edit-area"], "click", handlers.onEditArea],
            [e.area, "change", () => handlers.onArea(e.area.value)],
            [x.auto, "change", () => handlers.onAutomatic(x.auto.checked)],
            [e.template, "change", () => { handlers.onAdd(e.template.value); e.template.value = ""; }],
            [x["undo-button"], "click", handlers.onUndo], [e.retry, "click", handlers.onRetry],
            [e.refresh, "click", handlers.onRefresh], [x["close-saved"], "click", handlers.onCloseSaved],
        ];
        for (const [node, event, callback] of this.listeners) node.addEventListener(event, callback);
    }
    createCard(card) {
        const root = this.element("article"); root.className = "summary-statistic";
        root.setAttribute("aria-label", `Summary statistic ${card.id}`);
        const heading = this.element("div"); heading.className = "summary-statistic-heading";
        const label = this.element("input"); label.type = "text"; label.maxLength = 80;
        label.placeholder = "Name this statistic"; label.className = "summary-statistic-name";
        label.setAttribute("aria-label", `Summary statistic ${card.id} name`);
        label.addEventListener("input", () => this.handlers.onEdit(card.id, { label: label.value }));
        const remove = this.element("button", "×"); remove.type = "button"; remove.className = "summary-remove";
        remove.setAttribute("aria-label", `Remove summary statistic ${card.id}`);
        remove.addEventListener("click", () => this.handlers.onRemove(card.id));
        heading.append(label, remove);
        const binding = this.element("label", "Raster a ="); binding.className = "summary-raster-binding";
        const source = this.element("select"); source.setAttribute("aria-label", `Raster for summary statistic ${card.id}`);
        source.addEventListener("change", () => this.handlers.onEdit(card.id, { source: this.sources[Number(source.value)] ?? null }));
        binding.append(source);
        const equation = this.element("div"); equation.className = "summary-equation";
        const formulaLabel = this.element("label", "Formula");
        const expression = this.element("textarea"); expression.rows = 2; expression.maxLength = 4096; expression.spellcheck = false;
        expression.placeholder = "e.g., mean(a)";
        expression.setAttribute("aria-label", `Summary statistic ${card.id} formula`);
        expression.setAttribute("aria-describedby", `summary-statistic-status-${card.id}`);
        expression.addEventListener("input", () => this.handlers.onEdit(card.id, { expression: expression.value }));
        formulaLabel.append(expression);
        const valueGroup = this.element("div"); valueGroup.className = "summary-value-group";
        valueGroup.setAttribute("aria-live", "polite");
        const value = this.element("strong", "—"); value.className = "summary-value";
        const caption = this.element("small", "No value yet");
        valueGroup.append(value, caption); equation.append(formulaLabel, valueGroup);
        const statusRow = this.element("div"); statusRow.className = "summary-status-row";
        const status = this.element("span"); status.id = `summary-statistic-status-${card.id}`;
        status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
        const run = this.element("button", "Calculate"); run.type = "button"; run.className = "secondary-button";
        run.addEventListener("click", () => this.handlers.onRun(card.id));
        const stop = this.element("button", "Cancel"); stop.type = "button"; stop.className = "summary-text-button";
        stop.addEventListener("click", () => this.handlers.onStop(card.id));
        statusRow.append(status, run, stop);
        const progress = this.element("progress"); progress.setAttribute("aria-label", `Progress for summary statistic ${card.id}`);
        const details = this.element("details"); details.className = "summary-result-details";
        const detailsTitle = this.element("summary", "Value details & downloads");
        const detailsBody = this.element("div"); details.append(detailsTitle, detailsBody);
        const size = this.element("small"); size.className = "summary-size";
        root.append(heading, binding, equation, statusRow, progress, size, details);
        return { root, label, source, expression, value, caption, status, run, stop, progress, details, detailsBody, size };
    }
    render(state) {
        this.sources = state.sources;
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
            if (row.label.value !== card.label) row.label.value = card.label;
            if (row.expression.value !== card.expression) row.expression.value = card.expression;
            if (row.sourceSignature !== sourceSignature) {
                const options = state.sources.map((source, index) => {
                    const option = this.element("option", source.label); option.value = String(index); return option;
                });
                if (!options.length) { const option = this.element("option", "Choose a Catalog raster"); option.value = ""; options.push(option); }
                row.source.replaceChildren(...options); row.sourceSignature = sourceSignature;
            }
            row.source.value = String(state.sources.findIndex(source => source.collectionId === card.source?.collectionId && source.itemId === card.source?.itemId));
            row.source.disabled = !state.sources.length;
            row.expression.setAttribute("aria-invalid", String(card.error && !card.valid));
            row.root.setAttribute("aria-busy", String(card.pending));
            row.root.classList.toggle("is-previous", !!card.result && !card.current);
            row.status.textContent = card.current && RESULT_STATES[card.result?.row.state] ? RESULT_STATES[card.result.row.state] : card.message;
            row.status.classList.toggle("is-error", card.error);
            row.status.classList.toggle("is-working", card.pending || !!card.requested);
            row.run.hidden = card.current || card.pending || !!card.requested;
            row.run.disabled = !card.valid || card.checking || !card.source || !state.area || state.recoverable;
            row.stop.hidden = !card.pending && !card.requested;
            const progress = card.progress;
            row.progress.hidden = !card.pending || !(progress?.totalBlocks > 0);
            if (!row.progress.hidden) { row.progress.max = progress.totalBlocks; row.progress.value = progress.completedBlocks ?? 0; }
            const result = card.result;
            const text = result ? `${calculationValue(result.row)}${result.row.unit ? ` ${result.row.unit}` : ""}` : "—";
            if (row.value.textContent !== text) row.value.textContent = text;
            row.value.title = result?.row.value ?? result?.row.state ?? "No value yet";
            const caption = result ? card.current ? "Current value" : "Previous value" : "No value yet";
            if (row.caption.textContent !== caption) row.caption.textContent = caption;
            row.details.hidden = !result;
            const resultSignature = JSON.stringify([result?.job.jobId, result?.row]);
            if (result && resultSignature !== row.resultSignature) {
                this.renderValueDetails(row.detailsBody, result); row.resultSignature = resultSignature;
            }
            row.size.hidden = !card.manualRequired;
            const grid = card.plan?.grid;
            row.size.textContent = card.manualRequired ? grid
                ? `${grid.nativeBlocks.toLocaleString()} source blocks · ${formatDownloadBytes(grid.decodedBytes)} decoded. Calculate to confirm this scan.`
                : "This area requires Calculate to confirm the scan." : "";
        }
        const e = this.elements, x = this.extra;
        const areaSignature = JSON.stringify([state.areaChoice, state.availableAoi]);
        if (areaSignature !== this.signatures.area) {
            e.area.replaceChildren(...[["selection", "Current map selection"], ["uploaded", state.availableAoi ? `AOI · ${state.availableAoi.filename}` : "Uploaded AOI (none ready)"], ["whole", "Whole raster"]]
                .map(([value, label]) => { const option = this.element("option", label); option.value = value; option.disabled = value === "uploaded" && !state.availableAoi; return option; }));
            this.signatures.area = areaSignature;
        }
        e.area.value = state.areaChoice;
        e["area-description"].textContent = describeClipArea(state.area);
        x.auto.checked = state.automatic;
        e.template.disabled = state.statistics.length >= 5;
        x.undo.hidden = !state.undo;
        x["undo-button"].disabled = state.statistics.length >= 5;
        e.retry.hidden = !state.recoverable;
        x["recovery-status"].hidden = !state.recoverable;
        x["recovery-status"].textContent = state.recoveryMessage ?? "";
        x["saved-result"].hidden = !state.saved;
        if (state.saved && this.signatures.saved !== JSON.stringify(state.saved)) {
            this.renderResult({ result: state.saved, resultIsCurrent: false, sources: state.sources });
            x["saved-result"].open = true; this.signatures.saved = JSON.stringify(state.saved);
        }
        this.renderHistory(state);
        for (const opener of this.openers) opener.textContent = state.statistics.some(card => card.pending) ? "Summarize · working" : "Summarize";
    }
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
    renderHistory(state) {
        const signature = JSON.stringify([state.jobs, state.historyError]);
        if (signature === this.signatures.history) return;
        const children = state.jobs.filter(job => job.status !== "deleted").map(job => {
            const root = this.element("div"); root.className = "calculation-history-row";
            const inspect = this.element("button", `${job.calculations?.map(row => row.label).join(", ") ?? "Summary statistics"} · ${describeJobProgress(job)}`);
            inspect.type = "button"; inspect.className = "secondary-button";
            inspect.addEventListener("click", () => this.handlers.onInspect(job.jobId));
            const active = ACTIVE_JOB_STATES.has(job.status);
            const action = this.element("button", active ? "Cancel" : "Delete"); action.type = "button"; action.className = "secondary-button";
            action.disabled = job.status === "cancelling";
            action.addEventListener("click", () => active ? this.handlers.onCancel(job.jobId) : this.handlers.onDelete(job.jobId));
            root.append(inspect, this.element("small", `${new Date(job.createdAt).toLocaleString()} · ${describeClipArea(job.area)}`), action);
            return root;
        });
        this.elements.history.replaceChildren(this.element("p", state.historyError || "Results remain available for 24 hours in this browser session."), ...children);
        this.signatures.history = signature;
    }
    focusStatistic(id) { this.cards.get(id)?.expression.focus(); }
    focusUndo() { this.extra["undo-button"].focus(); }
    focusSaved() { this.extra["saved-result"].open = true; this.extra["saved-result"].scrollIntoView({ block: "nearest" }); }
}
