import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {FakeRasterControlDocument} from "../../test-support/raster/fake-controls-document.js";
import {TemporalScrubber} from "../../src/raster/temporal-scrubber.js";

const stamps = ["2000-01-02T01:00:00.000Z", "2000-01-02T02:00:00.000Z", "2000-01-05T01:00:00.000Z"];
const months = ["2000-01", "2000-05"];

/** Mount the actual timeline control names around a representative irregular, partial month.
 * @param {Object} [actions] Optional callback replacements for playback.
 * @return {Object} Real widget, DOM controls, source snapshot and captured actions.
 */
function fixture(actions = {}) {
    const doc = new FakeRasterControlDocument();
    doc.defaultView.ResizeObserver = class { observe() {} disconnect() {} };
    const root = doc.createElement("section"), controls = {};
    const markup = readFileSync(new URL("../../index.html", import.meta.url), "utf8").split('id="temporal-scrubber"')[1].split("</section>")[0];
    for (const [, tag, name] of markup.matchAll(/<(select|button|input|output|span|p)\b[^>]*data-timeline="([^"]+)"/g)) {
        const node = doc.createElement(tag);
        node.dataset.timeline = name;
        if (tag === "select") Object.defineProperty(node, "options", {get: () => node.children});
        root.append(node);
        controls[name] = node;
    }
    const marks = doc.createElement("datalist");
    root.querySelectorAll = () => Object.values(controls);
    root.querySelector = () => marks;
    const calls = [];
    const widget = new TemporalScrubber(root, {
        selectTime: async (...args) => { calls.push(args); },
        selectMonth: async (...args) => { calls.push(args); },
        prepare: async () => null, ...actions,
    });
    const layer = {key: "rain", visible: true, opacity: 1, timeline: {
        name: "Weather", variable: "rain", variableLabel: "Rain", month: months[0], months,
        times: stamps, time: stamps[0], loading: false, error: null, layerName: "first",
    }};
    widget.setLayers([layer]);
    return {root, controls, widget, layer, calls};
}

test("the slider snaps across real gaps, commits the final drag and follows layer and row changes", context => {
    context.mock.timers.enable({apis: ["setTimeout"]});
    const {widget, root, controls, layer, calls} = fixture();
    try {
        assert.equal(controls.display.textContent, "");
        widget.setMapStatus({phase: "complete"}, new Map([["rain", {variable: "rain", time: stamps[0]}]]));
        assert.equal(controls.status.hidden, false, "the loading status keeps its place between frames");
        assert.equal(controls.status.textContent, "");
        assert.equal(controls.display.textContent, "On map · 2000-01-02 01:00 UTC");
        controls.time.valueAsNumber = Date.parse(stamps[1]);
        controls.time.dispatchEvent(new Event("input"));
        controls.time.valueAsNumber = Date.parse("2000-01-04T20:30:00Z");
        controls.time.dispatchEvent(new Event("input"));
        assert.equal(controls.time.getAttribute("aria-valuetext"), "2000-01-05 01:00 UTC");
        assert.equal(controls.status.textContent, "Loading raster…");
        assert.equal(controls.display.textContent, "On map · 2000-01-02 01:00 UTC");
        controls.time.dispatchEvent(new Event("change"));
        context.mock.timers.tick(100);
        assert.deepEqual(calls, [["rain", stamps[2]]]);
        const changed = {...layer, timeline: {...layer.timeline, time: stamps[2], layerName: "third"}};
        widget.setMapStatus({phase: "loading"}, new Map([["rain", {variable: "rain", time: stamps[0]}], ["reference", {variable: "rain", time: stamps[2]}]]));
        widget.setLayers([changed]);
        assert.equal(controls.display.textContent, "On map · 2000-01-02 01:00 UTC", "identify the frame still visible");
        widget.setLayers([changed, {...changed, key: "reference"}]);
        for (const key of ["reference", "rain"]) {
            controls.layer.value = key;
            controls.layer.dispatchEvent(new Event("change"));
        }
        assert.equal(controls.display.textContent, "On map · 2000-01-02 01:00 UTC", "returning to a pending view restores its drawn time");
        widget.setMapStatus({phase: "loading"}, new Map());
        assert.equal(controls.display.textContent, "", "old tiles cannot confirm a different date");
        widget.setMapStatus({phase: "complete"}, new Map([["rain", {variable: "rain", time: stamps[2]}]]));
        assert.match(controls.display.textContent, /01-05 01:00/);
        assert.match(controls.gap.textContent, /2000-05/);
        controls.forward.dispatchEvent(new Event("click"));
        assert.deepEqual(calls.at(-1), ["rain", months[1], "first"]);
        const other = {...layer, key: "wind", timeline: {...layer.timeline, name: "Wind"}};
        widget.setLayers([other, changed]);
        assert.equal(controls.layer.value, "rain");
        controls.layer.value = "wind";
        controls.layer.dispatchEvent(new Event("change"));
        controls.stride.value = "day";
        controls.stride.dispatchEvent(new Event("change"));
        controls.time.dispatchEvent(Object.assign(new Event("keydown"), {key: "ArrowRight"}));
        assert.deepEqual(calls.at(-1), ["wind", stamps[2]]);
        assert.match(controls.gap.textContent, /3 days later/);
        widget.setLayers([{...other, visible: false}]);
        assert.equal(root.hidden, true);
    } finally { widget.destroy(); }
});

