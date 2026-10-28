/** Optional prepared-value suggestions owned by the vector rule editor. */

let nextPickerId = 0;

/** Keep paged suggestion searches separate from the rule's applied scalar. */
export class VectorFilterValuePicker {
    /**
     * Create a disclosure beside an existing direct-entry value input.
     * @param {Object} options Editor-owned dependencies.
     * @param {Document} options.documentContext Owning document.
     * @param {HTMLInputElement} options.input Existing scalar input, focused after selection.
     * @param {string} options.field Exact field name for labels and queries.
     * @param {number} options.condition One-based rule number for accessible labels.
     * @param {(query:{field:string,search:string,offset:number},signal:AbortSignal)=>Promise<{values:string[],nextOffset:number|null}>} options.loadValues Prepared-value API callback.
     * @param {(value:string)=>boolean} options.acceptsValue Current filter-contract validation.
     * @param {(value:string)=>void} options.selectValue Set the exact scalar through the editor.
     * @param {()=>boolean} options.isCurrent Whether the source is still selected.
     * @param {(handler:()=>void,delay:number)=>ReturnType<typeof globalThis.setTimeout>} options.setTimer Search debounce scheduler.
     * @param {(timer:ReturnType<typeof globalThis.setTimeout>)=>void} options.clearTimer Search debounce canceller.
     */
    constructor({ documentContext, input, field, condition, loadValues, acceptsValue, selectValue, isCurrent, setTimer, clearTimer }) {
        Object.assign(this, { document: documentContext, input, field, loadValues, acceptsValue, selectValue, isCurrent, setTimer, clearTimer });
        this.timer = null; this.request = null; this.active = -1; this.values = []; this.options = []; this.previousOffsets = [];
        const id = `vector-filter-values-${++nextPickerId}`;
        this.root = this.document.createElement("div"); this.root.className = "vector-filter-value-picker";
        this.toggle = this.#button("Choose available value", () => {
            if (!this.panel.hidden) { this.close(); return; }
            this.panel.hidden = false; this.toggle.setAttribute("aria-expanded", "true");
            this.search.setAttribute("aria-expanded", "true"); this.search.focus();
            this.search.value = ""; this.previousOffsets = []; void this.#load(0);
        });
        this.toggle.setAttribute("aria-label", `Condition ${condition}: choose available ${field} value`);
        this.toggle.setAttribute("aria-expanded", "false"); this.toggle.setAttribute("aria-controls", id);
        this.panel = this.document.createElement("div"); this.panel.id = id; this.panel.hidden = true;
        this.search = this.document.createElement("input"); this.search.type = "text"; this.search.maxLength = 256;
        this.search.placeholder = "Search available values";
        this.search.setAttribute("aria-label", `Condition ${condition}: search available ${field} values`);
        this.search.setAttribute("role", "combobox"); this.search.setAttribute("aria-autocomplete", "list");
        this.search.setAttribute("aria-controls", `${id}-list`); this.search.setAttribute("aria-expanded", "false");
        this.list = this.document.createElement("div"); this.list.id = `${id}-list`; this.list.className = "vector-filter-value-list";
        this.list.setAttribute("role", "listbox"); this.list.setAttribute("aria-label", `Available ${field} values`);
        this.status = this.document.createElement("p"); this.status.id = `${id}-status`;
        this.status.className = "vector-filter-help"; this.status.setAttribute("role", "status");
        this.search.setAttribute("aria-describedby", this.status.id);
        this.previous = this.#button("Previous values", () => { void this.#load(this.previousOffsets.pop()); });
        this.next = this.#button("More values", () => { this.previousOffsets.push(this.offset); void this.#load(this.nextOffset); });
        this.retry = this.#button("Retry values", () => { void this.#load(this.offset); });
        this.retry.hidden = true;
        this.panel.append(this.search, this.list, this.status, this.previous, this.next, this.retry);
        this.root.append(this.toggle, this.panel);
        this.search.addEventListener("input", () => {
            this.#cancel(); this.#clearOptions(); this.previousOffsets = [];
            this.status.textContent = "Searching available values…";
            this.previous.disabled = this.next.disabled = true; this.retry.hidden = true;
            this.timer = this.setTimer(() => { this.timer = null; void this.#load(0); }, 200);
        });
        this.search.addEventListener("keydown", event => this.#navigate(event));
        this.root.addEventListener("keydown", event => {
            if (event.key !== "Escape" || this.panel.hidden) return;
            event.preventDefault(); event.stopPropagation(); this.close(); this.toggle.focus();
        });
        this.root.addEventListener("focusout", event => {
            if (!this.root.contains(event.relatedTarget)) this.close();
        });
    }

    /**
     * Create a keyboard-reachable action in this picker.
     * @param {string} label Visible action label.
     * @param {()=>void} action Click handler.
     * @return {HTMLButtonElement} Unsubmitted button.
     */
    #button(label, action) {
        const button = this.document.createElement("button"); button.type = "button";
        button.className = "secondary-button"; button.textContent = label;
        button.addEventListener("click", action); return button;
    }

    /** Hide suggestions and cancel requests without changing the scalar. @return {void} */
    close() {
        this.#cancel(); this.panel.hidden = true;
        this.toggle.setAttribute("aria-expanded", "false"); this.search.setAttribute("aria-expanded", "false");
        this.#clearOptions();
    }

    /** Cancel search work and detach the editor-owned picker on a rule change. @return {void} */
    destroy() { this.close(); this.root.remove(); }

    /** Cancel a scheduled search and invalidate even non-cooperative HTTP replies. @return {void} */
    #cancel() {
        if (this.timer !== null) this.clearTimer(this.timer);
        this.timer = null; this.request?.abort(); this.request = null;
    }

    /** Remove stale options and their active-descendant relationship. @return {void} */
    #clearOptions() {
        this.values = []; this.options = []; this.active = -1;
        this.list.replaceChildren(); this.search.removeAttribute("aria-activedescendant");
    }

    /**
     * Replace the visible page; only the latest search may publish suggestions.
     * @param {number} offset Position in the matching prepared-value inventory.
     * @return {Promise<void>}
     */
    async #load(offset) {
        if ([this.previous, this.next, this.retry].includes(this.document.activeElement)) this.search.focus();
        this.#cancel(); this.#clearOptions(); this.offset = offset;
        const request = new AbortController(); this.request = request;
        this.previous.disabled = this.next.disabled = true; this.retry.hidden = true;
        this.list.setAttribute("aria-busy", "true"); this.status.textContent = "Loading available values…";
        try {
            const page = await this.loadValues({ field: this.field, search: this.search.value, offset }, request.signal);
            if (request !== this.request || !this.isCurrent()) return;
            this.values = page.values; this.nextOffset = page.nextOffset;
            this.options = page.values.map((value, index) => {
                const option = this.document.createElement("div"); option.id = `${this.list.id}-${index}`;
                option.setAttribute("role", "option"); option.setAttribute("aria-selected", "false");
                option.setAttribute("aria-disabled", String(!this.acceptsValue(value)));
                option.textContent = JSON.stringify(value);
                option.addEventListener("pointerdown", event => event.preventDefault());
                option.addEventListener("click", () => this.#choose(index));
                return option;
            });
            this.list.replaceChildren(...this.options); this.list.scrollTop = 0;
            const unavailable = this.options.some(option => option.getAttribute("aria-disabled") === "true");
            this.status.textContent = page.values.length
                ? `Values ${offset + 1}–${offset + page.values.length}. Choose one to set the condition.${unavailable ? " Dimmed values exceed the filter's text length or character limits." : ""}`
                : "No available values match. You can still enter a value directly.";
            this.previous.disabled = this.previousOffsets.length === 0; this.next.disabled = page.nextOffset === null;
        } catch (error) {
            if (request !== this.request || !this.isCurrent() || error.name === "AbortError") return;
            this.status.textContent = `${error.message} You can still enter a value directly.`; this.retry.hidden = false;
        } finally {
            if (request === this.request) { this.request = null; this.list.setAttribute("aria-busy", "false"); }
        }
    }

    /**
     * Set one valid exact value while retaining the selected comparison.
     * @param {number} index Option index on the current page.
     * @return {void}
     */
    #choose(index) {
        const value = this.values[index];
        if (value === undefined || !this.acceptsValue(value) || !this.isCurrent()) return;
        this.selectValue(value); this.close(); this.input.focus();
    }

    /**
     * Move the active option without moving focus from the search combobox.
     * @param {KeyboardEvent} event Search input keyboard event.
     * @return {void}
     */
    #navigate(event) {
        if (event.key === "Enter") {
            event.preventDefault(); if (this.active >= 0) this.#choose(this.active); return;
        }
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        let index = this.active < 0 ? (step > 0 ? 0 : this.values.length - 1) : this.active + step;
        while (index >= 0 && index < this.values.length && !this.acceptsValue(this.values[index])) index += step;
        if (index < 0 || index >= this.values.length) return;
        this.active = index;
        this.options.forEach((option, position) => option.setAttribute("aria-selected", String(position === index)));
        this.search.setAttribute("aria-activedescendant", this.options[index].id);
        this.options[index].scrollIntoView({ block: "nearest" });
    }
}
