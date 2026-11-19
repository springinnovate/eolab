/** Keep named polygon layer groups in this browser's Map contents. */

/** @typedef {{key:string,label:string}} PolygonGroupLayer Retained map view and its readable name. */
/** @typedef {{id:string,name:string,members:PolygonGroupLayer[]}} MapPolygonGroup Named collection of map views. */

/** Edit named groups of polygon views and remember their membership on this browser. */
export class MapPolygonGroups {
    /**
     * @param {HTMLDetailsElement} root Polygon groups section in Map contents.
     * @param {Object} options Local storage and change notification.
     * @param {{read:()=>string|null,write:(value:string)=>boolean}} options.storage Origin-local storage for the group list.
     * @param {()=>void} options.onChange Notify composition after group membership or names change.
     */
    constructor(root, {storage, onChange}) {
        this.root = root;
        this.storage = storage;
        this.onChange = onChange;
        this.document = root.ownerDocument;
        this.add = root.querySelector("[data-new-group]");
        this.list = root.querySelector("[data-group-list]");
        this.editor = root.querySelector("[data-group-editor]");
        this.nameField = this.editor.elements.namedItem("groupName");
        this.choices = root.querySelector("[data-member-choices]");
        this.error = root.querySelector("[data-group-error]");
        this.status = root.querySelector("[data-group-status]");
        this.heading = root.querySelector("#polygon-group-editor-title");
        this.groups = readPolygonGroups(storage.read());
        /** @type {Map<string, string>} Latest available polygon view labels. */
        this.layers = new Map();
        /** @type {string|null} Open editor group ID, or an empty string for a new group. */
        this.editing = null;
        this.add.addEventListener("click", () => this.openEditor());
        root.querySelector("[data-cancel-group]").addEventListener("click", () => {
            const id = this.editing;
            this.closeEditor();
            this.focusGroup(id);
        });
        this.editor.addEventListener("submit", event => {
            event.preventDefault();
            this.saveGroup();
        });
        this.renderGroups();
    }

    /** Refresh the available choices independently of their visibility and draw order.
     * @param {PolygonGroupLayer[]} layers Eligible retained polygon views from composition.
     * @return {void}
     */
    updateLayers(layers) {
        const next = new Map(layers.map(layer => [layer.key, layer.label]));
        if (next.size === this.layers.size && [...next].every(([key, label]) => this.layers.get(key) === label)) return;
        this.layers = next;
        this.renderGroups();
    }

    /** Return group names and view keys for a tool's input picker.
     * @return {MapPolygonGroup[]} Detached membership and fallback display labels.
     */
    snapshot() {
        return structuredClone(this.groups);
    }

    /** Show saved groups and flag members that are missing from Map contents.
     * @param {string} [expand=""] Group to expand after saving.
     * @return {void}
     */
    renderGroups(expand = "") {
        const active = this.document.activeElement;
        const focused = this.list.contains(active) ? active.closest("[data-group-id]") : null;
        const open = new Set([...this.list.querySelectorAll("details[open]")].map(group => group.dataset.groupId));
        const cards = this.groups.map(group => {
            const card = this.document.createElement("details");
            card.dataset.groupId = group.id;
            card.open = group.id === expand || open.has(group.id);
            const summary = this.document.createElement("summary");
            summary.textContent = `${group.name} · ${group.members.length} ${group.members.length === 1 ? "layer" : "layers"}`;
            const members = this.document.createElement("ul");
            for (const {key, label} of group.members) {
                const item = this.document.createElement("li");
                item.textContent = this.layers.get(key) ?? `${label} (unavailable)`;
                members.append(item);
            }
            const actions = this.document.createElement("div");
            actions.className = "polygon-group-actions";
            const edit = this.groupButton("Edit group", group, () => this.openEditor(group));
            edit.dataset.editGroup = "";
            actions.append(edit, this.groupButton("Remove group", group, () => {
                this.groups = this.groups.filter(value => value.id !== group.id);
                if (this.editing === group.id) this.closeEditor();
                this.commitGroups(`Removed ${group.name}.`);
                this.focusGroup(null);
            }));
            card.append(summary, members, actions);
            return card;
        });
        this.list.replaceChildren(...cards);
        this.root.hidden = this.layers.size === 0 && this.groups.length === 0 && this.editing === null;
        this.add.disabled = this.layers.size === 0 || this.editing !== null;
        if (focused) this.focusGroup(focused.dataset.groupId);
    }

