import assert from 'node:assert/strict';
import test from 'node:test';
import { MapInteractionTools } from '../src/map-interaction-tools.js';
import { selectLassoFeatures } from '../src/vector/lasso.js';
import { resolveVisitorControls } from '../src/visitor-controls.js';

/** Minimal native-event control used by the production map-tool component. */
class Control extends EventTarget {
    /** Create an empty native-event control. */
    constructor() { super(); this.hidden=false; this.disabled=false; this.value=''; this.dataset={}; this.attributes={}; this.children=[]; this.classList={toggle(){}}; }
    /** Record an accessible attribute.
     * @param {string} name Attribute name.
     * @param {string} value Attribute value.
     * @return {void}
     */
    setAttribute(name,value) { this.attributes[name]=value; }
    /** Replace select options and select the first choice.
     * @param {...Control} children New options.
     * @return {void}
     */
    replaceChildren(...children) { this.children=children; this.value=children[0]?.value??''; }
}

/** Build independent map, controls and source choices around the real tool component.
 * @param {Function} [selectFeatures] Source API supplied by composition.
 * @param {import('../src/map-interaction-tools.js').MapToolAvailability} [availability] Effective visitor choices.
 * @return {Object} Tool and observable map/control boundaries.
 */
function fixture(selectFeatures=async()=>({matched:2,featureIds:['1','9007199254740993'],geometry:{type:'FeatureCollection',features:[]}}),
    availability=resolveVisitorControls()) {
    const root=new Control(),select=new Control(),status=new Control(),clear=new Control(),controls=new Control(),container=new Control();
    const buttons=['pan','pixel','box','lasso'].map(mode=>{const button=new Control();button.dataset.mapMode=mode;return button;});
    root.querySelectorAll=()=>buttons;
    root.querySelector=selector=>({'#lasso-controls':controls,'#lasso-layer':select,'#map-interaction-status':status,'#clear-lasso-selection':clear}[selector]);
    const document=new Control();document.querySelector=()=>root;document.createElement=()=>new Control();
    const capture=new Set();container.setPointerCapture=id=>capture.add(id);container.hasPointerCapture=id=>capture.has(id);container.releasePointerCapture=id=>capture.delete(id);
    const map={dragEnabled:true,getContainer:()=>container,dragging:{enabled:()=>map.dragEnabled,disable:()=>{map.dragEnabled=false;},enable:()=>{map.dragEnabled=true;}},
        on(){},off(){},mouseEventToLatLng:event=>({lng:event.clientX/10,lat:event.clientY/10})};
    const layers=[];
    const layer=()=>({addTo(){layers.push(this);return this;},remove(){this.removed=true;},setLatLngs(points){this.points=points;}});
    const leaflet = {
        polyline: () => layer(),
        polygon: (_points, options) => Object.assign(layer(), {type:'polygon', options}),
        geoJSON: geometry => Object.assign(layer(), {geometry}),
        circleMarker: () => layer(),
    };
    let targets=[{key:'hidden-view',label:'Filtered sites',visible:false,selection:{collectionId:'vectors',itemId:'sites',assetKey:'data',layerName:'sites',filter:{enabled:true,match:'any',rules:[{field:'kind',operator:'eq',value:'forest'}]}}}];
    const actions=[];
    const tools=new MapInteractionTools({documentContext:document,map,leaflet,getTargets:()=>targets,
        availability,onActionsChange:active=>actions.push(active),onClearSelection:()=>{},
        selectFeatures:async(target,area,signal)=>{
            const result=await selectFeatures(target.selection,area,signal);
            if (!signal.aborted) tools.setSelectionDisplay({polygon:area,geometry:result.geometry,count:result.matched,label:target.label});
        }});
    return {tools,root,select,status,clear,controls,buttons,container,document,map,layers,actions,setTargets:next=>{targets=next;},getTargets:()=>targets};
}

/** Return one primary pointer event in the fake map's screen coordinates.
 * @param {number} x Screen x.
 * @param {number} y Screen y.
 * @param {string} [ancestorSelector] Selector matching an ancestor of the hit element.
 * @return {Pick<PointerEvent, 'clientX'|'clientY'|'pointerId'|'pointerType'|'button'|'isPrimary'|'preventDefault'|'stopImmediatePropagation'>
 *     & {target:{closest:(selector:string)=>object|null}}} Primary pointer input for the map.
 */
const pointer = (x, y, ancestorSelector) => ({
    clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true,
    target: { closest(selector) { return selector === ancestorSelector ? this : null; } },
    preventDefault() {},
    stopImmediatePropagation() {},
});
const polygon={type:'Polygon',coordinates:[[[0,0],[2,0],[1,2],[0,0]]]};

