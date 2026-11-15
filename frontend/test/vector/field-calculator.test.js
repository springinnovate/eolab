import test from "node:test";
import assert from "node:assert/strict";
import {VectorFieldCalculator} from "../../src/vector/field-calculator.js";
import {calculateVectorFields} from "../../src/vector/api.js";
import {createFakeResizeObservers} from "../../test-support/raster/fakes.js";

/** DOM controls supporting the calculator's actual text editing and events. */
class Element extends EventTarget {
    /** Create a control with retained text, focus and event state.
     * @param {Object} document Focus owner. @param {string} tag HTML tag. */
    constructor(document, tag) {
        super();
        Object.assign(this, {document, tagName: tag, children: [], value: "", textContent: "", hidden: false,
            disabled: false, open: false, checked: false, selectionStart: 0, selectionEnd: 0, isConnected: true,
            style: {}, popoverOpen: false, bounds: {top: 80, bottom: 260, left: 160, right: 500, height: 180}});
        this.attributes = new Map();
        this.classes = new Set();
        this.classList = {toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name)};
    }
    /** Return this element's text and descendant text. @return {string} Visible text. */
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(""); }
    /** Replace descendant content with text. @param {string} value Text. */
    set textContent(value) { this.ownText = value; this.children = []; }
    /** Append child controls. @param {...Element} children New children. @return {void} */
    append(...children) { this.children.push(...children); }
    /** Replace child controls. @param {...Element} children Replacement children. @return {void} */
    replaceChildren(...children) { this.ownText = ""; this.children = children; }
    /** Retain an accessible attribute. @param {string} name Attribute name. @param {string} value Attribute value. @return {void} */
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    /** Read an accessible attribute. @param {string} name Attribute name. @return {string|null} Retained value. */
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    /** Check whether a control belongs to this subtree. @param {Element} element Control. @return {boolean} Membership. */
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    /** Activate an enabled action. @return {void} */
    click() { if (!this.disabled) this.dispatchEvent(new Event("click")); }
    /** Open the dialog. @return {void} */
    showModal() { this.open = true; }
    /** Place the picker above clipping containers. @return {void} */
    showPopover() { this.popoverOpen = true; }
    /** Remove the picker from the browser's overlay stack. @return {void} */
    hidePopover() { this.popoverOpen = false; }
    /** Return controlled browser layout geometry. @return {Object} Element bounds. */
    getBoundingClientRect() { return this.bounds; }
    /** Close the dialog and dispatch its browser event. @return {void} */
    close() { this.open = false; this.dispatchEvent(new Event("close")); }
    /** Focus an enabled control, as native form controls do. @return {void} */
    focus() { if (!this.disabled) this.document.activeElement = this; }
    /** Replace the selected text with the browser's end-selection behavior.
     * @param {string} text Inserted text. @param {number} start Selection start.
     * @param {number} end Selection end. @param {string} mode Browser selection mode.
     * @return {void}
     */
    setRangeText(text, start, end, mode) {
        assert.equal(mode, "end");
        this.value = this.value.slice(0, start) + text + this.value.slice(end);
        this.selectionStart = this.selectionEnd = start + text.length;
    }
}

const ORIGINAL_FIELDS = [
    {name: "Population total", type: "int"},
    {name: "Area km2", type: "float"},
    {name: "Owner's score", type: "str"},
];

/** Return accepted calculation metadata for the fixture's original fields.
 * @param {ReadonlyArray<import("../../src/calculated-fields.js").CalculatedField>} definitions Accepted formulas.
 * @return {import("../../src/vector/api.js").FieldCalculationResult} Complete result.
 */
function calculationResult(definitions) {
    return {calculatedFields: definitions,
        fields: Object.fromEntries([...ORIGINAL_FIELDS, ...definitions.map(field => ({name: field.name, type: "float"}))]
            .map(field => [field.name, field.type])),
        featureCount: 4, missingCounts: Object.fromEntries(definitions.map(field => [field.name, 1]))};
}

/** Create a calculator connected to two independently owned layer records.
 * @param {import("node:test").TestContext} t Test lifecycle for pending validation cleanup.
 * @param {Object} [options] Controlled transports.
 * @param {Function} [options.calculate] Calculation transport.
 * @param {Function} [options.validate] Advisory grammar validation.
 * @return {Object} Calculator, targets, observed transports and focus-tracking document.
 */
