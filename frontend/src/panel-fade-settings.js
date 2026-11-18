/**
 * Bind the workspace's panel fade controls and restore this browser's choices.
 * The number inputs name CSS custom properties. Their stylesheet values supply
 * the defaults for first use and for restoring the original timings.
 *
 * @param {HTMLElement} app Map workspace containing the Settings panel.
 * @param {{read:()=>string|null, write:(text:string)=>boolean, clear:()=>boolean}} storage
 * Failure-tolerant storage for this preference alone.
 * @return {()=>void} Disconnect the controls and release their CSS overrides.
 */
export function bindPanelFadeSettings(app, storage) {
    const toggle = app.querySelector("#enable-panel-fading");
    const options = app.querySelector("#panel-fade-options");
    const defaults = app.ownerDocument.defaultView.getComputedStyle(app);
    const listeners = new AbortController();
    const events = {signal: listeners.signal};
    /** @type {Record<string, number>} Last valid number for each control. */
    const values = {};
    let saved;
    try {
        saved = JSON.parse(storage.read() ?? "null");
    } catch {
        saved = null;
    }

    /** Remember the toggle and the values currently applied to the map. @return {void} */
    function savePreferences() {
        storage.write(JSON.stringify({...values, enabled: toggle.checked}));
    }

    /** Apply the toggle to all panels and to the controls for tuning them. @return {void} */
    function applyToggle() {
        app.toggleAttribute("data-panel-fade-disabled", !toggle.checked);
        options.disabled = !toggle.checked;
    }

    toggle.checked = typeof saved?.enabled === "boolean" ? saved.enabled : toggle.defaultChecked;
    applyToggle();
    toggle.addEventListener("change", () => { applyToggle(); savePreferences(); }, events);

    const restoreFields = Array.from(options.querySelectorAll(".panel-fade-setting"), row => {
        const number = row.querySelector('input[type="number"]');
        const slider = row.querySelector('input[type="range"]');
        const property = `--${number.id}`;
        const cssDefault = defaults.getPropertyValue(property).trim();
        const unit = cssDefault.endsWith("%") ? "%" : "ms";
        const cssValue = Number.parseFloat(cssDefault);
        const defaultValue = unit === "ms" && !cssDefault.endsWith("ms")
            ? Math.round(cssValue * 1000) : cssValue;
        const sliderMax = Number(slider.max);
        if (unit === "ms") number.max = String(2_147_483_647);

        /** Apply one valid setting without disturbing a number draft or rescaling a moving slider.
         * @param {number} value Whole milliseconds or percent.
         * @param {HTMLInputElement|null} [source] The control being edited, if any.
         * @return {void}
         */
        function applyValue(value, source = null) {
            values[number.id] = value;
            app.style.setProperty(property, value + unit);
            if (source !== slider) slider.max = String(Math.max(sliderMax, value));
            slider.value = String(value);
            slider.setAttribute("aria-valuetext", value + (unit === "%" ? "%" : " milliseconds"));
            if (source !== number) number.value = String(value);
            number.removeAttribute("aria-invalid");
        }

        const stored = saved?.[number.id];
        applyValue(Number.isInteger(stored) && stored >= Number(number.min) && stored <= Number(number.max)
            ? stored : defaultValue);
        slider.addEventListener("input", () => {
            applyValue(slider.valueAsNumber, slider);
        }, events);
        slider.addEventListener("change", savePreferences, events);
        number.addEventListener("input", () => {
            if (number.validity.valid) {
                applyValue(number.valueAsNumber, number);
                savePreferences();
            } else {
                number.setAttribute("aria-invalid", "true");
            }
        }, events);
        number.addEventListener("blur", () => {
            number.value = slider.value;
            number.removeAttribute("aria-invalid");
        }, events);
        number.addEventListener("keydown", event => {
            if (event.key === "Enter") number.reportValidity();
        }, events);
        return () => applyValue(defaultValue);
    });

    app.querySelector("#restore-panel-fade-defaults").addEventListener("click", () => {
        toggle.checked = toggle.defaultChecked;
        applyToggle();
        for (const restore of restoreFields) restore();
        storage.clear();
    }, events);
    return () => {
        listeners.abort();
        for (const restore of restoreFields) restore();
        app.removeAttribute("data-panel-fade-disabled");
        for (const id of Object.keys(values)) app.style.removeProperty(`--${id}`);
    };
}
