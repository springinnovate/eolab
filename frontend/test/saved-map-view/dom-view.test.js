import assert from "node:assert/strict";
import test from "node:test";

import { SavedMapViewDomView } from "../../src/saved-map-view/dom-view.js";
import { VISITOR_CONTROL_PARENTS } from "../../src/visitor-controls.js";

/** Build the minimal semantic DOM required by the shared-map view. */
function viewFixture() {
  function element() {
    const listeners = new Map();
    const attributes = new Map();
    return {
      textContent: "",
      value: "",
      hidden: false,
      disabled: false,
      open: false,
      children: [],
      addEventListener(type, listener) {
        const handlers = listeners.get(type) ?? [];
        handlers.push(listener);
        listeners.set(type, handlers);
      },
      removeEventListener(type, listener) {
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((handler) => handler !== listener),
        );
      },
      setAttribute(name, value) { attributes.set(name, value); },
      removeAttribute(name) {
        attributes.delete(name);
        if (name === "href") delete this.href;
      },
      replaceChildren() { this.children = []; },
      append(child) { this.children.push(child); },
      focus() {},
      select() {},
      showModal() { this.open = true; },
      close(returnValue = "") {
        this.open = false;
        this.returnValue = returnValue;
        for (const listener of [...(listeners.get("close") ?? [])]) listener();
        listeners.set("close", []);
      },
      click() {
        for (const listener of [...(listeners.get("click") ?? [])]) listener();
      },
      dispatch(type, event = {}) {
        for (const listener of [...(listeners.get(type) ?? [])]) listener({ ...event, currentTarget: this });
      },
    };
  }

  const selectors = new Map([
    ["#copy-map-link", element()],
    ["#copy-map-link-label", element()],
    ["#reset-map-view", element()],
    ["#undo-reset-map-view", element()],
    ["#show-unavailable-map-layers", element()],
    ["#unavailable-map-layers-label", element()],
    ["#saved-map-view-dialog", element()],
    ["#saved-map-view-dialog-title", element()],
    ["#saved-map-view-dialog-summary", element()],
    ["#saved-map-view-dialog-url", element()],
    ["#saved-map-view-dialog-details", element()],
    ["#cancel-open-map-view", element()],
  ]);
  const documentContext = {
    querySelector: (selector) => selectors.get(selector),
    createElement: () => element(),
  };
  for (const name of ["editor", "editor-heading", "edit-title", "edit-subtitle", "edit-url", "save", "cancel", "edit-status"]) {
    selectors.set(`#published-map-${name}`, element());
  }
  for (const name of ["dialog", "form", "fields", "title", "subtitle", "slug", "preview", "status",
    "submit", "close", "result", "url", "open", "copy", "edit-link", "open-editor", "copy-editor"]) {
    selectors.set(`#publish-map-${name}`, element());
  }
  selectors.set("#visitor-control-options", { content: { cloneNode: () => ({}) } });
  for (const selector of ["#publish-map-visitor-controls", "#published-map-visitor-controls"]) {
    const controls = element();
    const children = element();
    const workspaceChildren = element();
    const inputs = new Map(Object.keys(VISITOR_CONTROL_PARENTS).map(id => [id, { checked: false, dataset: { visitorControl: id } }]));
    const panels = new Map(["catalog", "mapContents"].map(id => [id, { checked: false, dataset: { visitorPanelOpen: id } }]));
    controls.querySelectorAll = query => query === "input[data-visitor-panel-open]" ? panels.values() : inputs.values();
    controls.querySelector = query => query === "[data-visitor-inspection-children]" ? children
      : query === "[data-visitor-workspace-children]" ? workspaceChildren
        : inputs.get(query.match(/data-visitor-control="(\w+)"/)[1]);
    selectors.set(selector, controls);
  }
  selectors.get("#undo-reset-map-view").hidden = true;
  return {
    elements: selectors,
    view: new SavedMapViewDomView(documentContext, {
      locationContext: { href: "https://viewer.example/" },
      clipboard: null,
      setTimer: () => 1,
      clearTimer: () => {},
    }),
  };
}