test("Play waits for actual tile completion, buffers at most two and cancels prepared work on Pause", async context => {
    context.mock.timers.enable({apis: ["setTimeout"]});
    const prepared = [], shown = [];
    const {widget, controls, layer} = fixture({prepare: async (_key, time, signal) => {
        prepared.push({time, signal});
        return () => {
            shown.push(time);
            widget.setLayers([{...layer, timeline: {...layer.timeline, time, layerName: time}}]);
        };
    }});
    try {
        widget.setMapStatus({phase: "complete"}, new Map([["rain", {variable: "rain", time: stamps[0]}]]));
        widget.setMapStatus({phase: "loading"}, new Map([["rain", {variable: "rain", time: stamps[0], outsideViewport: true}]]));
        assert.equal(controls.status.textContent, "", "an empty viewport has no pending raster");
        assert.equal(controls.display.textContent, "");
        assert.equal(controls.play.disabled, false, "a user can play through an observation outside the viewport");
        controls.play.dispatchEvent(new Event("click"));
        assert.deepEqual(prepared.map(frame => frame.time), stamps.slice(1));
        context.mock.timers.tick(167);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(shown, [stamps[1]]);
        context.mock.timers.tick(1000);
        assert.deepEqual(shown, [stamps[1]], "publication alone cannot advance playback");
        assert.equal(controls.status.textContent, "Loading raster…");
        widget.setMapStatus({phase: "complete"}, new Map([["rain", {variable: "rain", time: stamps[1]}]]));
        assert.equal(controls.status.textContent, "");
        controls.play.dispatchEvent(new Event("click"));
        context.mock.timers.tick(1000);
        assert.deepEqual(shown, [stamps[1]]);
        assert.ok(prepared.every(frame => frame.signal.aborted));
        assert.equal(controls.play.textContent, "Play");
    } finally { widget.destroy(); }
});

test("a held drag previews before release and coalesces motion while the first map is drawing", context => {
    context.mock.timers.enable({apis: ["setTimeout"]});
    const {widget, controls, layer, calls} = fixture();
    try {
        widget.setMapStatus({phase: "complete"}, new Map([["rain", {variable: "rain", time: stamps[0]}]]));
        controls.time.valueAsNumber = Date.parse(stamps[1]);
        controls.time.dispatchEvent(new Event("input"));
        context.mock.timers.tick(40);
        controls.time.valueAsNumber = Date.parse(stamps[2]);
        controls.time.dispatchEvent(new Event("input"));
        context.mock.timers.tick(30);
        assert.deepEqual(calls, [["rain", stamps[2]]], "continuous dragging shows the latest preview before pointer release");
        widget.setLayers([{...layer, timeline: {...layer.timeline, time: stamps[2], layerName: "third"}}]);
        controls.time.valueAsNumber = Date.parse(stamps[1]);
        controls.time.dispatchEvent(new Event("input"));
        context.mock.timers.tick(500);
        assert.equal(calls.length, 1, "one intermediate frame at a time");
        widget.setMapStatus({phase: "complete"}, new Map([["rain", {variable: "rain", time: stamps[2]}]]));
        context.mock.timers.tick(70);
        assert.deepEqual(calls.at(-1), ["rain", stamps[1]]);
        controls.time.valueAsNumber = Date.parse(stamps[0]);
        controls.time.dispatchEvent(new Event("input"));
        controls.time.dispatchEvent(new Event("change"));
        assert.deepEqual(calls.at(-1), ["rain", stamps[0]], "release supersedes the slow intermediate frame");
    } finally { widget.destroy(); }
});
