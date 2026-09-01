import assert from "node:assert/strict";
import test from "node:test";

import { VectorStyleControls } from "../../src/vector/style-controls.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";

function styleFixture() {
    const documentContext = new FakeRasterControlDocument();
    const controls = new VectorStyleControls(documentContext);
    const applied = [];
    return {
        controls,
        documentContext,
        applied,
        target(geometryKind, style) {
            return {
                key: geometryKind,
                style,
                fields: [
                    { name: "name", type: "str" },
                    { name: "value", type: "float" },
                ],
                async apply(nextStyle) {
                    applied.push(nextStyle);
                    return nextStyle;
                },
            };
        },
    };
}

test("vector style controls show fields owned by each geometry", () => {
    const fixture = styleFixture();
    fixture.controls.show(fixture.target("line", {
        geometryKind: "line",
        strokeColor: "#f97316",
        strokeOpacity: 1,
        strokeWidth: 3,
    }));
    assert.equal(fixture.controls.fillGroup.hidden, true);
    assert.equal(fixture.controls.pointGroup.hidden, true);
    assert.equal(fixture.controls.heading.textContent, "Line style");
    assert.equal(fixture.controls.labelEnabled.checked, false);
    assert.equal(fixture.controls.labelField.children.length, 2);
    assert.equal(fixture.controls.labelFontFamily.value, "SansSerif");
    assert.equal(fixture.controls.labelFontSize.value, "12");
    assert.equal(fixture.controls.labelFontWeight.value, "normal");
    assert.equal(fixture.controls.labelFontColor.value, "#111827");
    assert.equal(fixture.controls.labelHaloColor.value, "#ffffff");
    assert.equal(fixture.controls.labelHaloWidth.value, "1.5");
    assert.equal(fixture.controls.labelMinimumZoom.value, "0");

    fixture.controls.show(fixture.target("point", {
        geometryKind: "point",
        fillColor: "#06b6d4",
        fillOpacity: 1,
        strokeColor: "#083344",
        strokeOpacity: 1,
        strokeWidth: 1.5,
        pointSize: 9,
    }));
    assert.equal(fixture.controls.fillGroup.hidden, false);
    assert.equal(fixture.controls.pointGroup.hidden, false);
    fixture.controls.destroy();
});

test("vector style controls apply one complete validated state", async () => {
    const fixture = styleFixture();
    fixture.controls.show(fixture.target("polygon", {
        geometryKind: "polygon",
        fillColor: "#a855f7",
        fillOpacity: 0.38,
        strokeColor: "#581c87",
        strokeOpacity: 1,
        strokeWidth: 2,
    }));
    fixture.controls.fillColor.value = "#00ff00";
    fixture.controls.fillOpacity.value = "55";
    fixture.controls.strokeWidth.value = "4";
    fixture.controls.applyButton.dispatchEvent(new Event("click"));
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(fixture.applied, [{
        geometryKind: "polygon",
        fillColor: "#00ff00",
        fillOpacity: 0.55,
        strokeColor: "#581c87",
        strokeOpacity: 1,
        strokeWidth: 4,
        pointSize: null,
        label: null,
    }]);
    assert.equal(fixture.controls.status.textContent, "Style applied to the map.");
    fixture.controls.destroy();
});

test("vector style controls apply a field-backed optional label", async () => {
    const fixture = styleFixture();
    fixture.controls.show(fixture.target("line", {
        geometryKind: "line",
        strokeColor: "#f97316",
        strokeOpacity: 1,
        strokeWidth: 3,
    }));
    fixture.controls.labelEnabled.checked = true;
    fixture.controls.labelEnabled.dispatchEvent(new Event("change"));
    fixture.controls.labelField.value = "value";
    fixture.controls.labelFontFamily.value = "Monospaced";
    fixture.controls.labelFontSize.value = "14";
    fixture.controls.labelFontWeight.value = "bold";
    fixture.controls.labelFontColor.value = "#112233";
    fixture.controls.labelHaloColor.value = "#ffffff";
    fixture.controls.labelHaloWidth.value = "2";
    fixture.controls.labelPlacement.value = "follow-line";
    fixture.controls.labelMinimumZoom.value = "7";
    fixture.controls.applyButton.dispatchEvent(new Event("click"));
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(fixture.applied[0].label, {
        field: "value",
        fontFamily: "Monospaced",
        fontSize: 14,
        fontWeight: "bold",
        fontColor: "#112233",
        haloColor: "#ffffff",
        haloWidth: 2,
        placement: "follow-line",
        minimumZoom: 7,
    });
    assert.equal(
        fixture.controls.labelNote.textContent,
        "Labels use value at zoom 7 and closer. Long values are not " +
            "truncated and may be omitted when GeoServer cannot place " +
            "them without a conflict.",
    );
    fixture.controls.destroy();
});

test("closing during an apply cannot disable or overwrite a reopened form", async () => {
    const fixture = styleFixture();
    let finishApply;
    const style = {
        geometryKind: "line",
        strokeColor: "#f97316",
        strokeOpacity: 1,
        strokeWidth: 3,
    };
    fixture.controls.show({
        key: "line",
        style,
        fields: [{ name: "name", type: "str" }],
        apply: () => new Promise(resolve => { finishApply = resolve; }),
    });
    fixture.controls.applyButton.dispatchEvent(new Event("click"));
    assert.equal(fixture.controls.applyButton.disabled, true);
    assert.equal(fixture.controls.status.textContent, "Applying style...");
    fixture.controls.hide();
    fixture.controls.show(fixture.target("line", style));
    assert.equal(fixture.controls.applyButton.disabled, false);
    fixture.controls.status.textContent = "New target";
    finishApply(style);
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(fixture.controls.status.textContent, "New target");
    assert.equal(fixture.controls.applyButton.disabled, false);
    fixture.controls.destroy();
});