test('map modes coordinate through callbacks and restore panning after lasso and drawing edits',()=>{
    const h=fixture();
    assert.equal(h.tools.mode,'pixel');assert.equal(h.controls.hidden,true);
    h.tools.setMode('lasso');assert.equal(h.map.dragEnabled,false);assert.equal(h.controls.hidden,false);
    assert.deepEqual(h.actions.at(-1),{rasterValues:false,featurePicking:false,histogramBox:false});
    h.tools.setEditing(true);assert.ok(h.buttons.every(button=>button.disabled));assert.equal(h.map.dragEnabled,true);
    assert.deepEqual(h.actions.at(-1),{rasterValues:false,featurePicking:false,histogramBox:false});
    h.tools.setEditing(false);assert.equal(h.map.dragEnabled,false);
    h.tools.setMode('pan');assert.equal(h.map.dragEnabled,true);
    h.tools.setMode('lasso');
    const showPixels=new Event('keydown',{cancelable:true});Object.defineProperty(showPixels,'key',{value:'p'});
    h.document.dispatchEvent(showPixels);
    assert.equal(h.tools.mode,'pixel','The existing P shortcut must return to pixel inspection');
    assert.equal(h.map.dragEnabled,true);
    assert.deepEqual(h.actions.at(-1),{rasterValues:true,featurePicking:true,histogramBox:false});
    h.tools.dispose();
});

test('release closes a freehand polygon and preserves the chosen hidden view and Match any filter',async()=>{
    let request;
    const h=fixture(async(selection,area,signal)=>{request={selection,area,signal};return {matched:2,featureIds:[1,3],geometry:{type:'FeatureCollection',features:[]}};});
    const original=structuredClone(h.getTargets()[0].selection);
    h.tools.setMode('lasso');
    const closePress = pointer(10, 10, '.leaflet-control');
    h.tools.beginStroke(closePress);
    assert.equal(h.container.hasPointerCapture(closePress.pointerId), false,
        'Lasso must let the Leaflet control receive the click');

    h.tools.beginStroke(pointer(10,10));
    const drawing = h.layers.at(-1);
    h.tools.setSelectionDisplay(null); // A different, previously selected source disappeared.
    h.tools.moveStroke(pointer(30,10));
    assert.deepEqual(drawing.points, [[1,1],[1,3]]);
    assert.match(h.status.textContent, /Drawing lasso/);
    h.tools.moveStroke(pointer(20,30));h.tools.finishStroke(pointer(10,10));
    await new Promise(setImmediate);
    assert.deepEqual(request.selection,original);assert.deepEqual(h.getTargets()[0].selection,original);
    const ring=request.area.coordinates[0];assert.deepEqual(ring[0],ring.at(-1));
    assert.equal(request.area.type,'Polygon');assert.match(h.status.textContent,/2 features selected in Filtered sites/);
    assert.ok(h.tools.highlight);assert.equal(h.root.attributes['aria-busy'],'false');
});

test('an open drag previews the shaded polygon that release selects', () => {
    let submitted;
    const h = fixture(async (_selection, area) => {
        submitted = area;
        return {matched:0, geometry:null};
    });
    h.tools.setMode('lasso');
    h.tools.beginStroke(pointer(10,10));
    h.tools.moveStroke(pointer(30,10));
    h.tools.moveStroke(pointer(20,30));
    const preview = h.layers.at(-1);
    assert.equal(preview.type, 'polygon', 'The closing edge should be visible before release');
    assert.ok(preview.options.fillOpacity > 0 && preview.options.fillOpacity < 1);
    assert.equal(preview.options.interactive, false);
    assert.deepEqual(preview.points, [[1,1],[1,3],[3,2]]);
    assert.equal(submitted, undefined);

    h.tools.finishStroke(pointer(20,30));
    assert.deepEqual(submitted, {type:'Polygon', coordinates:[[[1,1],[3,1],[2,3],[1,1]]]});
    assert.equal(preview.removed, true);
});