function calculatorFixture(t, {calculate = async (_source, definitions) => calculationResult(definitions),
    validate = async () => {}} = {}) {
    const {ResizeObserver, instances: resizeObservers} = createFakeResizeObservers();
    const document = {createElement: tag => new Element(document, tag), querySelector: () => null,
        defaultView: Object.assign(new EventTarget(), {innerWidth: 800, innerHeight: 600, ResizeObserver})};
    document.body = document.createElement("body");
    document.activeElement = document.createElement("button");
    const targets = new Map(["a", "b"].map(key => {
        const target = {identity: {}, label: "Layer " + key, source: {collectionId: "vectors", itemId: "parcels"},
            fields: structuredClone(ORIGINAL_FIELDS), calculatedFields: [], removalError: () => null,
            displayWarning: null, retryDisplay: async () => { target.displayWarning = null; return null; },
            apply: result => {
                target.calculatedFields = result.calculatedFields;
                target.fields = Object.entries(result.fields).map(([name, type]) => ({name, type}));
                return Promise.resolve(null);
            }};
        return [key, target];
    }));
    const calculations = [], validations = [];
    const calculator = new VectorFieldCalculator({document, getTarget: key => targets.get(key) ?? null,
        calculate: (...args) => { calculations.push(args); return calculate(...args); },
        validate: (...args) => { validations.push(args); return validate(...args); }});
    t.after(() => calculator.stopValidation());
    calculator.open("a");
    return {calculator, targets, document, calculations, validations, resizeObservers};
}

/** Type form values through their input events.
 * @param {VectorFieldCalculator} calculator Active form.
 * @param {string} name Output name. @param {string} expression Arithmetic text.
 * @param {boolean} [numericText=false] Whether numeric text is treated as numbers.
 * @return {void}
 */
function enterDraft(calculator, name, expression, numericText = false) {
    calculator.name.value = name;
    calculator.expression.value = expression;
    calculator.numericText.checked = numericText;
    calculator.expression.dispatchEvent(new Event("input"));
}

/** Install accepted generated fields before opening their editor.
 * @param {Object} target Composition target.
 * @param {string[]} names Ordered names with independent constant expressions.
 * @return {void}
 */
function installFields(target, names) {
    target.calculatedFields = names.map((name, index) => ({version: 1, name, expression: String(index + 1), numericText: false}));
    target.fields = [...structuredClone(ORIGINAL_FIELDS), ...names.map(name => ({name, type: "float64"}))];
}

test("Calculate explains blank and invalid inputs and waits for grammar validation", async t => {
    const {calculator: c, calculations, validations} = calculatorFixture(t, {
        validate: async (_fields, definitions) => {
            if (definitions.at(-1).expression === "bad") throw new Error("Expected a field or number at column 1.");
        },
    });
    assert.equal(c.name.placeholder, "Name the output field");
    assert.equal(c.submit.getAttribute("aria-disabled"), "true");
    assert.equal(c.reason.textContent, "Name the output field.");
    await c.submitCalculation();
    assert.equal(calculations.length, 0);
    enterDraft(c, "Density", " ");
    await c.validateDraft();
    assert.equal(c.reason.textContent, "Enter an expression.");
    assert.equal(validations.length, 0);
    enterDraft(c, "Density", "bad");
    assert.equal(c.reason.textContent, "Checking expression…");
    await c.submitCalculation();
    assert.equal(calculations.length, 0);
    await c.validateDraft();
    assert.match(c.reason.textContent, /column 1/);
    await c.submitCalculation();
    assert.equal(calculations.length, 0);
    enterDraft(c, "Density", "'Population total' / 'Area km2'");
    await c.validateDraft();
    assert.equal(c.submit.getAttribute("aria-disabled"), "false");
    assert.equal(c.reason.hidden, true);
    assert.deepEqual(validations.at(-1)[0], ORIGINAL_FIELDS);
});

