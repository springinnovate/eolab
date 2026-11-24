/** Compact variable and observation choices retained inside one map-layer row. */
import { observationLabel, observationMonthLabel } from "../observation-period.js";
import { formatObservationTime } from "./observation-time.js";

/**
 * Update a select without replacing unchanged options or its focused element.
 * @param {HTMLSelectElement} select Existing choice control.
 * @param {{value:string,label:string}[]} choices Available choices.
 * @param {string|null} value Selected value, including an unavailable saved value.
 * @param {string} [savedLabel=value] Display label for a missing selection.
 * @return {void}
 */
function setChoices(select, choices, value, savedLabel = value) {
    const options = value && !choices.some(choice => choice.value === value)
        ? [{value, label: `${savedLabel} (unavailable)`}, ...choices] : choices;
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
            if (name === "month") this.monthCaption = caption;
            if (name === "time") this.timeCaption = caption;
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
     * @param {{variables:{id:string,label:string,units:string}[],variable:string,months:string[],month:string,times:string[],time:string|null,loading:boolean,error:string|null,period?:string,intervalStarts?:Object<string,string>}} state Raster-owned choices and status.
     * @return {void}
     */
    render({variables, variable, months, month, times, time, loading, error, period, intervalStarts}) {
        this.monthCaption.textContent = ["year", "calendar_year"].includes(period) ? "Year" : "Month";
        this.timeCaption.textContent = period ? "Observation" : "Date and time (UTC)";
        setChoices(this.variable, variables.map(value => ({value: value.id,
            label: `${value.label}${value.units ? ` (${value.units})` : ""}`})), variable);
        if (this.period !== period || this.months !== months || this.unavailableMonth || !months.includes(month)) {
            this.unavailableMonth = Boolean(month && !months.includes(month));
            setChoices(this.month, months.map(value => ({value, label: observationMonthLabel(value, period)})), month,
                month && observationMonthLabel(month, period));
            this.months = months;
        } else this.month.value = month;
        if (this.period !== period || this.times !== times || this.unavailableTime || !times.includes(time)) {
            this.unavailableTime = Boolean(time && !times.includes(time));
            setChoices(this.time, times.map(value => ({value, label: observationLabel(value, period, intervalStarts?.[value]) ?? formatObservationTime(value)})), time,
                time && (observationLabel(time, period, intervalStarts?.[time]) ?? time));
            this.times = times;
        } else this.time.value = time;
        this.month.disabled = months.length === 0;
        this.time.disabled = times.length === 0;
        this.period = period;
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