test("published-map editing shows fixed URL, explicit save, busy state and retained errors", () => {
  const { view, elements } = viewFixture();
  const el = name => elements.get(`#published-map-${name}`);
  let submitted;
  view.bind({ onSavePublishedMap: fields => { submitted = fields; } });
  const visitorControls = { version: 1, choices: { inspectAndSelect: false, featurePicking: true, lasso: false } };
  const controls = el("visitor-controls");
  const children = controls.querySelector("[data-visitor-inspection-children]");
  const [parent, rasterValues, featurePicking, histogramBox, lasso] = [...controls.querySelectorAll()];
  view.showPublishedMapEditor({ title: "Amazon", subtitle: "Habitat", slug: "amazon", view: { visitorControls } }, true);
  assert.equal(el("editor").hidden, false);
  assert.match(el("editor-heading").textContent, /Amazon/);
  assert.equal(el("edit-url").href, "/maps/amazon");
  assert.deepEqual([parent.checked, rasterValues.checked, featurePicking.checked, histogramBox.checked, lasso.checked],
    [false, false, true, false, false]);
  assert.equal(children.disabled, true);
  parent.checked = true;
  controls.querySelector('[data-visitor-control="styleEditing"]').checked = true;
  controls.dispatch("change");
  assert.equal(children.disabled, false);
  el("edit-title").value = "New title";
  el("editor").dispatch("submit", { preventDefault() {} });
  assert.deepEqual(submitted, { title: "New title", subtitle: "Habitat", visitorControls: { version: 1,
    choices: { inspectAndSelect: true, rasterValues: false, featurePicking: true, histogramBox: false, lasso: false,
      workspacePanels: false, catalog: false, mapContents: false, styleEditing: true }, initialPanels: { catalog: false, mapContents: false } } });
  view.setPublishedMapSaving(true);
  assert.equal(el("cancel").hidden, true);
  assert.equal(el("edit-title").disabled, true);
  assert.equal(controls.disabled, true);
  view.showPublishedMapEditStatus("Save failed");
  view.setPublishedMapSaving(false);
  assert.equal(el("edit-title").value, "New title");
  assert.equal(controls.disabled, false);
  assert.equal(parent.checked && featurePicking.checked, true);
  assert.equal(el("edit-status").textContent, "Save failed");
  view.showPublishedMapEditor({ title: "Amazon", subtitle: "", slug: "amazon", view: {} }, false);
  assert.equal(el("save").disabled, false);
  assert.match(el("edit-status").textContent, /Review the map and any Unavailable layers before saving/);
  view.unbind();
});

test("publication dialog shows separate public and private links after a successful save", async () => {
  const { view, elements } = viewFixture();
  const el = name => elements.get(`#publish-map-${name}`);
  let submitted;
  view.bind({ onCopy() {}, onReset() {}, onUndo() {}, onPublish: fields => { submitted = fields; } });
  view.showPublicationForm({ title: "Amazon priorities", subtitle: "Explore habitat" });
  assert.equal(el("slug").value, "amazon-priorities");
  const controls = el("visitor-controls");
  const [parent, ...children] = [...controls.querySelectorAll()].slice(0, 5);
  assert.ok(children.every(input => input.checked));
  parent.checked = false;
  controls.dispatch("change");
  assert.equal(controls.querySelector("[data-visitor-inspection-children]").disabled, true);
  el("title").value = "Peru & Brazil";
  el("title").dispatch("input");
  assert.equal(el("slug").value, "peru-brazil");
  el("slug").value = "my-map";
  el("slug").dispatch("input");
  el("title").value = "New title";
  el("title").dispatch("input");
  assert.equal(el("slug").value, "my-map");
  el("subtitle").value = "";
  el("form").dispatch("submit", { preventDefault() {} });
  assert.deepEqual(submitted, { title: "New title", subtitle: "", slug: "my-map", visitorControls: { version: 1,
    choices: { inspectAndSelect: false, rasterValues: true, featurePicking: true, histogramBox: true, lasso: true,
      workspacePanels: true, catalog: false, mapContents: true, styleEditing: true }, initialPanels: { catalog: false, mapContents: true } } });
  view.setPublicationBusy(true);
  assert.equal(el("fields").disabled, true);
  view.showPublicationError("Name already taken");
  view.setPublicationBusy(false);
  assert.equal(el("status").textContent, "Name already taken");
  assert.equal(el("slug").value, "my-map");
  assert.equal(parent.checked, false);
  assert.ok(children.every(input => input.checked));
  const editToken = "b".repeat(64);
  const publicLink = "https://viewer.example/maps/my-map";
  const editLink = `${publicLink}/edit#${editToken}`;
  view.showPublishedMap("my-map", editToken);
  assert.equal(el("open").href, publicLink);
  assert.equal(el("url").value, publicLink);
  assert.equal(el("open-editor").href, editLink);
  assert.equal(el("edit-link").value, editLink);
  assert.equal(el("fields").hidden, true);
  assert.equal(el("result").hidden, false);
  const copied = [];
  view.clipboard = { async writeText(url) { copied.push(url); } };
  el("copy").dispatch("click");
  el("copy-editor").dispatch("click");
  assert.deepEqual(copied, [publicLink, editLink]);
  el("dialog").close();
  assert.equal(el("edit-link").value, "");
  assert.equal(el("open-editor").href, undefined);
  view.clipboard = null;
  view.location.href = editLink;
  assert.deepEqual(await view.copyNamedMapLink("my-map"), { copied: false, url: "https://viewer.example/maps/my-map" });
  view.unbind();
});