test("searchable field insertion preserves selection, quoting and drafts across layers", t => {
    const {calculator: c, document} = calculatorFixture(t);
    enterDraft(c, "Density", "2 * replace / 10");
    c.expression.selectionStart = 4; c.expression.selectionEnd = 11;
    c.insert.click();
    assert.equal(c.picker.hidden, false);
    assert.equal(c.picker.popoverOpen, true);
    assert.equal(document.activeElement, c.search);
    c.search.value = "OWNER";
    c.search.dispatchEvent(new Event("input"));
    assert.equal(c.optionButtons.length, 1);
    assert.equal(c.optionButtons[0].children[0].textContent, "'Owner''s score'");
    assert.equal(c.optionButtons[0].children[1].textContent, "text");
    c.optionButtons[0].click();
    assert.equal(c.expression.value, "2 * 'Owner''s score' / 10");
    assert.equal(c.expression.selectionStart, 20);
    assert.equal(c.picker.hidden, true);
    assert.equal(c.picker.popoverOpen, false);
    assert.equal(document.activeElement, c.expression);
    c.numericText.checked = true;
    c.numericText.dispatchEvent(new Event("input"));
    c.refresh();
    c.dialog.close();
    c.open("b");
    assert.equal(c.expression.value, "");
    c.open("a");
    assert.equal(c.name.value, "Density");
    assert.equal(c.numericText.checked, true);
    assert.equal(c.expression.value, "2 * 'Owner''s score' / 10");
    c.insert.click();
    c.search.value = "not present"; c.search.dispatchEvent(new Event("input"));
    assert.equal(c.optionButtons.length, 0);
    assert.equal(c.options.textContent, "No matching fields.");
});

test("the picker stays within the viewport and closes with its dialog or a scrolled-away anchor", t => {
    const {calculator: c, document} = calculatorFixture(t);
    c.dialog.bounds = {top: 10, bottom: 590};
    c.insert.bounds = {top: 400, bottom: 424, right: 500};
    c.insert.click();
    assert.equal(c.picker.getAttribute("popover"), "manual");
    assert.equal(c.picker.style.top, "216px", "short space below uses the space above");
    assert.equal(c.picker.style.left, "160px");
    document.defaultView.innerWidth = 320;
    c.insert.bounds = {top: 100, bottom: 124, right: 300};
    document.defaultView.dispatchEvent(new Event("resize"));
    assert.equal(c.picker.style.width, "304px");
    assert.equal(c.picker.style.left, "8px");
    assert.equal(c.picker.style.top, "128px");
    c.dialog.close();
    assert.equal(c.picker.popoverOpen, false);
    c.open("a"); c.insert.click();
    c.insert.bounds = {top: -40, bottom: -16, right: 300};
    c.dialog.dispatchEvent(new Event("scroll"));
    assert.equal(c.picker.popoverOpen, false);
    assert.equal(c.insert.getAttribute("aria-expanded"), "false");
});

test("the open picker follows the dialog's final layout after a viewport resize", t => {
    const {calculator: c, document, resizeObservers} = calculatorFixture(t);
    c.dialog.bounds = {top: 70, bottom: 410};
    c.insert.bounds = {top: 230, bottom: 254, right: 286};
    c.insert.click();
    document.defaultView.innerWidth = 1280;
    document.defaultView.innerHeight = 800;
    document.defaultView.dispatchEvent(new Event("resize"));
    c.dialog.bounds = {top: 280, bottom: 510};
    c.insert.bounds = {top: 364, bottom: 388, right: 1000};
    assert.equal(resizeObservers[0].target, c.dialog);
    resizeObservers[0].resize(760);
    assert.equal(c.picker.style.left, "660px");
    assert.equal(c.picker.style.top, "392px");
    assert.equal(c.picker.popoverOpen, true);
    assert.equal(document.activeElement, c.search, "reflow preserves typing focus");
    c.dialog.close();
    resizeObservers[0].resize(760);
    assert.equal(c.picker.popoverOpen, false, "a later layout notification does not reopen the picker");
});

test("tabbing out of field choices uncovers the focused editor without changing its text", t => {
    const {calculator: c} = calculatorFixture(t);
    enterDraft(c, "Density", "'Population total' / 10");
    c.insert.click();
    for (const target of [c.search, c.optionButtons[0], c.insert, c.expression]) {
        const event = new Event("focusin");
        Object.defineProperty(event, "target", {value: target});
        c.dialog.dispatchEvent(event);
        assert.equal(c.picker.popoverOpen, target !== c.expression);
    }
    assert.equal(c.expression.value, "'Population total' / 10");
    assert.equal(c.insert.getAttribute("aria-expanded"), "false");
});

