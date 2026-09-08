/** Accessible calculation editor and inline result presentation. */
import { ACTIVE_JOB_STATES } from "./jobs.js";
import { processingDownloadUrl } from "./api.js";
import { describeClipArea, describeClipCrs, describeJobProgress, formatDownloadBytes } from "./presentation.js";

/** Preserve integer precision; raw decimal text remains inspectable. @param {Object} row Typed result. @return {string} Display value. */
export function calculationValue(row) {
    if (row.value === null) return "—";
    if (row.valueType === "integer") return BigInt(row.value).toLocaleString();
    const value = Number(row.value);
    return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumSignificantDigits: 10 }) : row.value;
}

/** Describe the server-reviewed ground-area method. @param {Object} method Area metadata. @return {string} Review/result explanation. */
function describeGroundArea(method) {
    return `Ground area: ${method.ellipsoid} ellipsoid, hectares, including partial pixels. Equal-area boundary intersections; ${method.edgeToleranceMetres} m chord-deviation target, at most ${method.maximumSegmentMetres.toLocaleString()} m per segment. Geometry estimate: up to ${method.estimatedGeometryCells.toLocaleString()} polygon cells${method.strategy === "rectilinear" ? "; row/column area optimization" : ""}.`;
}

/** Own DOM controls without owning requests or map state. */
export class CalculationsView {
    /** @param {Document} [documentContext=globalThis.document] Owning document. */
    constructor(documentContext = globalThis.document) {
        this.document = documentContext;
        this.elements = Object.fromEntries(["source", "area", "area-description", "rows", "add", "form", "review",
            "run", "rerun", "stop", "follow", "validation", "plan", "status", "progress", "result", "history", "refresh",
            "retry", "close", "edit-area", "template", "editor", "status-region", "status-summary"].map(name => [name, documentContext.querySelector(`#calculations-${name}`)]));
        this.openers = [documentContext.querySelector("#open-calculations")];
        this.listeners = [];
        this.rows = [];
        this.signatures = {};
    }
    /** Make a text-only node. @param {string} tag Tag. @param {string} [text=""] Label. @return {HTMLElement} Node. */
    element(tag, text = "") { const node = this.document.createElement(tag); node.textContent = text; return node; }
    /** Bind semantic intents. @param {Object} handlers Intent handlers. @return {void} */
    bind(handlers) {
        this.handlers = handlers;
        const e = this.elements;
        this.listeners = [
            ...this.openers.map(node => [node, "click", handlers.onOpen]),
            [e.close, "click", handlers.onClose], [e["edit-area"], "click", handlers.onEditArea],
            [e.source, "change", () => handlers.onSource(Number(e.source.value))],
            [e.area, "change", () => handlers.onArea(e.area.value)],
            [e.follow, "change", () => handlers.onFollow(e.follow.checked)],
            [e.form, "submit", event => { event.preventDefault(); handlers.onReview(); }],
            [e.run, "click", () => { e.editor.open = false; handlers.onRun(); }], [e.stop, "click", handlers.onStop],
            [e.retry, "click", handlers.onRetry], [e.refresh, "click", handlers.onRefresh],
            [e.rerun, "click", handlers.onRerun],
            [e.add, "click", () => handlers.onCalculations([...this.readRows(), { label: `Result ${this.rows.length + 1}`, expression: "mean(a)" }])],
            [e.template, "change", () => {
                const templates = { mean: ["Mean", "mean(a)"], count: ["Count above 10", "count(a > 10)"],
                    sum: ["Sum above 10", "sum(a, where=a > 10)"], percent: ["Percent above 10", "100 * count(a > 10) / count(a)"],
                    "area-threshold": ["Area above 10", "areaha(a > 10)"], "area-class": ["Area in class 4", "areaha(a == 4)"],
                    range: ["Range", "max(a) - min(a)"] };
                const template = templates[e.template.value];
                if (template && this.rows.length < 5) handlers.onCalculations([...this.readRows(), { label: template[0], expression: template[1] }]);
                e.template.value = "";
            }],
        ];
        for (const [node, event, callback] of this.listeners) node.addEventListener(event, callback);
    }
    /** Read the small editor without evaluating expressions. @return {Object[]} Rows. */
    readRows() { return this.rows.map(row => ({ label: row.label.value, expression: row.expression.value })); }
    /** Reveal settings when entering from a new source/area action. @return {void} */
    openEditor() { this.elements.editor.open = true; }
    /** Render editable rows only when their count changes; retain typing focus/caret. @param {Object[]} values Expressions. @return {void} */
    renderRows(values) {
        if (this.rows.length !== values.length) {
            this.rows = values.map((value, index) => {
                const root = this.element("div"); root.className = "calculation-expression";
                const label = this.element("input"); label.type = "text"; label.maxLength = 80;
                label.setAttribute("aria-label", `Result ${index + 1} label`);
                const expression = this.element("textarea"); expression.rows = 2; expression.maxLength = 4096;
                expression.spellcheck = false; expression.setAttribute("aria-label", `Result ${index + 1} expression`);
                for (const input of [label, expression]) input.addEventListener("input", () => this.handlers.onCalculations(this.readRows()));
                const remove = this.element("button", "Remove"); remove.type = "button"; remove.className = "secondary-button";
                remove.disabled = values.length === 1; remove.setAttribute("aria-label", `Remove result ${index + 1}`);
                remove.addEventListener("click", () => this.handlers.onCalculations(this.readRows().filter((_, i) => i !== index)));
                const labelWrapper = this.element("label", `Result ${index + 1}`); labelWrapper.append(label);
                const expressionWrapper = this.element("label", "Expression"); expressionWrapper.append(expression);
                root.append(labelWrapper, expressionWrapper, remove);
                return { root, label, expression };
            });
            this.elements.rows.replaceChildren(...this.rows.map(row => row.root));
        }
        values.forEach((value, index) => {
            const row = this.rows[index];
            if (row.label.value !== value.label) row.label.value = value.label;
            if (row.expression.value !== value.expression) row.expression.value = value.expression;
        });
    }
    /** Update the editor and stable result surface. @param {Object} state Controller snapshot. @return {void} */
    render(state) {
        const e = this.elements;
        this.renderRows(state.calculations);
        const sources = JSON.stringify(state.sources);
        if (sources !== this.signatures.sources) {
            e.source.replaceChildren(...state.sources.map((source, index) => {
                const option = this.element("option", `a = ${source.label}`); option.value = String(index); return option;
            }));
            this.signatures.sources = sources;
        }
        e.source.value = String(state.sources.findIndex(source => source.collectionId === state.source?.collectionId && source.itemId === state.source?.itemId));
        e.source.disabled = !state.sources.length;
        const options = [["selection", "Current histogram area"], ["uploaded", state.availableAoi ? `AOI · ${state.availableAoi.filename}` : "Uploaded AOI (none ready)"], ["whole", "Whole raster (native pixels)"]];
        e.area.replaceChildren(...options.map(([value, label]) => { const option = this.element("option", label); option.value = value; option.disabled = value === "uploaded" && !state.availableAoi; return option; }));
        e.area.value = state.areaChoice;
        e["area-description"].textContent = describeClipArea(state.area);
        e.follow.checked = state.followWanted;
        e.follow.disabled = state.areaChoice !== "selection" || state.area?.kind !== "selectedArea";
        e.add.disabled = e.template.disabled = state.calculations.length >= 5;
        e.validation.textContent = state.validation;
        e.validation.classList.toggle("is-error", !state.valid && state.validation !== "Checking expressions…");
        e.review.disabled = !state.source || !state.area || !state.valid || state.phase === "planning";
        e.review.textContent = state.phase === "planning" ? "Reviewing…" : "Review analysis";
        e.run.hidden = !state.plan;
        e.rerun.hidden = !state.resultIsCurrent || state.hasWork;
        e.run.textContent = state.followWanted && !e.follow.disabled ? "Run & follow sampling box" : "Run analysis";
        e.stop.hidden = !state.hasWork && !state.following;
        e.stop.textContent = state.following ? "Stop following / cancel" : "Cancel analysis";
        e.retry.hidden = !state.recoverable;
        e.status.textContent = state.message || (state.current ? describeJobProgress(state.current)
            : state.following ? "Following sampling box — click the map to calculate again." : "");
        if (state.following && state.message === "Calculation complete.") e.status.textContent += " Click another location to calculate again.";
        e["status-region"].classList.toggle("is-working", !!state.resultPending);
        e["status-summary"].hidden = !state.resultPending;
        e["status-summary"].textContent = state.resultPending
            ? state.result ? "Calculating new result…" : "Calculating result…" : "";
        const progress = state.current?.progress;
        e.progress.hidden = state.current?.status !== "running" || !(progress?.totalBlocks > 0);
        if (!e.progress.hidden) { e.progress.max = progress.totalBlocks; e.progress.value = progress.completedBlocks ?? 0; }
        e.plan.hidden = !state.plan;
        if (state.plan) {
            const g = state.plan.grid;
            e.plan.textContent = `${g.width.toLocaleString()} × ${g.height.toLocaleString()} native pixels · ${g.nativeBlocks.toLocaleString()} source blocks · ${formatDownloadBytes(g.decodedBytes)} decoded. ${describeClipCrs(g.crs)}. Stored values; numeric functions select cell centers. Source unit: ${g.storedUnit || "unspecified"}.${g.groundArea ? ` ${describeGroundArea(g.groundArea)}` : ""}`;
        }
        const resultSignature = JSON.stringify([state.result, state.resultIsCurrent]);
        if (resultSignature !== this.signatures.result) { this.renderResult(state); this.signatures.result = resultSignature; }
        const previous = !!state.result && (!state.resultIsCurrent || state.resultPending);
        e.result.classList.toggle("is-previous", !!previous);
        e.result.setAttribute("aria-busy", String(!!state.resultPending));
        if (state.result) e.result.children[0].textContent = previous ? "Previous / saved result" : "Result for current settings";
        const historySignature = JSON.stringify([state.jobs, state.historyError]);
        if (historySignature !== this.signatures.history) {
            const children = state.jobs.filter(job => job.status !== "deleted").map(job => {
                const root = this.element("div"); root.className = "calculation-history-row";
                const button = this.element("button", `${job.calculations?.map(row => row.label).join(", ") ?? "Raster analysis"} · ${describeJobProgress(job)}`);
                button.type = "button"; button.className = "secondary-button";
                button.addEventListener("click", () => this.handlers.onInspect(job.jobId));
                root.append(button, this.element("small", `${new Date(job.createdAt).toLocaleString()} · ${describeClipArea(job.area)}`));
                const active = ACTIVE_JOB_STATES.has(job.status);
                const action = this.element("button", active ? "Cancel" : "Delete"); action.type = "button"; action.className = "secondary-button";
                action.disabled = job.status === "cancelling";
                action.addEventListener("click", () => active ? this.handlers.onCancel(job.jobId) : this.handlers.onDelete(job.jobId));
                root.append(action); return root;
            });
            e.history.replaceChildren(this.element("p", state.historyError || "Results remain available for 24 hours in this browser session."), ...children);
            this.signatures.history = historySignature;
        }
        for (const opener of this.openers) opener.textContent = state.resultPending ? "Custom raster analysis · working" : "Custom raster analysis";
    }
    /** Present inline values with coverage and optional exports. @param {Object} state Controller snapshot. @return {void} */
    renderResult(state) {
        const root = this.elements.result;
        const job = state.result;
        if (!job) { root.replaceChildren(this.element("p", "Your values will appear here. Set up an analysis, review, and Run.")); return; }
        const source = Object.values(job.sources ?? {})[0];
        const label = state.resultIntent?.source.label ?? state.sources.find(item => item.itemId === source?.itemId && item.collectionId === source?.collectionId)?.label ?? source?.itemId ?? "Raster";
        root.replaceChildren(this.element("h3", state.resultIsCurrent ? "Result for current settings" : "Previous / saved result"),
            this.element("p", `${label} · ${describeClipArea(job.area)}`));
        if (job.status !== "ready" || !job.result) { root.append(this.element("p", job.error?.detail ?? describeJobProgress(job))); return; }
        const states = { no_matches: "No cells matched the condition.", no_valid_data: "No valid cells in this area.",
            invalid_arithmetic: "Undefined arithmetic; no numeric result.", overflow: "Numeric overflow; no finite result." };
        for (const row of job.result.rows) {
            const card = this.element("article"); card.className = "calculation-result-row";
            const value = this.element("strong", `${calculationValue(row)}${row.unit ? ` ${row.unit}` : ""}`); value.title = row.value ?? row.state;
            card.append(this.element("h4", row.label), value, this.element("code", row.expression));
            if (states[row.state]) card.append(this.element("p", states[row.state]));
            const coverage = this.element("details"); coverage.append(this.element("summary", "Cell coverage & exact value"));
            coverage.append(this.element("p", `Exact value: ${row.value ?? "undefined"}. ${row.unit ? `Result unit: ${row.unit}.` : `Source unit: ${job.grid?.storedUnit || "unspecified"}. Expressions may change units.`}`));
            for (const aggregate of row.aggregates) coverage.append(this.element("p",
                `${aggregate.function}: ${aggregate.matchedPixels.toLocaleString()} matched / ${aggregate.validPixels.toLocaleString()} valid cells; ${aggregate.invalidArithmeticPixels.toLocaleString()} excluded by arithmetic.`));
            card.append(coverage); root.append(card);
        }
        if (job.grid?.groundArea) {
            const method = this.element("details");
            method.append(this.element("summary", "Area measurement"), this.element("p", describeGroundArea(job.grid.groundArea)),
                this.element("p", "Area coverage counts include any positive pixel intersection; numeric functions use pixel centers. Each areaha term is in hectares. Arithmetic can change final units."));
            root.append(method);
        }
        const links = this.element("div"); links.className = "downloads-actions";
        for (const [kind, label, url] of [["result", "Download CSV", job.result.url], ["provenance", "Download provenance", job.result.provenanceUrl]]) {
            const link = this.element("a", label); link.className = "secondary-button";
            link.href = processingDownloadUrl(url, job.jobId, kind); link.setAttribute("download", ""); links.append(link);
        }
        root.append(links);
    }
    /** Release fixed listeners. @return {void} */
    unbind() { for (const [node, event, callback] of this.listeners) node.removeEventListener(event, callback); this.listeners = []; }
}