test('parent-off startup keeps Pan and blocks shortcut, toolbar, and programmatic mode requests', () => {
    const choices = {inspectAndSelect:false, rasterValues:true, histogramBox:true, lasso:true};
    const h = fixture(undefined, resolveVisitorControls({version:1, choices}));
    const actions = {rasterValues:false, featurePicking:false, histogramBox:false};
    assert.equal(h.tools.mode, 'pan');
    assert.deepEqual(h.actions, [actions]);
    assert.equal(h.map.dragEnabled, true);
    assert.deepEqual(h.buttons.filter(button => !button.hidden).map(button => button.dataset.mapMode), ['pan']);
    for (const button of h.buttons.filter(button => button.hidden)) {
        button.dispatchEvent(new Event('click'));
        h.tools.setMode(button.dataset.mapMode);
    }
    const key = Object.assign(new Event('keydown', {cancelable:true}), {key:'P'});
    h.document.dispatchEvent(key);
    assert.equal(key.defaultPrevented, false);
    assert.equal(h.tools.mode, 'pan');
    assert.deepEqual(h.actions, [actions]);

    h.tools.setAvailability(resolveVisitorControls({version:1, choices:{...choices, inspectAndSelect:true}}));
    assert.equal(h.tools.mode, 'pan');
    h.document.dispatchEvent(key);
    assert.equal(h.tools.mode, 'pixel');
    assert.deepEqual(h.actions.at(-1), {...actions, rasterValues:true});
    h.tools.setAvailability(resolveVisitorControls({version:1, choices:{inspectAndSelect:true, featurePicking:true}}));
    assert.equal(h.tools.mode, 'pixel');
    assert.equal(h.buttons.find(button => button.dataset.mapMode === 'pixel').textContent, 'Picker');
    assert.deepEqual(h.actions.at(-1), {...actions, featurePicking:true});
});

test('disabling Lasso releases captured pointers and rejects late replacements of the completed result', async () => {
    const h = fixture();
    h.tools.setMode('lasso');
    await h.tools.select(h.getTargets()[0], polygon);
    const previous = h.tools.highlight;
    const previousOutline = h.tools.outline;
    const none = resolveVisitorControls({version:1, choices:{}});
    h.tools.beginStroke(pointer(10,10));
    assert.equal(h.container.hasPointerCapture(1), true);
    h.tools.setAvailability(none);
    assert.equal(h.container.hasPointerCapture(1), false);
    assert.equal(h.tools.mode, 'pan');
    assert.equal(h.map.dragEnabled, true);

    h.tools.setAvailability(resolveVisitorControls());
    h.tools.setMode('lasso');
    let finish, signal;
    h.tools.selectFeatures = (_source, _polygon, abort) => {
        signal = abort;
        return new Promise(resolve => { finish = resolve; });
    };
    const pending = h.tools.select(h.getTargets()[0], polygon);
    h.tools.setAvailability(none);
    assert.equal(signal.aborted, true);
    assert.equal(h.root.attributes['aria-busy'], 'false');
    finish({matched:99, geometry:null});
    await pending;
    assert.equal(h.tools.outline, previousOutline);
    assert.equal(h.tools.highlight, previous);
    h.tools.setAvailability(resolveVisitorControls());
    h.tools.setMode('lasso');
    assert.match(h.status.textContent, /2 features selected/);
});

test('clear and source replacement cancel reads and reject a late successful response',async()=>{
    let finish,signal;
    const h=fixture((_source,_polygon,abort)=>{signal=abort;return new Promise(resolve=>{finish=resolve;});});
    h.tools.setMode('lasso');
    const pending=h.tools.select(h.getTargets()[0],polygon);
    h.tools.clear();assert.equal(signal.aborted,true);
    finish({matched:9,featureIds:['1'],geometry:{type:'FeatureCollection',features:[]}});await pending;
    assert.equal(h.tools.highlight,null);assert.match(h.status.textContent,/Selection cleared/);
    const second=h.tools.select(h.getTargets()[0],polygon);
    const targets=structuredClone(h.getTargets());targets[0].selection.filter.rules[0].value='grass';h.setTargets(targets);h.tools.refresh();
    assert.equal(signal.aborted,true);finish({matched:9,geometry:null});await second;
    assert.doesNotMatch(h.status.textContent,/9 features/);assert.equal(h.tools.outline,null);
});

test('clearing Features or revisiting history during a drag releases the pointer without submitting it', async () => {
    let submissions = 0;
    const h = fixture(async () => { submissions++; return {matched:0, geometry:null}; });
    h.tools.setMode('lasso');
    for (const display of [null, {polygon, geometry:null, count:2, label:'Earlier selection'}]) {
        h.tools.beginStroke(pointer(10,10));
        h.tools.moveStroke(pointer(30,10));
        h.tools.setSelectionDisplay(display, {cancelGesture:true});
        assert.equal(h.container.hasPointerCapture(1), false);
        h.tools.finishStroke(pointer(20,30));
    }
    await new Promise(setImmediate);
    assert.equal(submissions, 0);
    assert.match(h.status.textContent, /2 features selected in Earlier selection/);
});

