/** Focused, debounced vector filter editor; composition supplies map actions. */

import {
    EMPTY_VECTOR_FILTER, MAX_VECTOR_FILTER_RULES, normalizeVectorFilter,
    vectorFilterFieldKind, vectorFilterOperators, vectorFilterSummary,
} from "./filter.js";

/** Own a rule-builder panel without reaching into style or inspection peers. */
export class VectorFilterControls {
    /**
     * Bind a dedicated non-modal vector Filter panel.
     * @param {Object} options Panel dependencies.
     * @param {(key:string)=>Object|null} options.getTarget Composition-owned target lookup.
     * @param {Object} options.inspection Neutral dock presentation.
     * @param {Document} [options.documentContext=document] Owning document.
     * @param {Function} [options.setTimer] Debounce scheduler.
     * @param {Function} [options.clearTimer] Debounce canceller.
     */
    constructor({ getTarget, inspection, documentContext = document,
        setTimer = (handler, delay) => globalThis.setTimeout(handler, delay),
        clearTimer = (timer) => globalThis.clearTimeout(timer) }) {
        this.document = documentContext;
        this.getTarget = getTarget;
        this.inspection = inspection;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.root = documentContext.querySelector("#vector-filter-panel");
        this.title = documentContext.querySelector("#vector-filter-title");
        this.rules = documentContext.querySelector("#vector-filter-rules");
        this.enabled = documentContext.querySelector("#vector-filter-enabled");
        this.match = documentContext.querySelector("#vector-filter-match");
        this.status = documentContext.querySelector("#vector-filter-status");
        this.applied = documentContext.querySelector("#vector-filter-applied");
        this.count = documentContext.querySelector("#vector-filter-count");
        this.add = documentContext.querySelector("#vector-filter-add");
        this.clear = documentContext.querySelector("#vector-filter-clear");
        this.closeButton = documentContext.querySelector("#close-vector-filter");
        this.key = null;
        this.timer = null;
        this.generation = 0;
        this.drafts = new Map();
        this.listeners = [];
        this.#listen(this.enabled, "change", () => { this.draft.enabled = this.enabled.checked; this.#changed(); });
        this.#listen(this.match, "change", () => { this.draft.match = this.match.value; this.#changed(); });
        this.#listen(this.add, "click", () => {
            const target = this.getTarget(this.key);
            if (!target || this.draft.rules.length >= MAX_VECTOR_FILTER_RULES) return;
            const field = target.fields[0];
            this.draft.rules.push({ field: field?.name ?? "", operator: vectorFilterOperators(field?.type)[0].value, value: "" });
            this.#renderRules(); this.#changed();
            this.rules.lastElementChild?.querySelector("select")?.focus();
        });
        this.#listen(this.clear, "click", () => {
            this.draft = structuredClone(EMPTY_VECTOR_FILTER);
            this.#renderDraft(); this.#changed(true);
        });
        this.#listen(this.closeButton, "click", () => this.close());
        this.#listen(this.root, "keydown", (event) => {
            if (event.key !== "Escape") return;
            event.preventDefault(); event.stopPropagation(); this.close();
        });
    }

    /**
     * Open the chosen vector's retained filter draft.
     * @param {string} key Retained layer identity.
     * @return {void}
     */
    open(key) {
        const target = this.getTarget(key);
        if (!target) return;
        if (this.key !== null) {
            this.#saveDraft();
            if (this.timer !== null) void this.#apply();
        }
        this.#cancelTimer();
        this.key = key;
        this.opener = this.document.activeElement;
        this.draft = structuredClone(this.drafts.get(key) ?? target.filter ?? EMPTY_VECTOR_FILTER);
        this.title.textContent = target.label;
        this.#renderDraft();
        this.refresh();
        this.#validate();
        this.inspection.showFilter(target.label);
        this.closeButton.focus();
    }

    /** Refresh applied state and counts without disrupting typing. @return {void} */
    refresh() {
        if (this.key === null) return;
        const target = this.getTarget(this.key);
        if (!target) { this.close(); return; }
        this.applied.textContent = `Applied: ${vectorFilterSummary(target.filter)}`;
        this.count.textContent = target.status || "All features are included.";
        this.add.disabled = target.fields.length === 0 || this.draft.rules.length >= MAX_VECTOR_FILTER_RULES;
    }

    /** Save the draft, finish valid pending edits, and restore focus. @return {void} */
    close() {
        if (this.key === null) return;
        this.#saveDraft();
        if (this.timer !== null) { this.#cancelTimer(); void this.#apply(); }
        this.key = null;
        this.inspection.hideFilter();
        if (this.opener?.isConnected && !this.opener.disabled) this.opener.focus();
    }

    /** Detach panel listeners and cancel timers on teardown. @return {void} */
    destroy() {
        this.#cancelTimer();
        this.generation++;
        for (const [element, type, listener] of this.listeners) element.removeEventListener(type, listener);
        this.listeners = [];
    }

    /**
     * Track a fixed DOM listener for teardown.
     * @param {Element} element Event target.
     * @param {string} type Event type.
     * @param {Function} listener Event listener.
     * @return {void}
     */
    #listen(element, type, listener) {
        element.addEventListener(type, listener);
        this.listeners.push([element, type, listener]);
    }

    /** Save the current bounded per-layer draft. @return {void} */
    #saveDraft() {
        if (this.key !== null) this.drafts.set(this.key, structuredClone(this.draft));
        while (this.drafts.size > 50) this.drafts.delete(this.drafts.keys().next().value);
    }

    /** Cancel scheduled edits without changing the applied filter. @return {void} */
    #cancelTimer() {
        if (this.timer !== null) this.clearTimer(this.timer);
        this.timer = null;
    }

    /**
     * Validate input and schedule only complete rules.
     * @param {boolean} [immediate=false] Apply a complete clear/disable action now.
     * @return {void}
     */
    #changed(immediate = false) {
        this.generation++;
        this.getTarget(this.key)?.cancelPending();
        this.#cancelTimer(); this.#saveDraft();
        if (!this.#validate()) return;
        this.status.textContent = "Changes will apply automatically…";
        if (immediate) void this.#apply();
        else this.timer = this.setTimer(() => { this.timer = null; void this.#apply(); }, 450);
        this.refresh();
    }

    /** Validate the draft and explain any retained prior filter. @return {Object|null} */
    #validate() {
        const target = this.getTarget(this.key);
        if (!target) return null;
        try {
            const candidate = normalizeVectorFilter(this.draft, target.fields);
            this.status.textContent = "Changes apply automatically. Text comparisons are case-sensitive.";
            this.status.classList.remove("is-error");
            return candidate;
        } catch (error) {
            this.status.textContent = `${error.message} The previous applied filter remains in use.`;
            this.status.classList.add("is-error");
            return null;
        }
    }

    /** Apply a captured target; stale replies cannot overwrite another draft. @return {Promise<void>} */
    async #apply() {
        const target = this.getTarget(this.key);
        const candidate = this.#validate();
        if (!target || !candidate) return;
        const key = this.key, generation = this.generation;
        this.status.textContent = "Applying filter…";
        try {
            const result = await target.apply(candidate);
            if (key !== this.key || generation !== this.generation || result === null) return;
            this.status.textContent = "Filter applied. Changes apply automatically.";
            this.refresh();
        } catch (error) {
            if (key !== this.key || generation !== this.generation || error.name === "AbortError") return;
            this.status.textContent = `${error.message} The previous applied filter remains in use.`;
            this.status.classList.add("is-error");
        }
    }

    /** Render fixed options and rule rows for a newly selected draft. @return {void} */
    #renderDraft() {
        this.enabled.checked = this.draft.enabled;
        this.match.value = this.draft.match;
        this.#renderRules();
    }

    /** Render accessible field/operator/value rows; input edits keep focus. @return {void} */
    #renderRules() {
        const fields = this.getTarget(this.key)?.fields ?? [];
        this.rules.replaceChildren(...this.draft.rules.map((rule, index) => {
            const row = this.document.createElement("div"); row.className = "vector-filter-rule";
            const select = (label, options, selected) => {
                const element = this.document.createElement("select");
                element.setAttribute("aria-label", `Condition ${index + 1} ${label}`);
                for (const { value, label: text } of options) {
                    const option = this.document.createElement("option"); option.value = value; option.textContent = text; element.append(option);
                }
                element.value = selected;
                return element;
            };
            const field = select("field", fields.map(({ name }) => ({ value: name, label: name })), rule.field);
            const type = fields.find(({ name }) => name === rule.field)?.type;
            const operator = select("comparison", vectorFilterOperators(type), rule.operator);
            field.addEventListener("change", () => {
                rule.field = field.value;
                const options = vectorFilterOperators(fields.find(({ name }) => name === rule.field)?.type);
                rule.operator = options[0].value; rule.value = "";
                this.#renderRules(); this.#changed();
                this.rules.children[index]?.querySelectorAll("select")[1]?.focus();
            });
            operator.addEventListener("change", () => {
                rule.operator = operator.value;
                rule.value = ["missing", "present"].includes(rule.operator) ? null : "";
                this.#renderRules(); this.#changed();
                this.rules.children[index]?.querySelectorAll("select")[1]?.focus();
            });
            row.append(field, operator);
            if (!["missing", "present"].includes(rule.operator)) {
                const kind = vectorFilterFieldKind(type);
                const input = kind === "boolean" ? select("value", [
                    { value: "", label: "Choose value" }, { value: "true", label: "True" }, { value: "false", label: "False" },
                ], String(rule.value)) : this.document.createElement("input");
                if (kind !== "boolean") {
                    input.type = kind === "number" ? "number" : kind === "date" ? "date" : "text";
                    input.step = "any"; input.maxLength = 256; input.value = rule.value ?? "";
                    input.placeholder = kind === "number" ? "Enter number" : "Enter value";
                    input.setAttribute("aria-label", `Condition ${index + 1} value`);
                }
                input.addEventListener(kind === "boolean" ? "change" : "input", () => {
                    rule.value = kind === "number" ? (input.value.trim() === "" ? "" : Number(input.value)) :
                        kind === "boolean" ? (input.value === "" ? "" : input.value === "true") : input.value;
                    this.#changed();
                });
                row.append(input);
            }
            const remove = this.document.createElement("button"); remove.type = "button"; remove.className = "secondary-button";
            remove.textContent = "Remove"; remove.setAttribute("aria-label", `Remove condition ${index + 1}`);
            remove.addEventListener("click", () => { this.draft.rules.splice(index, 1); this.#renderRules(); this.#changed(); this.add.focus(); });
            row.append(remove);
            return row;
        }));
        this.add.disabled = fields.length === 0 || this.draft.rules.length >= MAX_VECTOR_FILTER_RULES;
    }
}
