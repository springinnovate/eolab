/** Browse and play the published observations of one visible map layer. */

/** @typedef {{key:string,visible:boolean,opacity:number,timeline?:import("./raster-viewer.js").TemporalMapTimeline|null}} TimelineLayer */
/** @typedef {{time?:string,month?:string,edge?:"first"|"last"|"firstOfLastDay"}} Destination */

/** Return an exact, compact observation label, preserving nonzero seconds.
 * @param {string} time ISO UTC timestamp.
 * @return {string} Timestamp with an explicit UTC suffix.
 */
function utcLabel(time) {
    return time.replace("T", " ").replace(/\.0+Z$/, "Z").replace(/:00Z$/, "Z").replace("Z", " UTC");
}

/** Replace option elements only when their values or labels change, preserving focus.
 * @param {HTMLSelectElement} select Retained control.
 * @param {string[][]} choices Value and label pairs.
 * @return {void}
 */
function setOptions(select, choices) {
    if (select.options.length === choices.length && choices.every(([value, label], index) =>
        select.options[index].value === value && select.options[index].textContent === label)) return;
    select.replaceChildren(...choices.map(([value, label]) => {
        const option = select.ownerDocument.createElement("option");
        option.textContent = label;
        option.value = value;
        return option;
    }));
}

/** Own the map timeline controls, drag intent and at most two upcoming playback frames. */
export class TemporalScrubber {
    /** Connect the map control to the same date selections as Map contents.
     * @param {HTMLElement} root Timeline region inside the map.
     * @param {Object} actions Browser composition callbacks.
     * @param {(key:string,time:string)=>Promise<void>} actions.selectTime Show an admitted observation.
     * @param {(key:string,month:string,edge:"first"|"last"|"firstOfLastDay")=>Promise<void>} actions.selectMonth Browse a populated month.
     * @param {(key:string,destination:string|{month:string},signal:AbortSignal)=>Promise<(()=>void)|null>} actions.prepare Prepare a timestamp or the first frame of a month and return its display action.
     */
    constructor(root, actions) {
        this.root = root;
        this.actions = actions;
        this.controls = Object.fromEntries([...root.querySelectorAll("[data-timeline]")].map(node => [node.dataset.timeline, node]));
        this.ticks = root.querySelector("datalist");
        this.layers = [];
        this.layer = null;
        this.displayed = new Map();
        this.phase = "idle";
        this.frames = new Map();
        this.playing = false;
        this.playbackError = "";
        this.clock = null;
        this.action = null;
        this.dragTime = null;
        this.dragPreview = null;
        this.dragTimer = null;
        this.events = new AbortController();
        const options = {signal: this.events.signal};
        const {layer, month, stride, back, forward, play, time} = this.controls;
        layer.addEventListener("change", () => this.#chooseLayer(layer.value), options);
        month.addEventListener("change", () => this.#manual({month: month.value, edge: "first"}), options);
        stride.addEventListener("change", () => { this.pause(); this.#render(); }, options);
        back.addEventListener("click", () => this.#manual(this.#neighbor(-1)), options);
        forward.addEventListener("click", () => this.#manual(this.#neighbor(1)), options);
        play.addEventListener("click", () => {
            if (this.playing) this.pause();
            else { this.playbackError = ""; this.playing = true; }
            this.#render();
        }, options);
        time.addEventListener("input", () => {
            if (!this.layer.timeline.times.length) return;
            if (!this.dragTime) this.pause();
            this.dragTime = this.#nearest(time.valueAsNumber);
            this.#render();
            this.#scheduleDrag();
        }, options);
        time.addEventListener("change", () => this.#commitDrag(), options);
        time.addEventListener("keydown", event => {
            const direction = {ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1}[event.key];
            const times = this.layer.timeline.times;
            const target = direction ? this.#neighbor(direction) : event.key === "Home" ? {time: times[0]}
                : event.key === "End" ? {time: times.at(-1)} : null;
            if (direction || target) {
                event.preventDefault();
                this.#manual(target);
            }
        }, options);
        root.addEventListener("keydown", event => event.stopPropagation(), options);
        root.ownerDocument.addEventListener("visibilitychange", () => {
            if (root.ownerDocument.hidden) { this.pause(); this.#render(); }
        }, options);
        this.resize = new root.ownerDocument.defaultView.ResizeObserver(() => {
            root.parentElement.style.setProperty("--timeline-height", (root.offsetHeight + 22) + "px");
        });
        this.resize.observe(root);
    }

    /** Follow visible temporal views in drawing order, retaining the user's named view across reorders.
     * @param {TimelineLayer[]} layers Current Map contents snapshots, topmost first.
     * @return {void}
     */
    setLayers(layers) {
        this.layers = layers.filter(layer => layer.timeline && layer.visible && layer.opacity > 0);
        this.#chooseLayer(this.layer?.key);
    }

    /** Report the actual loaded map, independently of date availability and raster publication.
     * @param {{phase:string}} status Current drawing status.
     * @param {Map<string,{time:string,variable:string,outsideViewport?:boolean}>} displayed Observations drawn or confirmed outside the viewport, by view.
     * @return {void}
     */
    setMapStatus(status, displayed) {
        this.phase = status.phase;
        this.displayed = displayed;
        this.#render();
    }

    /** Release speculative work and pending navigation while keeping the selected map observation.
     * @return {void}
     */
    pause() {
        this.playing = false;
        this.playbackError = "";
        this.action = null;
        clearTimeout(this.clock);
        this.clock = null;
        clearTimeout(this.dragTimer);
        this.dragTimer = null;
        this.dragTime = null;
        this.dragPreview = null;
        for (const frame of this.frames.values()) frame.controller.abort();
        this.frames.clear();
    }

    /** Detach DOM observers and release every pending frame. @return {void} */
    destroy() {
        this.pause();
        this.events.abort();
        this.resize.disconnect();
        this.root.hidden = true;
    }

    /** Adopt a backing view, clearing obsolete playback after external changes to the layer or its dates.
     * @param {string|undefined} key Preferred visible view key.
     * @return {void}
     */
    #chooseLayer(key) {
        const previous = this.layer;
        const layer = this.layers.find(candidate => candidate.key === key) ?? this.layers[0];
        const before = previous?.timeline, next = layer?.timeline;
        const changedView = !next || layer.key !== previous?.key || next.variable !== before?.variable;
        const crossingMonth = this.action?.month && this.action.month === next?.month;
        if (changedView ||
            (!crossingMonth && (next.month !== before.month || next.times !== before.times ||
                (next.time !== before.time && this.action?.time !== next.time && this.dragPreview !== next.time)))) this.pause();
        this.layer = layer;
        this.root.hidden = !layer;
        if (!layer) return;
        setOptions(this.controls.layer, this.layers.map((item, i) => [item.key,
            (this.layers.length > 1 ? (i + 1) + ". " : "") + item.timeline.name + " · " + item.timeline.variableLabel]));
        this.controls.layer.value = layer.key;
        if (next.months !== before?.months) setOptions(this.controls.month, next.months.map(month => [month, month]));
        this.controls.month.value = next.month;
        if (next.times !== before?.times) {
            this.days = next.times.filter((time, index, times) => !index || time.slice(0, 10) !== times[index - 1].slice(0, 10));
            this.epochs = next.times.map(Date.parse);
            this.controls.time.min = this.epochs[0] ?? 0;
            this.controls.time.max = this.epochs.at(-1) ?? 0;
            this.ticks.replaceChildren(...(next.times.length <= 31 ? next.times : this.days).map(time => {
                const mark = this.root.ownerDocument.createElement("option");
                mark.value = String(Date.parse(time));
                return mark;
            }));
        }
        this.#render();
    }

    /** Find the actual label nearest the thumb's position on the elapsed-time scale.
     * @param {number} instant UTC epoch milliseconds.
     * @return {string} Admitted label, favoring the earlier observation on ties.
     */
    #nearest(instant) {
        const after = this.epochs.findIndex(epoch => epoch >= instant);
        const index = after < 0 ? this.epochs.length - 1 :
            after > 0 && instant - this.epochs[after - 1] <= this.epochs[after] - instant ? after - 1 : after;
        return this.layer.timeline.times[index];
    }

    /** Find a real neighboring observation, crossing gaps via the next populated month.
     * @param {-1|1} direction Backward or forward.
     * @param {string} [from] Starting UTC label, defaulting to the selected observation.
     * @return {Destination|null} Time, populated month and edge, or end of coverage.
     */
    #neighbor(direction, from = this.layer.timeline.time) {
        const {times, months, month} = this.layer.timeline;
        const daily = this.controls.stride.value === "day";
        const candidates = daily ? this.days : times;
        const coordinate = daily ? from.slice(0, 10) : from;
        const time = direction > 0 ? candidates.find(t => (daily ? t.slice(0, 10) : t) > coordinate)
            : candidates.findLast(t => (daily ? t.slice(0, 10) : t) < coordinate);
        if (time) return {time};
        const index = months.indexOf(month);
        const adjacent = index < 0 ? null : months[index + direction];
        return adjacent ? {month: adjacent, edge: direction > 0 ? "first" : daily ? "firstOfLastDay" : "last"} : null;
    }

    /** Sample a moving thumb without starting another preview until the current one has drawn.
     * @return {void}
     */
    #scheduleDrag() {
        if (this.dragTimer !== null || this.dragPreview || this.dragTime === this.layer.timeline.time) return;
        this.dragTimer = setTimeout(() => {
            this.dragTimer = null;
            if (this.dragTime === this.layer.timeline.time) return;
            this.dragPreview = this.dragTime;
            void this.actions.selectTime(this.layer.key, this.dragPreview);
        }, 70);
    }

    /** Commit the final thumb position immediately, superseding a slow intermediate preview. @return {void} */
    #commitDrag() {
        if (this.dragTime) this.#manual({time: this.dragTime});
    }

    /** Select a time or month directly, superseding speculative playback and stale drag events.
     * @param {Destination|null} target Observation or month edge.
     * @return {void}
     */
    #manual(target) {
        this.pause();
        if (target?.month) void this.actions.selectMonth(this.layer.key, target.month, target.edge);
        else if (target?.time && target.time !== this.layer.timeline.time) void this.actions.selectTime(this.layer.key, target.time);
        this.#render();
    }

    /** Test whether playback can leave the selected observation, including an empty viewport.
     * @return {boolean} Whether the published observation is drawn or has no tiles to draw here.
     */
    #selectionReady() {
        const selected = this.layer.timeline, drawn = this.displayed.get(this.layer.key);
        return !selected.loading && selected.layerName !== null &&
            drawn?.variable === selected.variable && drawn.time === selected.time;
    }

    /** Show loading progress and label the on-map time only after its raster has drawn.
     * @return {void}
     */
    #render() {
        if (!this.layer) return;
        const t = this.layer.timeline, c = this.controls;
        const drawn = this.displayed.get(this.layer.key);
        const onMapTime = drawn?.variable === t.variable && !drawn.outsideViewport ? drawn.time : null;
        const ready = this.#selectionReady();
        const failed = t.error || (!ready && !t.loading && t.layerName && ["error", "incomplete"].includes(this.phase));
        if (this.dragPreview === t.time && (ready || failed)) {
            this.dragPreview = null;
            this.#scheduleDrag();
        }
        if (failed && this.playing) this.pause();
        const target = this.dragTime ?? t.time;
        if (t.times.length) c.time.value = Date.parse(target);
        c.time.setAttribute("aria-valuetext", utcLabel(target));
        c.time.disabled = t.times.length < 2 && t.months.length < 2;
        c.month.disabled = !t.months.length;
        const next = this.#neighbor(1), previous = this.#neighbor(-1);
        c.back.disabled = !previous;
        c.forward.disabled = !next;
        c.play.disabled = !this.playing && (!next || !ready || Boolean(failed));
        c.play.textContent = this.playing ? "Pause" : "Play";
        c.display.textContent = onMapTime ? "On map · " + utcLabel(onMapTime) : "";
        const pending = this.dragTime ?? this.action?.time ?? t.time;
        const message = t.error || this.playbackError || (failed ? "This observation could not be drawn. Retry the map or choose another time." :
            t.loading && !t.times.length ? "Loading dates for " + t.month :
                (!ready || pending !== t.time || (this.action?.month && this.action.month !== t.month)) ? "Loading raster…" : "");
        if (c.status.textContent !== message) c.status.textContent = message;
        if (next?.time) {
            const seconds = (Date.parse(next.time) - Date.parse(t.time)) / 1000;
            const unit = seconds % 86400 === 0 ? ["day", 86400] : seconds % 3600 === 0 ? ["hour", 3600] :
                seconds % 60 === 0 ? ["minute", 60] : ["second", 1];
            const count = seconds / unit[1];
            c.gap.textContent = "Next · " + count + " " + unit[0] + (count === 1 ? "" : "s") + " later";
        } else c.gap.textContent = next ? "Next month · " + next.month : "End of available dates";
        if (!this.playing || this.action || !ready) return;
        if (!next) { this.pause(); c.play.textContent = "Play"; c.play.disabled = true; return; }
        if (next.time) {
            this.#prepare(next);
            const following = this.#neighbor(1, next.time);
            if (following?.time) this.#prepare(following);
        }
        this.clock ??= setTimeout(() => { this.clock = null; void this.#advance(); }, 167);
    }

    /** Reuse a pending frame or prepare a timestamp or the first observation in the next month.
     * @param {Destination} target Next playback destination.
     * @return {{controller:AbortController,ready:Promise<(()=>void)|null>}} Cancellable work and its display action.
     */
    #prepare(target) {
        const key = target.time ?? target.month;
        if (!this.frames.has(key)) {
            const controller = new AbortController();
            const destination = target.time ?? {month: target.month};
            const ready = this.actions.prepare(this.layer.key, destination, controller.signal).catch(() => null);
            this.frames.set(key, {controller, ready});
        }
        return this.frames.get(key);
    }

    /** Advance after the frame interval and tile readiness, holding the drawn observation during buffering.
     * @return {Promise<void>} Completion after selection or cancellation.
     */
    async #advance() {
        if (!this.playing || !this.#selectionReady()) return;
        const target = this.#neighbor(1);
        if (!target) return;
        this.action = target;
        this.#render();
        const frame = this.#prepare(target);
        try {
            const show = await frame.ready;
            if (this.action !== target) return;
            this.frames.delete(target.time ?? target.month);
            if (show) show();
            else if (target.time) await this.actions.selectTime(this.layer.key, target.time);
            else {
                this.pause();
                this.playbackError = "Could not load the next month. Press Play to retry or choose another month.";
                this.#render();
            }
        } finally {
            frame.controller.abort();
            if (this.action === target) { this.action = null; this.#render(); }
        }
    }
}
