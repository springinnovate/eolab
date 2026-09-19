import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationSessionsView } from "../../src/annotation-sessions/view.js";

/** DOM test element supporting retained forms and movable status messages. */
class Element extends EventTarget {
    /** @param {Object} document Owner tracking focus. @param {string} tag HTML tag. */
    constructor(document, tag) {
        super(); this.ownerDocument = document; this.tagName = tag; this.children = [];
        this.attributes = new Map(); this.classes = new Set(); this.textContent = "";
        this.hidden = false; this.value = ""; this.open = false;
        this.classList = { toggle: (name, force) => force ? this.classes.add(name) : this.classes.delete(name) };
    }
    /** @param {...Element} nodes Elements to move into this parent. @return {void} */
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
    /** Remove this element from its current parent. @return {void} */
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
    /** @param {...Element} nodes New child elements. @return {void} */
    replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
    /** @return {Element|undefined} First child. */
    get firstChild() { return this.children[0]; }
    /** @param {string} name Attribute name. @param {string} value Attribute value. @return {void} */
    setAttribute(name, value) { this.attributes.set(name, value); }
    /** Focus this element. @return {void} */
    focus() { this.ownerDocument.activeElement = this; }
}

/** @return {Object} Real session view with a DOM fixture and workspace-reveal observation. */
function setup() {
    const document = { createElement: tag => new Element(document, tag) };
    const root = document.createElement("section"); const entry = document.createElement("button");
    let reveals = 0;
    const actions = { reveal: () => reveals++, revealEntry: () => {} };
    for (const name of ["copy", "extend", "show", "refresh", "leave"]) actions[name] = () => {};
    const view = new AnnotationSessionsView(root, actions, entry);
    const snapshot = { id: "session", name: "Connectivity workshop", isOwner: true, contributorId: "me",
        contributors: [{ id: "me", name: "Rich" }], layers: [], joinsOpen: true, joinCode: "ABCDEFGH", expiresAt: Date.now() };
    return { view, root, entry, snapshot, document, reveals: () => reveals };
}

test("disconnected setup occupies no space until requested and closing retains input", () => {
    const { view, root, entry, document, reveals } = setup();
    view.message("Left the session.");
    assert.equal(root.hidden, true); assert.equal(entry.hidden, false);
    entry.dispatchEvent(new Event("click"));
    assert.equal(root.hidden, false); assert.equal(reveals(), 1);
    view.showSetup("join"); view.displayName.value = "Maria";
    view.hideSetupPanel();
    assert.equal(root.hidden, true); assert.equal(document.activeElement, entry);
    view.showSetupPanel(); view.showSetup("join");
    assert.equal(view.displayName.value, "Maria");
});

test("connected row hides management and normal messages without hiding errors", () => {
    const { view, root, entry, snapshot } = setup();
    view.render(snapshot, new Map()); view.message("All sent changes are saved in the session.");
    assert.equal(root.hidden, false); assert.equal(entry.hidden, true);
    assert.equal(view.session.open, false); assert.equal(view.heading.textContent, snapshot.name);
    assert.equal(view.copy.parentElement, view.inviteActions);
    assert.equal(view.status.parentElement, view.details);
    view.message("Connection interrupted", true);
    assert.equal(view.status.parentElement, root); assert.equal(view.status.hidden, false);
    assert.equal(view.indicator.title, "Sharing needs attention");
    view.clearError("An older error"); assert.equal(view.status.hidden, false);
    view.clearError("Connection interrupted"); assert.equal(view.status.hidden, true);
    assert.equal(view.indicator.title, "Saved changes are shared");
});

test("sync indicator follows uploads and retains unresolved errors across another layer's success", () => {
    const { view, snapshot, root } = setup();
    const state = { uploading: true }; const sharing = new Map([["layer", state]]);
    view.render(snapshot, sharing); assert.equal(view.indicator.title, "Sharing saved changes");
    state.uploading = false; state.error = true; state.message = "Upload failed; saved on this device";
    view.render(snapshot, sharing); view.message("Another layer was saved");
    assert.equal(view.status.parentElement, root); assert.equal(view.status.textContent, state.message);
    state.error = false; view.render(snapshot, sharing);
    assert.equal(view.indicator.title, "Saved changes are shared");
    assert.equal(view.status.parentElement, view.details);
});

test("refresh retains expanded details and typed profile while leaving removes the row", () => {
    const { view, snapshot, root, entry, reveals } = setup();
    view.render(snapshot, new Map()); view.showDetails();
    view.profileName.value = "New name"; view.profileName.dispatchEvent(new Event("input"));
    view.render(snapshot, new Map());
    assert.equal(view.session.open, true); assert.equal(view.profileName.value, "New name");
    assert.equal(reveals(), 1);
    view.render(null, new Map()); view.message("Left the session.");
    assert.equal(root.hidden, true); assert.equal(entry.hidden, false);
});

test("invitations reveal the workspace and focus the contributor name", () => {
    const { view, root, document, reveals } = setup();
    view.showInvitation("ABCDEFGH");
    assert.equal(root.hidden, false); assert.equal(reveals(), 1);
    assert.equal(view.code.value, "ABCDEFGH"); assert.equal(view.joinForm.hidden, false);
    assert.equal(document.activeElement, view.displayName);
});