test('Escape cancels a stroke and pending read while retaining the previous completed selection',async()=>{
    const h=fixture();h.tools.setMode('lasso');await h.tools.select(h.getTargets()[0],polygon);
    const previous=h.tools.highlight;
    h.tools.beginStroke(pointer(10,10));h.tools.moveStroke(pointer(30,10));
    const preview = h.layers.at(-1);
    const event=new Event('keydown',{cancelable:true});Object.defineProperty(event,'key',{value:'Escape'});h.document.dispatchEvent(event);
    assert.equal(preview.removed, true);
    assert.equal(h.tools.stroke,null);assert.equal(h.tools.highlight,previous);assert.equal(event.defaultPrevented,true);
    assert.match(h.status.textContent,/2 features selected/);
    let finish,signal;h.tools.selectFeatures=(_s,_p,abort)=>{signal=abort;return new Promise(resolve=>{finish=resolve;});};
    const pending=h.tools.select(h.getTargets()[0],polygon);h.document.dispatchEvent(event);
    assert.equal(signal.aborted,true);finish({matched:99,geometry:null});await pending;
    assert.equal(h.tools.highlight,previous);assert.doesNotMatch(h.status.textContent,/99/);
});

test('counts stay exact without a highlight and zero matches clear earlier highlighted features',async()=>{
    const h=fixture(async()=>({matched:1900,featureIds:[],geometry:null}));h.tools.setMode('lasso');
    await h.tools.select(h.getTargets()[0],polygon);assert.match(h.status.textContent,/1,900 features selected/);assert.match(h.status.textContent,/highlights are unavailable/);
    const geometry = {type:'FeatureCollection', simplified:true, features:[{type:'Feature', id:1, properties:{}, geometry:polygon}]};
    h.tools.setSelectionDisplay({polygon, geometry, count:1, label:'Filtered sites'});
    assert.equal(h.tools.highlight.geometry, geometry);
    assert.match(h.status.textContent, /1 feature selected in Filtered sites/);
    assert.match(h.status.textContent, /simplified shapes or points/);
    h.tools.selectFeatures=async()=>h.tools.setSelectionDisplay({polygon,geometry:null,count:0,label:'Filtered sites'});
    await h.tools.select(h.getTargets()[0],polygon);assert.match(h.status.textContent,/0 features selected/);
});

test('removing the chosen source and switching modes release active pointer work',()=>{
    const h=fixture();h.tools.setMode('lasso');h.tools.beginStroke(pointer(10,10));h.setTargets([]);h.tools.refresh();
    assert.equal(h.tools.stroke,null);assert.equal(h.select.disabled,true);assert.match(h.status.textContent,/Add a vector layer/);
    h.tools.setMode('pan');assert.equal(h.map.dragEnabled,true);
});

test('losing native pointer capture cancels the draft and preserves the last completed selection',async()=>{
    const h=fixture();h.tools.setMode('lasso');await h.tools.select(h.getTargets()[0],polygon);
    const previous=h.tools.highlight;
    h.tools.beginStroke(pointer(10,10));h.tools.moveStroke(pointer(30,10));
    h.container.dispatchEvent(new Event('lostpointercapture'));
    assert.equal(h.tools.stroke,null);assert.equal(h.tools.highlight,previous);
    assert.match(h.status.textContent,/2 features selected/);
});

test('selection transport preserves native IDs and sends both private owner headers',async t=>{
    const featureIds=['-9007199254740993','9007199254740993'];
    let request;t.mock.method(globalThis,'fetch',async(url,options)=>{request={url,options};return Response.json({matched:2,featureIds,geometry:null,features:featureIds.map(id=>({id,properties:{}}))});});
    const h=fixture(),source=h.getTargets()[0].selection,abort=new AbortController();
    const result=await selectLassoFeatures(source,polygon,abort.signal);
    assert.equal(request.url,'/api/vector-sampling/lasso');assert.deepEqual(JSON.parse(request.options.body),{selection:source,polygon});
    assert.equal(request.options.headers['X-EOLab-Uploads'],'1');assert.equal(request.options.headers['X-EOLab-Processing'],'1');assert.equal(request.options.signal,abort.signal);assert.equal(result.matched,2);
    assert.deepEqual(result.featureIds,featureIds);
    t.mock.method(globalThis,'fetch',async()=>Response.json({detail:[]},{status:422}));
    await assert.rejects(selectLassoFeatures(source,polygon,abort.signal),/does not cross itself/);
});
