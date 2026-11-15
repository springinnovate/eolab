import test from "node:test";
import assert from "node:assert/strict";
import {VectorFieldCalculator} from "../../src/vector/field-calculator.js";
import {calculateVectorFields} from "../../src/vector/api.js";

/** DOM controls supporting the calculator's actual text editing and events. */
class Element extends EventTarget {
    /** Create a control with retained text, focus and event state.
     * @param {Object} document Focus owner. @param {string} tag HTML tag. */
    constructor(document, tag) {
        super();
        Object.assign(this, {document, tagName: tag, children: [], value: "", textContent: "", hidden: false,
            disabled: false, open: false, checked: false, selectionStart: 0, selectionEnd: 0, isConnected: true});
        this.attributes = new Map();
        this.classes = new Set();
        this.classList = {toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name)};
    }
    /** Append child controls. @param {...Element} children New children. @return {void} */
    append(...children) { this.children.push(...children); }
    /** Replace child controls. @param {...Element} children Replacement children. @return {void} */
    replaceChildren(...children) { this.children = children; }
    /** Retain an accessible attribute. @param {string} name Attribute name. @param {string} value Attribute value. @return {void} */
    setAttribute(name, value) { this.attributes.set(name, value); }
    /** Open the dialog. @return {void} */
    showModal() { this.open = true; }
    /** Close the dialog and dispatch its browser event. @return {void} */
    close() { this.open = false; this.dispatchEvent(new Event("close")); }
    /** Move the document focus to this control. @return {void} */
    focus() { this.document.activeElement = this; }
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

/** Create an actual calculator connected to two independently owned layer records.
 * @param {Function} [calculate] Controlled transport.
 * @return {Object} Dialog, targets and focus-tracking document.
 */
function calculatorFixture(calculate = async (_source, definitions) => ({calculatedFields: definitions,
    fields: {"Population total": "int", "Area km2": "float", [definitions.at(-1).name]: "float"}, featureCount: 4,
    missingCounts: Object.fromEntries(definitions.map(field => [field.name, 1]))})) {
    const document = {createElement: tag => new Element(document, tag), querySelector: () => null};
    document.body = document.createElement("body");
    document.activeElement = document.createElement("button");
    const targets = new Map(["a", "b"].map(key => {
        const target = {identity: {}, label: `Layer ${key}`, source: {collectionId: "vectors", itemId: "parcels"},
            fields: [{name: "Population total", type: "int"}, {name: "Area km2", type: "float"}, {name: "Owner's score", type: "str"}],
            calculatedFields: [], apply: async result => { target.calculatedFields = result.calculatedFields;
                target.fields = Object.entries(result.fields).map(([name, type]) => ({name, type})); }};
        return [key, target];
    }));
    const calculator = new VectorFieldCalculator({document, getTarget: key => targets.get(key) ?? null, calculate});
    calculator.open("a");
    return {calculator, targets, document};
}

test("field insertion handles punctuation at the caret and preserves editable drafts across refresh and reopening", () => {
    const {calculator: c, document} = calculatorFixture();
    c.name.value = "Density";
    c.expression.value = "2 * replace / 10";
    c.expression.selectionStart = 4; c.expression.selectionEnd = 11;
    c.picker.value = "Owner's score";
    c.picker.dispatchEvent(new Event("change"));
    assert.equal(c.expression.value, "2 * 'Owner''s score' / 10");
    assert.equal(c.expression.selectionStart, 20);
    assert.equal(document.activeElement, c.expression);
    c.numericText.checked = true;
    c.numericText.dispatchEvent(new Event("input"));
    c.refresh();
    assert.equal(c.expression.value, "2 * 'Owner''s score' / 10");
    c.dialog.close();
    c.open("b");
    assert.equal(c.expression.value, "");
    c.open("a");
    assert.equal(c.name.value, "Density");
    assert.equal(c.numericText.checked, true);
    assert.equal(c.expression.value, "2 * 'Owner''s score' / 10");
});