test("Escape from Insert field dismisses its choices before the dialog", t => {
    const {calculator: c, document} = calculatorFixture(t);
    c.insert.click();
    c.insert.focus();
    const escape = new Event("keydown", {cancelable: true});
    Object.defineProperty(escape, "key", {value: "Escape"});
    c.dialog.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(c.picker.popoverOpen, false);
    assert.equal(c.dialog.open, true);
    assert.equal(document.activeElement, c.insert);
    const secondEscape = new Event("keydown", {cancelable: true});
    Object.defineProperty(secondEscape, "key", {value: "Escape"});
    c.dialog.dispatchEvent(secondEscape);
    assert.equal(secondEscape.defaultPrevented, false);
});

test("Calculate retries failed advisory validation without requiring an input change", async t => {
    let attempts = 0, finishRetry;
    const {calculator: c, calculations} = calculatorFixture(t, {
        validate: async () => {
            if (++attempts === 1) throw new TypeError("Failed to fetch");
            await new Promise(resolve => { finishRetry = resolve; });
        },
    });
    enterDraft(c, "Density", "'Population total' / 10");
    await c.validateDraft();
    assert.equal(c.submit.getAttribute("aria-disabled"), "true");
    assert.equal(c.reason.textContent, "Failed to fetch");
    c.submit.click();
    assert.equal(attempts, 2);
    assert.equal(c.reason.textContent, "Checking expression…");
    finishRetry();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(c.submit.getAttribute("aria-disabled"), "false");
    assert.equal(c.reason.hidden, true);
    assert.equal(c.name.value, "Density");
    assert.equal(c.expression.value, "'Population total' / 10");
    assert.equal(calculations.length, 0, "recovery validates before offering the calculation");
});

test("saving clears the new-field form and exposes grouped edit actions for the saved result", async t => {
    const {calculator: c, targets} = calculatorFixture(t);
    const expression = "'Population total' / 'Area km2'";
    enterDraft(c, "Density", expression);
    await c.validateDraft();
    await c.submitCalculation();
    assert.deepEqual(targets.get("a").calculatedFields, [{version: 1, name: "Density", expression, numericText: false}]);
    assert.deepEqual(targets.get("b").calculatedFields, []);
    assert.match(c.status.textContent, /4 features\. 1 empty value\./);
    assert.equal(c.name.value, "");
    assert.equal(c.expression.value, "");
    assert.equal(c.fields.open, true);
    assert.equal(c.summary.textContent, "1 existing user-generated field");
    const row = c.fieldList.children[0];
    assert.equal(row.getAttribute("aria-label"), "Density");
    assert.equal(row.children[1].textContent, "= " + expression);
    c.fieldActions[0].click();
    assert.equal(c.name.value, "Density");
    assert.equal(c.expression.value, expression);
    assert.equal(c.submit.textContent, "Recalculate");
    assert.equal(c.cancelEdit.hidden, false);
    enterDraft(c, "Density", expression + " * 1000");
    await c.validateDraft();
    await c.submitCalculation();
    assert.equal(targets.get("a").calculatedFields.length, 1);
    assert.equal(targets.get("a").calculatedFields[0].expression, expression + " * 1000");
    assert.equal(c.name.value, "");
});

test("editing and cancelling retain the new draft and offer only original and earlier fields", async t => {
    const {calculator: c, targets, validations} = calculatorFixture(t);
    installFields(targets.get("a"), ["First", "Second", "Third"]);
    c.open("a");
    enterDraft(c, "Unfinished", "'Population total' * 3", true);
    c.fieldActions[2].click();
    assert.equal(c.editing, "Second");
    assert.equal(c.expression.value, "2");
    c.insert.click();
    assert.deepEqual(c.optionButtons.map(button => button.children[0].textContent),
        ["'Population total'", "'Area km2'", "'Owner''s score'", "'First'"]);
    assert.equal(c.optionButtons[0].children[1].textContent, "number");
    await c.validateDraft();
    assert.deepEqual(validations.at(-1)[0], ORIGINAL_FIELDS);
    c.dialog.close();
    c.open("a");
    assert.equal(c.editing, "Second");
    assert.equal(c.expression.value, "2");
    c.cancelEdit.click();
    assert.equal(c.editing, "");
    assert.equal(c.name.value, "Unfinished");
    assert.equal(c.expression.value, "'Population total' * 3");
    assert.equal(c.numericText.checked, true);
    assert.equal(c.cancelEdit.hidden, true);
});

