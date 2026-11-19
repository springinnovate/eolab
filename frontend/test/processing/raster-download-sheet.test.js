import assert from "node:assert/strict";
import test from "node:test";
import { RasterDownloadSheet } from "../../src/processing/raster-download-sheet.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";

/** Supply measured edges for the map, layer list, and Download button.
 * @param {number} left Left edge in viewport pixels.
 * @param {number} top Top edge in viewport pixels.
 * @param {number} width Element width.
 * @param {number} height Element height.
 * @return {Object} Layout rectangle.
 */
function rect(left, top, width, height) {
    return {left, top, width, height, right:left + width, bottom:top + height};
}

test("a bottom-row download fits the viewport, follows replacement buttons, and frees the row on dismissal", () => {
    const doc = new FakeRasterControlDocument();
    doc.getElementById = id => doc.querySelector("#" + id);
    const view = new EventTarget();
    // Deliver layout changes explicitly through position() in this DOM fixture.
    class Observer { observe() {} disconnect() {} }
    Object.assign(view, {innerWidth:850, innerHeight:460, ResizeObserver:Observer, MutationObserver:Observer, cancelAnimationFrame() {}});
    doc.defaultView = view;
    const dialog = doc.querySelector("#raster-download-sheet");
    const content = doc.createElement("div");
    content.setAttribute("class", "raster-download-scroll");
    dialog.append(content);
    dialog.getBoundingClientRect = () => rect(0, 0, parseFloat(dialog.style.width), Math.min(405, parseFloat(dialog.style.maxHeight)));
    const map = doc.createElement("div"), list = doc.createElement("ol");
    map.getBoundingClientRect = () => rect(0, 0, view.innerWidth, view.innerHeight);
    list.getBoundingClientRect = () => rect(5, 160, 290, 294);
    let button = doc.createElement("button");
    button.getBoundingClientRect = () => rect(130, 406, 80, 40);
    const sheet = new RasterDownloadSheet({document:doc, map, list, scrollContainer:list, getButton:() => button});
    sheet.bind({onClose:focus => sheet.close(focus), onNew() {}});
    sheet.open("named-copy");
    assert.equal(dialog.dataset.side, "right");
    assert.equal(parseFloat(dialog.style.top) + dialog.getBoundingClientRect().height, 452);
    assert.equal(parseFloat(dialog.style.top) + parseFloat(dialog.style.getPropertyValue("--download-arrow-y")), 426);
    const replacement = doc.createElement("button");
    replacement.getBoundingClientRect = button.getBoundingClientRect;
    button = replacement;
    view.innerWidth = 320;
    sheet.position();
    assert.equal(dialog.dataset.side, "above");
    assert.ok(parseFloat(dialog.style.top) >= 8);
    assert.ok(parseFloat(dialog.style.top) + dialog.getBoundingClientRect().height < button.getBoundingClientRect().top);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    sheet.close(true);
    assert.equal(doc.activeElement, replacement);
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(dialog.popoverOpen, false);
    sheet.destroy();
});
