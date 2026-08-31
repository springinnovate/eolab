import assert from 'node:assert/strict';
import test from 'node:test';
import { MapLayerStyleEditor } from '../../src/map-layers/style-editor.js';
import { FakeRasterControlDocument } from '../../test-support/raster/fake-controls-document.js';

function fixture() {
    const doc = new FakeRasterControlDocument();
    const events = new EventTarget();
    doc.addEventListener = events.addEventListener.bind(events);
    doc.removeEventListener = events.removeEventListener.bind(events);
    doc.dispatchEvent = events.dispatchEvent.bind(events);
    const root = doc.querySelector('#layer-style-editor');
    root.showPopover = () => { root.open = true; };
    root.hidePopover = () => { root.open = false; };
    let layers = [{ key: 'a', label: 'a.tif', visible: true, opacity: 0.4 },
        { key: 'b', label: 'b.gpkg', visible: true, opacity: 1 }];
    const styleButtons = ['a', 'b'].map(key => {
        const button = doc.createElement();
        button.dataset = { layerKey: key };
        return button;
    });
    doc.querySelectorAll = () => styleButtons.filter(button => layers.some(layer => layer.key === button.dataset.layerKey));
    const edits = [];
    const editor = new MapLayerStyleEditor({ documentContext: doc,
        mapLayers: {
            snapshots: () => layers,
            setOpacity(key, value) { layers.find(layer => layer.key === key).opacity = value; edits.push([key, value]); },
        },
        rasterViewer: { openStyle: key => key === 'a', closeStyle() {}, refreshStyle() {} },
    });
    return { doc, root, layers, styleButtons, edits, editor,
        setLayers(value) { layers = value; } };
}

test('one editor keeps its layer identity through reorder and persists opacity on close', () => {
    const h = fixture();
    h.editor.open('a');
    assert.equal(h.root.open, true);
    assert.equal(h.doc.activeElement, h.editor.closeButton);
    h.setLayers([...h.layers].reverse());
    h.editor.refresh();
    assert.equal(h.editor.title.textContent, 'a.tif');
    h.editor.opacity.value = '65';
    h.editor.opacity.dispatchEvent(new Event('input'));
    assert.deepEqual(h.edits, [['a', 0.65]]);
    const escape = new Event('keydown', { cancelable: true });
    Object.defineProperty(escape, 'key', { value: 'Escape' });
    h.doc.dispatchEvent(escape);
    assert.equal(h.root.open, false);
    assert.equal(h.doc.activeElement, h.styleButtons[0]);
    h.editor.open('a');
    assert.equal(h.editor.opacity.value, '65');
    h.editor.destroy();
});

test('vector editor exposes opacity only, and removed targets close safely', () => {
    const h = fixture();
    h.editor.open('b');
    assert.equal(h.editor.rasterControls.hidden, true);
    assert.equal(h.editor.pairedControls.hidden, true);
    assert.match(h.editor.note.textContent, /fixed default colors/);
    h.setLayers([h.layers[0]]);
    h.editor.refresh();
    assert.equal(h.root.open, false);
    assert.equal(h.editor.key, null);
    assert.equal(h.doc.activeElement, h.doc.querySelector('#toggle-map-layers'));
    h.editor.destroy();
});

test('paired styles lock ordinary opacity and show the coordinated controls', () => {
    const h = fixture();
    h.layers[0].opacityLocked = true;
    h.layers[0].effectiveOpacity = 1;
    h.editor.open('a');
    assert.equal(h.editor.opacity.disabled, true);
    assert.equal(h.editor.opacity.value, '100');
    assert.equal(h.editor.rasterControls.hidden, true);
    assert.equal(h.editor.pairedControls.hidden, false);
    h.editor.opacity.dispatchEvent(new Event('input'));
    assert.deepEqual(h.edits, []);
    h.editor.destroy();
});