test("stale validation replies cannot reenable Calculate after the expression changes", async t => {
    const pending = [];
    const {calculator: c, calculations} = calculatorFixture(t, {
        validate: (_fields, _definitions, signal) => new Promise((resolve, reject) => pending.push({signal, resolve, reject})),
    });
    enterDraft(c, "Density", "1");
    const first = c.validateDraft();
    enterDraft(c, "Density", "1 +");
    assert.equal(pending[0].signal.aborted, true);
    const second = c.validateDraft();
    pending[1].reject(new Error("Expected a field or number at column 4."));
    await second;
    pending[0].resolve();
    await first;
    assert.equal(c.submit.getAttribute("aria-disabled"), "true");
    assert.match(c.reason.textContent, /column 4/);
    assert.equal(calculations.length, 0);
});

test("failed and cancelled calculations preserve entered text and never install late results", async t => {
    let finish;
    const {calculator: c, targets} = calculatorFixture(t, {
        calculate: async (_source, definitions) => {
            if (definitions[0].expression === "1") throw new Error("The source is unavailable.");
            return new Promise(resolve => { finish = () => resolve(calculationResult(definitions)); });
        },
    });
    enterDraft(c, "new", "1");
    await c.validateDraft();
    await c.submitCalculation();
    assert.match(c.status.textContent, /source is unavailable/);
    assert.equal(c.expression.value, "1");
    enterDraft(c, "new", "2 * 3");
    await c.validateDraft();
    const pending = c.submitCalculation();
    assert.equal(c.cancel.hidden, false);
    assert.equal(c.name.disabled, true);
    assert.equal(c.submit.getAttribute("aria-disabled"), "true");
    c.cancel.click();
    finish(); await pending;
    assert.deepEqual(targets.get("a").calculatedFields, []);
    assert.equal(c.expression.value, "2 * 3");
    assert.match(c.status.textContent, /cancelled/);
    assert.equal(c.name.disabled, false);
    await c.validateDraft();
    assert.equal(c.submit.getAttribute("aria-disabled"), "false");
});

test("closing during map refresh retains the saved result in the generated-field list", async t => {
    const {calculator: c, targets} = calculatorFixture(t);
    const target = targets.get("a");
    const install = target.apply;
    let finishRefresh, installed;
    const committed = new Promise(resolve => { installed = resolve; });
    target.apply = result => {
        void install(result);
        installed();
        return new Promise(resolve => { finishRefresh = resolve; });
    };
    enterDraft(c, "Density", "'Population total' / 'Area km2'");
    await c.validateDraft();
    const pending = c.submitCalculation();
    await committed;
    c.dialog.close();
    assert.match(c.status.textContent, /Field saved/);
    c.open("a");
    assert.equal(c.name.value, "");
    assert.equal(c.summary.textContent, "1 existing user-generated field");
    c.fieldActions[0].click();
    assert.equal(c.name.value, "Density");
    finishRefresh(null); await pending;
    target.apply = install;
    enterDraft(c, "Density", "'Population total' * 2");
    await c.validateDraft();
    await c.submitCalculation();
    assert.equal(target.calculatedFields.length, 1);
    assert.equal(target.calculatedFields[0].expression, "'Population total' * 2");
});

test("removed or replaced targets cannot receive late calculations", async t => {
    for (const removed of [true, false]) {
        await t.test(removed ? "removed" : "replaced", async subtest => {
            let finish;
            const {calculator: c, targets} = calculatorFixture(subtest, {
                calculate: (_source, definitions) => new Promise(resolve => { finish = () => resolve(calculationResult(definitions)); }),
            });
            const target = targets.get("a");
            enterDraft(c, "new", "2");
            await c.validateDraft();
            const pending = c.submitCalculation();
            if (removed) {
                targets.delete("a");
                c.refresh();
            } else targets.set("a", {...target, identity: {}});
            finish(); await pending;
            assert.deepEqual(target.calculatedFields, []);
            assert.match(c.status.textContent, /removed/);
            if (removed) assert.equal(c.submit.getAttribute("aria-disabled"), "true");
        });
    }
});

