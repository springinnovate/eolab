/** Full-sample overview, draggable value window, and its numeric inputs. */
import { formatHistogramMagnitude } from "./histogram-axes.js";

/** Format a raster limit for compact, editable display without dropping precision.
 * @param {number} value Finite raster value.
 * @return {string} Grouped decimal or scientific notation.
 */
function formatLimit(value) {
    return String(value).includes("e") ? String(value) :
        value.toLocaleString("en-US", {maximumSignificantDigits: 17});
}

/** Keep a value between two ordered limits.
 * @param {number} value Requested value.
 * @param {number} low Lower limit.
 * @param {number} high Upper limit.
 * @return {number} Value clipped to the interval.
 */
function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

/** Select a value interval within the fixed overview of one continuous raster sample. */
export class HistogramRangeNavigator {
    /** Create controls for resizing and panning the window.
     * @param {Document} doc Owning document.
     * @param {{counts:number[],edges:number[]}} histogram Original full distribution.
     * @param {(range:number[]|null)=>boolean} onChange Apply limits or restore the full range.
     * @param {()=>void} onInvalid Cancel a pending recount while a numeric edit is incomplete.
     */
    constructor(doc, histogram, onChange, onInvalid) {
        this.low = histogram.edges[0];
        this.high = histogram.edges.at(-1);
        this.range = [this.low, this.high];
        this.onChange = onChange;
        this.onInvalid = onInvalid;
        this.root = doc.createElement("div");
        this.root.className = "histogram-navigator";
        this.root.setAttribute("role", "group");
        this.root.setAttribute("aria-label", "Histogram value range");
        this.track = doc.createElement("div");
        this.track.className = "histogram-overview";
        const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", `0 0 ${histogram.counts.length} 24`);
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("aria-hidden", "true");
        const peak = Math.max(...histogram.counts);
        const bars = doc.createElementNS("http://www.w3.org/2000/svg", "path");
        bars.setAttribute("d", histogram.counts.map((count, i) =>
            `M${i},24v-${count / peak * 22}h1V24z`).join(""));
        svg.append(bars);
        this.track.append(svg);
        this.grips = new Map();
        for (const [part, label] of [["minimum", "Drag minimum value"], ["pan", "Move visible range"], ["maximum", "Drag maximum value"]]) {
            const grip = doc.createElement("button");
            grip.type = "button";
            grip.className = `histogram-grip histogram-grip-${part}`;
            grip.setAttribute("role", "slider");
            grip.setAttribute("aria-label", label);
            if (part === "pan") {
                const tab = doc.createElement("span");
                tab.className = "histogram-pan-tab";
                grip.append(tab);
            }
            grip.addEventListener("keydown", event => this.#key(event, part));
            grip.addEventListener("pointerdown", event => {
                if (event.button !== 0 || this.drag || grip.disabled) return;
                this.drag = {part, pointer: event.pointerId, x: event.clientX, range: [...this.range]};
                grip.setPointerCapture(event.pointerId);
                event.preventDefault();
                grip.focus({preventScroll: true});
            });
            grip.addEventListener("pointermove", event => {
                if (this.drag?.pointer !== event.pointerId) return;
                const width = this.track.getBoundingClientRect().width;
                this.#move(part, this.drag.range, (event.clientX - this.drag.x) / width * (this.high - this.low));
            });
            grip.addEventListener("lostpointercapture", () => { this.drag = null; });
            this.grips.set(part, grip);
            this.track.append(grip);
        }
        const ticks = doc.createElement("div");
        ticks.className = "histogram-overview-ticks";
        const limits = [this.low, this.low / 2 + this.high / 2, this.high];
        const labels = limits.map(value => formatHistogramMagnitude(value, 6));
        const distinct = new Set(labels).size === limits.length;
        for (const [index, value] of limits.entries()) {
            if (!distinct && index === 1) continue;
            const tick = doc.createElement("span");
            tick.textContent = distinct ? labels[index] : String(value);
            tick.title = formatLimit(value);
            ticks.append(tick);
        }
        const fields = doc.createElement("div");
        fields.className = "histogram-axis-controls histogram-range-fields";
        this.inputs = ["Min", "Max"].map((label, index) => {
            const wrapper = doc.createElement("label");
            const caption = doc.createElement("span");
            caption.textContent = label;
            const input = doc.createElement("input");
            input.type = "text";
            input.inputMode = "decimal";
            input.setAttribute("aria-label", index === 0 ? "Minimum raster value" : "Maximum raster value");
            input.addEventListener("input", () => this.#edit());
            input.addEventListener("blur", () => {
                if (input.getAttribute("aria-invalid") !== "true") input.value = formatLimit(this.range[index]);
            });
            wrapper.append(caption, input);
            fields.append(wrapper);
            return input;
        });
        this.reset = doc.createElement("button");
        this.reset.type = "button";
        this.reset.className = "secondary-button";
        this.reset.textContent = "Full range";
        this.reset.setAttribute("aria-label", "Show full range");
        this.reset.addEventListener("click", () => this.onChange(null));
        fields.append(this.reset);
        this.status = doc.createElement("p");
        this.status.className = "histogram-range-status";
        this.status.setAttribute("role", "status");
        this.root.append(this.track, ticks, fields, this.status);
        this.show(this.range);
    }

    /** Apply complete numeric drafts within the full sample's range.
     * @return {void}
     */
    #edit() {
        const range = this.inputs.map(input => {
            const draft = input.value.trim();
            return /^[+-]?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(draft)
                ? Number(draft.replaceAll(",", "")) : NaN;
        });
        let error = "";
        if (!range.every(Number.isFinite)) error = "Enter a number for both limits.";
        else if (range[0] >= range[1]) error = "Minimum must be below maximum.";
        else if (range[0] < this.low || range[1] > this.high) {
            error = `Choose limits between ${formatLimit(this.low)} and ${formatLimit(this.high)}.`;
        }
        if (!error) {
            this.typing = true;
            if (!this.onChange(range)) error = "Choose limits that fit the selected axis scale.";
            this.typing = false;
        }
        if (error) this.onInvalid();
        for (const input of this.inputs) input.setAttribute("aria-invalid", String(Boolean(error)));
        this.status.textContent = error;
    }

    /** Move a grip by keyboard, with larger steps when Shift is held.
     * @param {KeyboardEvent} event Focused slider's key event.
     * @param {string} part Minimum edge, maximum edge or middle.
     * @return {void}
     */
    #key(event, part) {
        const direction = {ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, Home: -Infinity, End: Infinity}[event.key];
        if (direction === undefined) return;
        event.preventDefault();
        this.#move(part, this.range, direction * (this.range[1] - this.range[0]) * (event.shiftKey ? 0.1 : 0.01));
    }