test("author forms retain unavailable child and initial-open choices and reset them for a different map", () => {
  const { view, elements } = viewFixture();
  let submitted;
  view.bind({ onSavePublishedMap: fields => { submitted = fields; } });
  const controls = elements.get("#published-map-visitor-controls");
  const choice = id => controls.querySelector(`[data-visitor-control="${id}"]`);
  const [catalogOpen, contentsOpen] = [...controls.querySelectorAll("input[data-visitor-panel-open]")];
  const visitorControls = { version: 1, choices: { workspacePanels: false, catalog: true, mapContents: false },
    initialPanels: { catalog: true, mapContents: true } };
  view.showPublishedMapEditor({ title: "First", subtitle: "", slug: "first", view: { visitorControls } }, true);
  assert.equal(controls.querySelector("[data-visitor-workspace-children]").disabled, true);
  assert.equal(choice("catalog").checked, true);
  assert.equal(catalogOpen.checked, true);
  assert.equal(contentsOpen.checked, true);
  assert.equal(contentsOpen.disabled, true);
  choice("workspacePanels").checked = true;
  controls.dispatch("change");
  assert.equal(controls.querySelector("[data-visitor-workspace-children]").disabled, false);
  assert.equal(catalogOpen.disabled, false);
  elements.get("#published-map-editor").dispatch("submit", { preventDefault() {} });
  assert.deepEqual(submitted.visitorControls.initialPanels, visitorControls.initialPanels);
  assert.equal(submitted.visitorControls.choices.workspacePanels, true);
  assert.equal(submitted.visitorControls.choices.mapContents, false);
  view.showPublishedMapEditStatus("The map has changed since it was opened.");
  assert.equal(catalogOpen.checked, true);
  view.showPublishedMapEditor({ title: "Second", subtitle: "", slug: "second", view: {} }, true);
  assert.equal(choice("catalog").checked, false);
  assert.equal(choice("mapContents").checked, true);
  assert.equal(catalogOpen.checked, false);
  assert.equal(contentsOpen.checked, true);
  view.showPublicationForm({ title: "New", subtitle: "" });
  const publish = elements.get("#publish-map-visitor-controls");
  publish.querySelector('[data-visitor-control="catalog"]').checked = true;
  elements.get("#publish-map-close").click();
  assert.equal(elements.get("#publish-map-dialog").open, false);
  view.showPublicationForm({ title: "New", subtitle: "" });
  assert.equal(publish.querySelector('[data-visitor-control="catalog"]').checked, false);
  view.unbind();
});

