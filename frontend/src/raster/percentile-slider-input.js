/** Keep histogram percentile sliders one step apart during native input. */

/**
 * Clamp the edited percentile slider between its unchanged neighbors.
 * The three native sliders use integer percentages on a fixed 0–100 track.
 * Checkbox changes are ignored so the same listener can handle color matching.
 * @param {{lower:HTMLInputElement,middle:HTMLInputElement,upper:HTMLInputElement}} inputs Ordered percentile sliders.
 * @param {EventTarget|null} editedInput Native control dispatching the input event.
 * @return {void}
 */
export function clampHistogramPercentileInput(inputs, editedInput) {
    const sliders = [inputs.lower, inputs.middle, inputs.upper];
    const index = sliders.indexOf(editedInput);
    if (index < 0) return;
    const minimum = index === 0 ? 0 : Number(sliders[index - 1].value) + 1;
    const maximum = index === 2 ? 100 : Number(sliders[index + 1].value) - 1;
    const input = sliders[index];
    input.value = String(Math.max(minimum, Math.min(maximum, Number(input.value))));
}