    /** Create a group action with a group-specific accessible name.
     * @param {string} caption Short visible action label.
     * @param {MapPolygonGroup} group Group the action affects.
     * @param {()=>void} activate Action to perform.
     * @return {HTMLButtonElement} Button for the group's expanded controls.
     */
    groupButton(caption, group, activate) {
        const button = this.document.createElement("button");
        button.type = "button";
        button.className = "secondary-button";
        button.textContent = caption;
        button.setAttribute("aria-label", `${caption} ${group.name}`);
        button.addEventListener("click", activate);
        return button;
    }

    /** Open the membership editor for a new or existing group.
     * @param {MapPolygonGroup} [group] Group being edited, when present.
     * @return {void}
     */
    openEditor(group) {
        this.editing = group?.id ?? "";
        this.nameField.value = group?.name ?? "";
        this.heading.textContent = group ? "Edit polygon group" : "New polygon group";
        this.error.hidden = true;
        this.status.textContent = "";
        const members = new Map((group?.members ?? []).map(layer => [layer.key, layer.label]));
        const choices = new Map([...members, ...this.layers]);
        this.choices.replaceChildren(...[...choices].map(([key, label]) => {
            const field = this.document.createElement("label");
            const checkbox = this.document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.name = "member";
            checkbox.value = key;
            checkbox.dataset.label = label;
            checkbox.checked = members.has(key);
            field.append(checkbox, this.layers.has(key) ? ` ${label}` : ` ${label} (unavailable)`);
            return field;
        }));
        this.add.disabled = true;
        this.list.hidden = true;
        this.editor.hidden = false;
        this.nameField.focus();
    }

    /** Save the group as view keys, using readable names for unavailable members.
     * @return {void}
     */
    saveGroup() {
        const name = this.nameField.value.trim();
        const selected = [...this.choices.querySelectorAll("input:checked")];
        const current = this.groups.find(group => group.id === this.editing);
        const nameTaken = this.groups.some(group => group.id !== this.editing && group.name.toLowerCase() === name.toLowerCase());
        if (!name || nameTaken || selected.length === 0) {
            this.error.textContent = !name ? "Enter a group name." :
                nameTaken ? "Use a different group name." : "Choose at least one polygon layer.";
            this.error.hidden = false;
            if (!name || nameTaken) this.nameField.focus();
            else this.choices.querySelector("input")?.focus();
            return;
        }
        const members = selected.map(input => ({
            key: input.value, label: this.layers.get(input.value) ?? input.dataset.label,
        }));
        const group = {id: current?.id ?? globalThis.crypto.randomUUID(), name, members};
        this.groups = current ? this.groups.map(value => value.id === group.id ? group : value) : [...this.groups, group];
        this.closeEditor();
        this.commitGroups(`Saved ${name}.`, group.id);
        this.focusGroup(group.id);
    }

    /** Close the editor and return to the expanded group list.
     * @return {void}
     */
    closeEditor() {
        this.editing = null;
        this.editor.hidden = true;
        this.list.hidden = false;
        this.add.disabled = this.layers.size === 0;
    }

    /** Apply a group change, update the model picker and announce the storage result.
     * @param {string} message Confirmation of the requested group change.
     * @param {string} [expand=""] Saved group to expand.
     * @return {void}
     */
    commitGroups(message, expand = "") {
        const stored = this.storage.write(JSON.stringify(this.groups));
        this.status.textContent = stored ? message : `${message} Group changes could only be saved for this visit.`;
        this.renderGroups(expand);
        this.onChange();
    }

    /** Restore keyboard focus after drawing the list or closing the editor.
     * @param {string|null} id Group to focus, or null for the section controls.
     * @return {void}
     */
    focusGroup(id) {
        const card = [...this.list.children].find(group => group.dataset.groupId === id);
        const target = card?.querySelector(card.open ? "[data-edit-group]" : "summary") ??
            (this.add.disabled ? this.root.querySelector("summary") : this.add);
        target.focus();
    }
}

/** Read group definitions from private browser storage.
 * @param {string|null} serialized Previously stored group list.
 * @return {MapPolygonGroup[]} Valid saved groups, or an empty list when storage is unavailable.
 */
function readPolygonGroups(serialized) {
    let groups;
    try { groups = JSON.parse(serialized); } catch { return []; }
    if (!Array.isArray(groups)) return [];
    return groups.filter(group => group && typeof group.id === "string" && group.id &&
        typeof group.name === "string" && group.name.length > 0 && group.name.length <= 80 &&
        Array.isArray(group.members) && group.members.length > 0 &&
        group.members.every(layer => layer && typeof layer.key === "string" && typeof layer.label === "string"));
}