test("deletion and Undo preserve definition order and unrelated unfinished input", async t => {
    const {calculator: c, targets, document} = calculatorFixture(t);
    const target = targets.get("a");
    installFields(target, ["First", "Second", "Third"]);
    c.open("a");
    const accepted = structuredClone(target.calculatedFields);
    enterDraft(c, "Unfinished", "12");
    c.fieldActions[3].focus();
    await c.deleteField(target.calculatedFields[1]);
    assert.deepEqual(target.calculatedFields.map(field => field.name), ["First", "Third"]);
    assert.equal(c.summary.textContent, "2 existing user-generated fields");
    assert.equal(c.deletedRow.hidden, false);
    assert.equal(c.deletedLabel.textContent, "Second deleted.");
    assert.equal(c.undo.disabled, false);
    assert.equal(document.activeElement, c.undo, "keyboard focus reaches Undo after it is reenabled");
    assert.equal(c.name.value, "Unfinished");
    assert.equal(c.expression.value, "12");
    await c.undoDeletion();
    assert.deepEqual(target.calculatedFields, accepted);
    assert.equal(c.deletedRow.hidden, true);
    assert.match(c.status.textContent, /Second restored/);
    assert.equal(c.expression.value, "12");
});

test("retained usage blocks deletion and renaming before calculation", async t => {
    const {calculator: c, targets, calculations, validations} = calculatorFixture(t);
    const target = targets.get("a");
    installFields(target, ["Density"]);
    target.removalError = name => name === "Density" ? "Remove “Density” from this layer's filter rules before deleting it." : null;
    c.open("a");
    await c.deleteField(target.calculatedFields[0]);
    assert.match(c.status.textContent, /filter rules/);
    assert.equal(calculations.length, 0);
    c.fieldActions[0].click();
    enterDraft(c, "Renamed", "2");
    await c.validateDraft();
    assert.match(c.reason.textContent, /filter rules/);
    assert.equal(validations.length, 0);
    await c.submitCalculation();
    assert.equal(calculations.length, 0);
    assert.equal(target.calculatedFields[0].name, "Density");
});

test("a failed map refresh after deleting the last field leaves Undo and Retry available", async t => {
    const {calculator: c, targets, calculations} = calculatorFixture(t);
    const target = targets.get("a");
    installFields(target, ["Density"]);
    const install = target.apply;
    const warning = "Fields saved. The map could not refresh. Use Retry map refresh.";
    target.apply = result => {
        void install(result);
        target.displayWarning = warning;
        return Promise.resolve(warning);
    };
    let retried = 0;
    target.retryDisplay = async () => {
        retried++;
        assert.deepEqual(target.calculatedFields, []);
        target.displayWarning = null;
        return null;
    };
    c.open("a");
    enterDraft(c, "Unfinished", "'Population total' / 1000", true);
    await c.deleteField(target.calculatedFields[0]);
    assert.deepEqual(target.calculatedFields, []);
    assert.equal(c.deletedRow.hidden, false);
    assert.equal(c.undo.disabled, false);
    assert.equal(c.retry.hidden, false);
    assert.match(c.status.textContent, /Density deleted.*map could not refresh/);
    await c.retryMapRefresh();
    assert.equal(retried, 1);
    assert.equal(calculations.length, 1, "retry uses accepted fields without calculating again");
    assert.equal(c.retry.hidden, true);
    assert.equal(c.status.textContent, "Map refreshed.");
    assert.equal(c.deletedRow.hidden, false, "retry retains Undo for the deleted field");
    assert.equal(c.name.value, "Unfinished");
    assert.equal(c.expression.value, "'Population total' / 1000");
    assert.equal(c.numericText.checked, true);
    target.apply = install;
    await c.undoDeletion();
    assert.equal(target.calculatedFields[0].name, "Density");
});

test("reopening a failed display offers Retry independently of an unfinished expression", async t => {
    const {calculator: c, targets, calculations} = calculatorFixture(t);
    const target = targets.get("a");
    const warning = "Fields saved. The map could not refresh. Use Retry map refresh.";
    enterDraft(c, "Unfinished", "1 +");
    c.dialog.close();
    target.displayWarning = warning;
    c.open("a");
    assert.equal(c.retry.hidden, false);
    assert.equal(c.status.textContent, warning);
    target.retryDisplay = async () => warning;
    await c.retryMapRefresh();
    assert.equal(c.retry.hidden, false, "another display failure keeps the retry action");
    assert.equal(c.status.textContent, warning);
    assert.equal(c.name.value, "Unfinished");
    assert.equal(c.expression.value, "1 +");
    assert.equal(calculations.length, 0);
});

