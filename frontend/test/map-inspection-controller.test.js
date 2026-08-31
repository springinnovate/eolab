import assert from 'node:assert/strict';
import test from 'node:test';
import { MapInspectionController } from '../src/map-inspection-controller.js';
import { FakeRasterControlDocument } from '../test-support/raster/fake-controls-document.js';

/** Build a retained, non-modal map surface with focus and lifecycle spies. */
function fixture() {
    const doc = new FakeRasterControlDocument();
    const events = new EventTarget();
    doc.addEventListener = events.addEventListener.bind(events);
    doc.removeEventListener = events.removeEventListener.bind(events);
    doc.dispatchEvent = events.dispatchEvent.bind(events);
    const root = doc.querySelector('#map-inspection');
    const histogram = doc.querySelector('#map-histogram-panel');
    const style = doc.querySelector('#layer-style-editor');
    histogram.hidden = style.hidden = true;
    const close = doc.querySelector('#close-map-histogram');
    histogram.append(close);
    const calls = [];
    root.showPopover = () => calls.push('show');
    root.hidePopover = () => calls.push('hide');
    const controller = new MapInspectionController({ documentContext: doc,
        onHistogramClose: () => calls.push('pause') });
    return { doc, histogram, style, close, calls, controller,
        opener: doc.querySelector('#open-map-histogram') };
}

test('automatic presentation does not move focus; close and reopen retain results', () => {
    const h = fixture();
    const map = h.doc.querySelector('#map');
    const chart = h.doc.createElement();
    chart.textContent = 'Sampled drought distribution';
    h.histogram.append(chart);
    map.focus();
    h.controller.showHistogram();
    h.controller.showHistogram();
    assert.deepEqual(h.calls, ['show']);
    assert.equal(h.doc.activeElement, map);
    assert.equal(h.histogram.hidden, false);
    assert.equal(h.opener.getAttribute('aria-expanded'), 'true');

    h.close.dispatchEvent(new Event('click'));
    assert.equal(h.histogram.hidden, true);
    assert.equal(h.doc.activeElement, h.opener);
    assert.equal(h.opener.getAttribute('aria-expanded'), 'false');
    h.controller.closeHistogram();
    assert.deepEqual(h.calls, ['show', 'pause', 'hide']);
    h.opener.dispatchEvent(new Event('click'));
    assert.equal(h.doc.activeElement, h.close);
    assert.equal(h.histogram.children.at(-1), chart);
    assert.equal(chart.textContent, 'Sampled drought distribution');
    assert.deepEqual(h.calls, ['show', 'pause', 'hide', 'show']);
    h.controller.destroy();
});

test('histogram and style have independent visibility on one persistent surface', () => {
    const h = fixture();
    h.controller.showStyle();
    h.controller.showHistogram();
    assert.equal(h.style.hidden, false);
    assert.equal(h.histogram.hidden, false);
    h.controller.closeHistogram();
    assert.equal(h.style.hidden, false);
    assert.deepEqual(h.calls, ['show', 'pause']);
    h.controller.showHistogram();
    h.controller.hideStyle();
    assert.equal(h.histogram.hidden, false);
    assert.deepEqual(h.calls, ['show', 'pause']);
    h.controller.destroy();
    assert.deepEqual(h.calls, ['show', 'pause', 'hide']);
});

test('Escape is focus-scoped and destroy detaches presentation listeners', () => {
    const h = fixture();
    /** Dispatch one keyboard Escape at the owning document. */
    const escape = () => {
        const event = new Event('keydown', { cancelable: true });
        Object.defineProperty(event, 'key', { value: 'Escape' });
        h.doc.dispatchEvent(event);
        return event.defaultPrevented;
    };
    h.controller.showHistogram();
    h.doc.querySelector('#map').focus();
    assert.equal(escape(), false);
    assert.equal(h.histogram.hidden, false);
    h.close.focus();
    assert.equal(escape(), true);
    assert.equal(h.histogram.hidden, true);
    h.controller.destroy();
    h.opener.dispatchEvent(new Event('click'));
    h.close.dispatchEvent(new Event('click'));
    assert.equal(escape(), false);
    assert.equal(h.histogram.hidden, true);
    assert.deepEqual(h.calls, ['show', 'pause', 'hide']);
});