test("successful shared maps dismiss loading without a final click", () => {
  const { elements, view } = viewFixture();
  const dialog = elements.get("#saved-map-view-dialog");

  view.showLoading(2);
  assert.equal(elements.get("#saved-map-view-dialog-title").textContent,
    "Opening map…");
  assert.equal(elements.get("#saved-map-view-dialog-summary").textContent,
    "Loading 2 map items…");
  assert.equal(elements.get("#saved-map-view-dialog-details").hidden, true);
  assert.equal(dialog.open, true);

  view.showResults({ loaded: 2, total: 2, details: [] });

  assert.equal(dialog.open, false);
  assert.equal(dialog.returnValue, "loaded");
});

test("partial shared maps retain an actionable result dialog", () => {
  const { elements, view } = viewFixture();
  const dialog = elements.get("#saved-map-view-dialog");

  view.showLoading(2);
  view.showResults({
    loaded: 1,
    total: 2,
    details: ["Roads could not be loaded."],
  });

  assert.equal(dialog.open, true);
  assert.equal(elements.get("#saved-map-view-dialog-title").textContent,
    "Map partially opened");
  assert.equal(elements.get("#cancel-open-map-view").textContent, "Close");
  assert.equal(elements.get("#saved-map-view-dialog-details").children.length, 1);
});

test("shared maps retain actionable restoration warnings", () => {
  const { elements, view } = viewFixture();

  view.showLoading(1);
  view.showResults({
    loaded: 1,
    total: 1,
    details: ["Roads: saved style was not applied."],
  });

  assert.equal(elements.get("#saved-map-view-dialog").open, true);
  assert.equal(elements.get("#saved-map-view-dialog-title").textContent,
    "Map opened with warnings");
});

test("saved map controls bind reset and one-step undo accessibly", () => {
  const { elements, view } = viewFixture();
  const actions = [];
  view.bind({
    onCopy: () => actions.push("copy"),
    onReset: () => actions.push("reset"),
    onUndo: () => actions.push("undo"),
  });

  elements.get("#copy-map-link").click();
  elements.get("#reset-map-view").click();
  view.showUndoReset();
  elements.get("#undo-reset-map-view").click();

  assert.deepEqual(actions, ["copy", "reset", "undo"]);
  assert.equal(elements.get("#reset-map-view").hidden, true);
  assert.equal(elements.get("#undo-reset-map-view").hidden, false);
  view.hideUndoReset();
  assert.equal(elements.get("#reset-map-view").hidden, false);
  assert.equal(elements.get("#undo-reset-map-view").hidden, true);

  view.setBusy(true);
  for (const selector of [
    "#copy-map-link", "#reset-map-view", "#undo-reset-map-view",
  ]) {
    assert.equal(elements.get(selector).disabled, true);
  }
});

test("unavailable saved layers remain reachable after closing the dialog and remove only on an explicit action", () => {
  const {elements, view} = viewFixture();
  const actions = [];
  const layers = [{index: 2, label: "Wetland density", sourceSite: "https://other.example", fields: ["Density"]}];
  view.bind({onShowUnavailableLayers: () => {actions.push("open"); view.showUnavailableLayers(layers);},
    onRemoveUnavailableLayer: index => actions.push(index)});
  view.setUnavailableLayerCount(1);
  const entry = elements.get("#show-unavailable-map-layers");
  assert.equal(entry.hidden, false);
  assert.equal(elements.get("#unavailable-map-layers-label").textContent, "Unavailable layers (1)");
  entry.click();
  const dialog = elements.get("#saved-map-view-dialog");
  assert.equal(dialog.open, true);
  const row = elements.get("#saved-map-view-dialog-details").children[0];
  assert.equal(row.children[0].textContent, "Wetland density");
  assert.equal(row.children[1].textContent, "Site: https://other.example");
  assert.equal(row.children[2].textContent, "Calculated fields: Density");
  dialog.close();
  entry.click();
  assert.deepEqual(actions, ["open", "open"]);
  elements.get("#saved-map-view-dialog-details").children[0].children[3].click();
  assert.deepEqual(actions, ["open", "open", 2]);
  view.setBusy(true);
  assert.equal(entry.disabled, true);
  view.setUnavailableLayerCount(0);
  view.showUnavailableLayers([]);
  assert.equal(entry.hidden, true);
  assert.equal(elements.get("#saved-map-view-dialog-details").hidden, true);
  assert.match(elements.get("#saved-map-view-dialog-summary").textContent, /No unavailable/);
  view.unbind();
});