test("cancelled map retries cannot overwrite a later successful retry", async t => {
    const {calculator: c, targets, calculations} = calculatorFixture(t);
    const target = targets.get("a"), retries = [];
    target.displayWarning = "The map could not refresh.";
    target.retryDisplay = signal => new Promise(resolve => retries.push({signal, resolve}));
    c.open("a");
    enterDraft(c, "Unfinished", "12");
    const first = c.retryMapRefresh();
    assert.equal(c.retry.disabled, true);
    c.cancel.click();
    assert.equal(retries[0].signal.aborted, true);
    assert.equal(c.retry.hidden, false);
    const second = c.retryMapRefresh();
    retries[1].resolve(null); await second;
    assert.equal(c.status.textContent, "Map refreshed.");
    assert.equal(c.retry.hidden, true);
    retries[0].resolve("Old refresh failed."); await first;
    assert.equal(c.status.textContent, "Map refreshed.");
    assert.equal(c.retry.hidden, true);
    assert.equal(c.name.value, "Unfinished");
    assert.equal(c.expression.value, "12");
    assert.equal(calculations.length, 0);
});

test("a late display failure after reopening exposes Retry without replacing the draft", async t => {
    const {calculator: c, targets} = calculatorFixture(t);
    const target = targets.get("a"), install = target.apply;
    let completeRefresh, installed;
    const committed = new Promise(resolve => { installed = resolve; });
    target.apply = result => {
        void install(result);
        installed();
        return new Promise(resolve => { completeRefresh = resolve; });
    };
    enterDraft(c, "Density", "2");
    await c.validateDraft();
    const pending = c.submitCalculation();
    await committed;
    c.dialog.close();
    c.open("a");
    assert.equal(c.retry.hidden, true);
    enterDraft(c, "Unfinished", "3");
    target.displayWarning = "Fields saved. The map could not refresh. Use Retry map refresh.";
    completeRefresh(target.displayWarning); await pending;
    c.refresh();
    assert.equal(c.retry.hidden, false);
    assert.equal(c.name.value, "Unfinished");
    assert.equal(c.expression.value, "3");
});

test("a rejected installation preserves the unsaved form and accepted fields", async t => {
    const {calculator: c, targets} = calculatorFixture(t);
    targets.get("a").apply = () => { throw new Error("The layer's filter now uses this field."); };
    enterDraft(c, "Density", "2");
    await c.validateDraft();
    await c.submitCalculation();
    assert.equal(c.name.value, "Density");
    assert.equal(c.expression.value, "2");
    assert.deepEqual(targets.get("a").calculatedFields, []);
    assert.match(c.status.textContent, /filter now uses/);
});

test("calculator transport sends only authorized identity and definitions and rejects inconsistent results", async () => {
    const definitions = [{version: 1, name: "Density", expression: "'Population total' / 10", numericText: false}];
    const source = {kind: "runArtifact", jobId: "a".repeat(32), artifactId: "b".repeat(32), label: "Private result", calculatedFields: []};
    let request;
    const response = {calculatedFields: definitions, fields: {"Population total": "int", Density: "float"}, featureCount: 4, missingCounts: {Density: 0}};
    const result = await calculateVectorFields(source, definitions, new AbortController().signal, async (url, options) => {
        request = {url, options}; return new Response(JSON.stringify(response));
    });
    assert.equal(request.url, "/api/vector-calculations");
    assert.deepEqual(JSON.parse(request.options.body), {source: {kind: source.kind, jobId: source.jobId, artifactId: source.artifactId}, calculatedFields: definitions});
    assert.equal(request.options.credentials, "same-origin");
    assert.equal(request.options.headers["X-EOLab-Processing"], "1");
    assert.equal(result.featureCount, 4);
    await assert.rejects(calculateVectorFields(source, definitions, undefined, async () =>
        new Response(JSON.stringify({...response, missingCounts: {Density: 5}}))), /invalid field calculation/);
    await assert.rejects(calculateVectorFields(source, definitions, undefined, async () =>
        new Response('\n\n' + JSON.stringify({detail: "Unknown field 'missing'."}))), /Unknown field 'missing'/);
    const streamed = await calculateVectorFields(source, definitions, undefined, async () =>
        new Response('\n\n' + JSON.stringify(response)));
    assert.equal(streamed.featureCount, 4);
});