    /** Apply an edge displacement or translate both bounds by the same amount.
     * @param {string} part Grip being moved.
     * @param {number[]} range Limits at the start of the movement.
     * @param {number} delta Requested offset in raster units.
     * @return {void}
     */
    #move(part, [min, max], delta) {
        // Pointer coordinates rarely land on readable values. Preserve finer precision on zoom.
        const step = 10 ** Math.floor(Math.log10((max - min) / 1000));
        if (Number.isFinite(delta) && step > 0) delta = Math.round(delta / step) * step;
        const gap = Math.min(max - min, Math.max((this.high - this.low) * 1e-9,
            Math.max(Math.abs(min), Math.abs(max)) * Number.EPSILON * 64));
        if (part === "minimum") min = clamp(min + delta, this.low, max - gap);
        else if (part === "maximum") max = clamp(max + delta, min + gap, this.high);
        else {
            const shift = clamp(delta, this.low - min, this.high - max);
            min += shift;
            max += shift;
        }
        this.onChange([min, max]);
    }

    /** Synchronize grips, values and accessible limits with the accepted x axis.
     * @param {number[]} range Current numeric minimum and maximum.
     * @return {void}
     */
    show(range) {
        this.range = range;
        const [min, max] = range;
        this.track.dataset.full = String(min === this.low && max === this.high);
        const span = this.high - this.low;
        this.track.style.setProperty("--window-left", `${100 * clamp((min - this.low) / span, 0, 1)}%`);
        this.track.style.setProperty("--window-right", `${100 * clamp((this.high - max) / span, 0, 1)}%`);
        for (const [part, grip] of this.grips) {
            grip.setAttribute("aria-valuemin", String(part === "maximum" ? min : this.low));
            grip.setAttribute("aria-valuemax", String(part === "minimum" ? max : part === "pan" ? this.high - (max - min) : this.high));
            grip.setAttribute("aria-valuenow", String(part === "maximum" ? max : min));
            grip.setAttribute("aria-valuetext", part === "pan" ? `${formatLimit(min)} to ${formatLimit(max)}` :
                formatLimit(part === "maximum" ? max : min));
        }
        if (!this.typing) this.inputs.forEach((input, i) => {
            input.value = formatLimit(range[i]);
            input.removeAttribute("aria-invalid");
        });
    }

    /** Enable or disable range editing when the chart's sample changes.
     * @param {boolean} enabled Whether these controls may change the chart.
     * @return {void}
     */
    setEnabled(enabled) {
        for (const control of [...this.inputs, ...this.grips.values(), this.reset]) control.disabled = !enabled;
        if (!enabled) this.drag = null;
    }
}