test("calculation installs one view's fields and allows revising its expression without changing the source name", async () => {
    const {calculator: c, targets} = calculatorFixture();
    c.name.value = "Density"; c.expression.value = "'Population total' / 'Area km2'";
    await c.submitCalculation();
    assert.deepEqual(targets.get("a").calculatedFields, [{version: 1, name: "Density", expression: c.expression.value, numericText: false}]);
    assert.deepEqual(targets.get("b").calculatedFields, []);
    assert.match(c.status.textContent, /4 features.*1 empty/);
    assert.equal(c.name.readOnly, true);
    c.expression.value = "'Population total' / 'Area km2' * 1000";
    await c.submitCalculation();
    assert.equal(targets.get("a").calculatedFields.length, 1);
    assert.equal(targets.get("a").calculatedFields[0].expression, c.expression.value);
    c.field.value = ""; c.field.dispatchEvent(new Event("change"));
    assert.equal(c.name.readOnly, false);
    assert.equal(c.name.value, "");
});

test("failed and cancelled calculations preserve entered text and never install late results", async () => {
    let finish;
    const {calculator: c, targets} = calculatorFixture(async (_source, definitions, signal) => {
        if (definitions[0].expression === "bad") throw new Error("Expected a field or number at column 1.");
        return await new Promise(resolve => { finish = () => resolve({calculatedFields: definitions, fields: {new: "float"}, featureCount: 1, missingCounts: {new: 0}}); });
    });
    c.name.value = "new"; c.expression.value = "bad";
    await c.submitCalculation();
    assert.match(c.status.textContent, /column 1/);
    assert.equal(c.expression.value, "bad");
    c.expression.value = "2 * 3";
    const pending = c.submitCalculation();
    assert.equal(c.cancel.hidden, false);
    c.cancel.dispatchEvent(new Event("click"));
    finish(); await pending;
    assert.deepEqual(targets.get("a").calculatedFields, []);
    assert.equal(c.expression.value, "2 * 3");
    assert.match(c.status.textContent, /cancelled/);
    assert.equal(c.submit.disabled, false);
});

test("closing during map refresh reopens the saved field for editing", async () => {
    const {calculator: c, targets} = calculatorFixture();
    const target = targets.get("a");
    const install = target.apply;
    let finishRefresh;
    let installed;
    const committed = new Promise(resolve => { installed = resolve; });
    target.apply = result => {
        void install(result);
        installed();
        return new Promise(resolve => { finishRefresh = resolve; });
    };
    c.name.value = "Density"; c.expression.value = "'Population total' / 'Area km2'";
    const pending = c.submitCalculation();
    await committed;
    c.dialog.close();
    assert.match(c.status.textContent, /Field saved/);
    c.open("a");
    assert.equal(c.field.value, "Density");
    assert.equal(c.name.readOnly, true);
    finishRefresh(null);
    await pending;
    target.apply = install;
    c.expression.value = "'Population total' * 2";
    await c.submitCalculation();
    assert.equal(target.calculatedFields.length, 1);
    assert.equal(target.calculatedFields[0].expression, c.expression.value);
});

test("editing offers only original and earlier calculated fields, including after reopening", () => {
    const {calculator: c, targets} = calculatorFixture();
    const target = targets.get("a");
    target.calculatedFields = ["First", "Second", "Third"].map((name, index) => ({version: 1, name, expression: String(index + 1), numericText: false}));
    target.fields.push(...target.calculatedFields.map(field => ({name: field.name, type: "float64"})));
    c.open("a");
    c.field.value = "Second";
    c.field.dispatchEvent(new Event("change"));
    assert.deepEqual(c.picker.children.map(option => option.value), ["", "Population total", "Area km2", "Owner's score", "First"]);
    c.dialog.close();
    c.open("a");
    assert.equal(c.field.value, "Second");
    assert.equal(c.expression.value, "2");
    assert.equal(c.picker.children.some(option => option.value === "Second" || option.value === "Third"), false);
});

test("a removed target cannot receive a calculation completed after removal", async () => {
    let finish;
    const {calculator: c, targets} = calculatorFixture(async (_source, definitions) => await new Promise(resolve => {
        finish = () => resolve({calculatedFields: definitions, fields: {new: "float"}, featureCount: 1, missingCounts: {new: 0}});
    }));
    const target = targets.get("a");
    c.name.value = "new"; c.expression.value = "2";
    const pending = c.submitCalculation();
    targets.delete("a");
    c.refresh(); finish(); await pending;
    assert.deepEqual(target.calculatedFields, []);
    assert.equal(c.submit.disabled, true);
    assert.match(c.status.textContent, /removed/);
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
