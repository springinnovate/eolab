/** Compact variable and observation choices retained inside one map-layer row. */

/**
 * Update a select without replacing unchanged options or its focused element.
 * @param {HTMLSelectElement} select Existing choice control.
 * @param {{value:string,label:string}[]} choices Available choices.
 * @param {string|null} value Selected value, including an unavailable saved value.
 * @return {void}
 */
function setChoices(select, choices, value) {
    const options = value && !choices.some(choice => choice.value === value)
        ? [{value, label: `${value} (unavailable)`}, ...choices] : choices;
    const signature = JSON.stringify(options);
    if (select.dataset.choices !== signature) {
        select.replaceChildren(...options.map(choice => {
            const option = select.ownerDocument.createElement("option");
            option.value = choice.value;
            option.textContent = choice.label;
            option.disabled = choice.value === value && !choices.some(candidate => candidate.value === value);
            return option;
        }));
        select.dataset.choices = signature;
    }
    select.value = value ?? "";
}

/** Present available UTC observations and forward choices to the raster owner. */
export class TemporalControlsView {
    /**
     * Create retained controls without making source or publication requests.
     * @param {Object} handlers Raster-owned actions.
     * @param {(variable:string)=>void} handlers.onVariableChange Select a variable.
     * @param {(month:string)=>void} handlers.onMonthChange Browse an available month.
     * @param {(time:string)=>void} handlers.onTimeChange Show an available observation.
     * @param {()=>void} handlers.onRetry Refresh choices and retry the explicit selection.
     * @param {Document} [documentContext=globalThis.document] Owning document.
     */
    constructor(handlers, documentContext = globalThis.document) {
        this.element = documentContext.createElement("div");
        this.element.className = "temporal-layer-controls";
        for (const [name, label, callback] of [
            ["variable", "Variable", handlers.onVariableChange],
            ["month", "Month", handlers.onMonthChange],
            ["time", "Date and time (UTC)", handlers.onTimeChange],
        ]) {
            const field = documentContext.createElement("label");
            field.className = `temporal-layer-${name}`;
            const caption = documentContext.createElement("span");
            caption.textContent = label;
            const select = documentContext.createElement("select");
            select.addEventListener("change", () => callback(select.value));
            field.append(caption, select);
            this.element.append(field);
            this[name] = select;
        }
        this.status = documentContext.createElement("p");
        this.status.setAttribute("role", "status");
        this.status.setAttribute("aria-live", "polite");
        this.element.append(this.status);
        const actions = documentContext.createElement("div");
        actions.className = "temporal-layer-actions";
        this.retry = documentContext.createElement("button");
        this.retry.type = "button";
        this.retry.className = "secondary-button";
        this.retry.textContent = "Refresh dates";
        this.retry.addEventListener("click", handlers.onRetry);
        actions.append(this.retry);
        this.element.append(actions);
    }

    /**
     * Present actual coordinate choices and the current loading or failure state.
     * @param {{variables:{id:string,label:string,units:string}[],variable:string,months:string[],month:string,times:string[],time:string|null,loading:boolean,error:string|null}} state Raster-owned choices and status.
     * @return {void}
     */
    render({variables, variable, months, month, times, time, loading, error}) {
        setChoices(this.variable, variables.map(value => ({value: value.id,
            label: `${value.label}${value.units ? ` (${value.units})` : ""}`})), variable);
        setChoices(this.month, months.map(value => ({value, label: value})), month);
        setChoices(this.time, times.map(value => ({value,
            label: new Date(value).toLocaleString(undefined, {timeZone: "UTC", year: "numeric",
                month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23"})})), time);
        this.month.disabled = months.length === 0;
        this.time.disabled = times.length === 0;
        this.retry.disabled = loading;
        this.element.setAttribute("aria-busy", String(loading));
        this.status.textContent = error ?? (loading ? "Loading observation…" :
            times.length ? "Only available observations are listed. Times are UTC." : "No observations are available in this month.");
        this.status.classList.toggle("is-error", error !== null);
    }

    /** Remove this row's controls after its owner cancels outstanding work. @return {void} */
    destroy() {
        this.element.remove();
    }
}
