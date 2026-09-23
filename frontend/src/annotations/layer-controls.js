/** Retained editing controls displayed in the annotation panel. */
import { matchingAnnotationPolygons } from "./model.js";

/** Present one local annotation layer and forward edits to its owner. */
export class AnnotationLayerControls {
    /**
     * Build stable layer controls; notes and names are always plain text.
     * @param {Document} document Browser document.
     * @param {import("./model.js").AnnotationLayer} layer Annotation data.
     * @param {Object} actions Editing intents handled by the layer owner.
     * @param {()=>void} actions.open Reveal this layer in the annotation panel.
     * @param {()=>void} actions.add Start drawing a polygon.
     * @param {(id:string)=>void} actions.edit Edit a saved polygon.
     * @param {()=>void} actions.filter Open the layer filter.
     * @param {(id:string)=>void} actions.removePolygon Delete a polygon with Undo.
     * @param {(rebuild?:boolean)=>void} actions.change Save changed fields and update the map.
     * @param {(opacity:number)=>void} actions.opacity Set the whole layer's opacity.
     * @param {()=>void} actions.exportGeoJSON Download the saved polygons.
     * @param {()=>void} actions.share Share this layer in a session.
     * @param {(color:string)=>void} actions.color Save your shared polygon color.
     */
    constructor(document, layer, actions) {
        this.document = document;
        this.layer = layer;
        this.actions = actions;
        this.root = document.createElement("div");
        this.root.className = "annotation-layer-controls";
        this.name = this.createLabeledInput("Layer name", "text", layer.name, value => {
            layer.name = value.trim() || "Annotations";
            actions.change(false);
        }, 160);
        this.root.append(this.name);
        const buttons = document.createElement("div");
        buttons.className = "annotation-actions";
        this.edit = this.button("Edit", actions.open);
        this.edit.setAttribute("aria-controls", "annotations-panel");
        this.draw = this.button("Draw polygon", actions.add);
        this.draw.classList.add("annotation-draw-button");
        this.draw.title = "Draw a polygon on the map";
        const drawIcon = document.createElement("span");
        drawIcon.className = "annotation-draw-icon";
        drawIcon.setAttribute("aria-hidden", "true");
        this.draw.prepend(drawIcon);
        this.drawing = document.createElement("div"); this.drawing.className = "annotation-drawing-action";
        this.members = this.details("Contributors"); this.members.className = "shared-annotation-members"; this.members.hidden = true;
        this.memberList = document.createElement("ul"); this.members.append(this.memberList);
        this.sharedStatus = document.createElement("span"); this.sharedStatus.className = "shared-annotation-status"; this.sharedStatus.setAttribute("role", "status");
        this.drawing.append(this.draw, this.members, this.sharedStatus);
        this.share = this.button("Share", actions.share);
        this.share.title = "Share this layer's saved polygons, names and notes in an annotation session.";
        buttons.append(this.share);
        const exportButton = this.button("Export GeoJSON", actions.exportGeoJSON);
        exportButton.title = "Download all saved polygons, names and notes in this layer, including filtered-out polygons. Save unfinished edits first to include them.";
        buttons.append(exportButton);
        this.root.append(buttons);
        this.appearance = this.details("Annotation style");
        this.sharedAppearance = document.createElement("fieldset");
        this.localAppearance = document.createElement("fieldset");
        for (const [group, label] of [[this.sharedAppearance, "Shared with everyone"], [this.localAppearance, "Your view only"]]) {
            group.className = "annotation-style-group";
            const legend = document.createElement("legend");
            legend.textContent = label;
            legend.hidden = true;
            group.append(legend);
            this.appearance.append(group);
        }
        this.styleInputs = {};
        for (const [key, label, type] of [["color", "Fill color", "color"], ["outline", "Outline color", "color"],
            ["weight", "Outline width", "number"], ["fillOpacity", "Fill opacity", "number"], ["labels", "Show names", "checkbox"], ["notes", "Show notes", "checkbox"]]) {
            const wrapper = this.createLabeledInput(label, type, layer.style[key], value => {
                if (key === "color" && this.collaborating) { actions.color(value); return; }
                layer.style[key] = type === "number" ? Number(value) : value;
                if (key === "color") for (const polygon of layer.polygons) delete polygon.contributorColor;
                actions.change();
            });
            const input = wrapper.querySelector("input");
            if (type === "number") { input.min = "0"; input.max = key === "weight" ? "10" : "1"; input.step = key === "weight" ? "0.5" : "0.05"; }
            if (key === "notes") wrapper.title = "Show notes on the map. Long notes show the first six lines; the complete note stays in the polygon list.";
            this.styleInputs[key] = input;
            (key === "color" ? this.sharedAppearance : this.localAppearance).append(wrapper);
        }
        const opacity = this.createLabeledInput("Layer opacity", "range", layer.opacity, value => actions.opacity(Number(value)));
        this.opacity = opacity.querySelector("input");
        this.opacity.min = "0"; this.opacity.max = "1"; this.opacity.step = "0.05";
        this.localAppearance.append(opacity);
        this.filter = this.details("Filter polygons");
        this.filter.append(this.button("Edit filter", actions.filter));
        if (typeof layer.filter === "string" && layer.filter) {
            const legacy = this.createLabeledInput("Saved text search (clear before using field conditions)", "search", layer.filter, value => {
                layer.filter = value;
                actions.change();
            }, 300);
            this.legacySearch = legacy;
            this.filter.append(legacy);
        }
        this.polygons = this.details("Polygons");
        this.polygons.open = true;
        this.polygonList = document.createElement("ul");
        this.polygons.append(this.polygonList);
        this.root.append(this.appearance, this.filter, this.polygons);
        this.refresh();
    }

    /**
     * Create a label containing text and an input, and connect valid edits to onChange.
     * Text fields notify while typing; other input types notify on change.
     * The label text is inserted as plain text, never HTML.
     * @param {string} label Accessible and visible label.
     * @param {string} type HTML input type.
     * @param {string|number|boolean} value Initial value.
     * @param {(value:string|boolean)=>void} onChange Receives the edited value, or checked state for a checkbox.
     * @param {number} [maxLength=300] Text limit.
     * @return {HTMLLabelElement} Wrapper containing the visible label text and its input.
     */
    createLabeledInput(label, type, value, onChange, maxLength = 300) {
        const wrapper = this.document.createElement("label");
        wrapper.className = "annotation-field";
        const text = this.document.createElement("span");
        text.textContent = label;
        const input = this.document.createElement("input");
        input.type = type;
        input.maxLength = maxLength;
        if (type === "checkbox") input.checked = value;
        else input.value = value;
        input.addEventListener(type === "text" ? "input" : "change", () => {
            if (input.validity && !input.validity.valid) { input.reportValidity(); return; }
            onChange(type === "checkbox" ? input.checked : input.value);
        });
        wrapper.append(text, input);
        return wrapper;
    }

    /**
     * Create a layer action button.
     * @param {string} text Visible action.
     * @param {()=>void} onClick Action callback.
     * @return {HTMLButtonElement} Button.
     */
    button(text, onClick) {
        const button = this.document.createElement("button");
        button.type = "button";
        button.className = "secondary-button";
        button.textContent = text;
        button.addEventListener("click", onClick);
        return button;
    }

    /**
     * Create an initially collapsed disclosure.
     * @param {string} text Disclosure heading.
     * @return {HTMLDetailsElement} Disclosure.
     */
    details(text) {
        const details = this.document.createElement("details");
        const summary = this.document.createElement("summary");
        summary.textContent = text;
        details.append(summary);
        return details;
    }

    /**
     * Refresh polygon rows and appearance after a committed edit or undo.
     * @param {string|null} [focusPolygon=null] Polygon whose name should receive focus.
     * @return {void}
     */
    refresh(focusPolygon = null) {
        this.name.querySelector("input").value = this.layer.name;
        for (const [key, input] of Object.entries(this.styleInputs)) {
            if (input.type === "checkbox") input.checked = this.layer.style[key];
            else input.value = this.layer.style[key];
        }
        this.opacity.value = this.layer.opacity;
        if (this.legacySearch) this.legacySearch.hidden = typeof this.layer.filter !== "string";
        const polygons = matchingAnnotationPolygons(this.layer);
        const filtered = typeof this.layer.filter === "string" ? !!this.layer.filter : this.layer.filter.enabled && !!this.layer.filter.rules.length;
        this.polygons.querySelector("summary").textContent = (this.collaborating ? "Your polygons · " : "") + (filtered
            ? `${polygons.length} of ${this.layer.polygons.length} polygons` : `${polygons.length} ${polygons.length === 1 ? "polygon" : "polygons"}`);
        this.polygonList.replaceChildren(...polygons.map(polygon => this.polygonRow(polygon)));
        if (!polygons.length) {
            const empty = this.document.createElement("li");
            empty.textContent = filtered ? "No polygons match the filter." : "Draw a polygon on the map, then give it a name or note. Saved changes are shared automatically when this layer is in a session.";
            this.polygonList.append(empty);
        }
        if (focusPolygon) {
            this.polygons.open = true;
            this.polygonList.querySelector(`[data-polygon-id="${focusPolygon}"] input`)?.focus();
        }
    }

    /** Show contributor details and separate shared color from local appearance controls.
     * Peer polygons remain read-only; local opacity affects everyone's polygons only on this map.
     * @param {Object} data Contributor list, code and sharing status supplied by composition.
     * @param {Object[]} polygons Other contributors' polygons, never editable here.
     * @return {void}
     */
    setCollaboration(data, polygons) {
        this.sharedAppearance.hidden = data.canContribute === false;
        if (!this.collaborating) {
            this.collaborating = true;
            this.appearance.classList.add("has-shared-color");
            this.sharedAppearance.querySelector("legend").hidden = false;
            this.localAppearance.querySelector("legend").hidden = false;
            this.styleInputs.fillOpacity.parentElement.querySelector("span").textContent = "Layer fill opacity (your view)";
            this.styleInputs.fillOpacity.parentElement.title = "Fades the fill of all polygons in this layer on your map. Other viewers are unaffected.";
            this.refresh();
        }
        const colorInput = this.styleInputs.color;
        colorInput.parentElement.querySelector("span").textContent = "Your polygon color";
        colorInput.value = data.contributors.find(person => person.own)?.color ?? this.layer.style.color;
        colorInput.parentElement.title = "Shared with everyone. Changes the fill of all your polygons in this layer. Other appearance controls affect only your map.";
        this.members.hidden = false;
        if (this.share.parentElement !== this.drawing) this.drawing.insertBefore(this.share, this.members);
        this.share.title = data.code ? `Copy share code: ${data.code}` : "Copy this layer's sharing code";
        this.name.querySelector("input").disabled = true;
        this.sharedStatus.textContent = data.status;
        this.sharedStatus.classList.toggle("is-error", !!data.error);
        const people = JSON.stringify(data.contributors);
        if (this.peopleSignature !== people) {
            this.peopleSignature = people;
            this.members.querySelector("summary").textContent = `${data.contributors.length} ${data.contributors.length === 1 ? "contributor" : "contributors"}`;
            this.memberList.replaceChildren(...data.contributors.map(person => {
                const row = this.document.createElement("li");
                const swatch = this.document.createElement("span");
                swatch.className = "annotation-contributor-color";
                swatch.style.backgroundColor = person.color;
                swatch.setAttribute("aria-hidden", "true");
                row.append(swatch, `${person.name}${person.own ? " (you)" : ""} · ${person.polygonCount} ${person.polygonCount === 1 ? "polygon" : "polygons"}`); return row;
            }));
        }
        if (!this.remotePolygons) { this.remotePolygons = this.details("Other contributors' polygons"); this.root.append(this.remotePolygons); }
        if (this.receivedPolygons !== polygons) {
            this.receivedPolygons = polygons;
            const list = this.document.createElement("ul");
            for (const polygon of polygons) {
                const row = this.document.createElement("li"); row.textContent = `${polygon.name} — ${polygon.contributor}${polygon.note ? `: ${polygon.note}` : ""}`; list.append(row);
            }
            this.remotePolygons.replaceChildren(this.remotePolygons.querySelector("summary"), list);
            this.remotePolygons.hidden = polygons.length === 0;
        }
    }

    /** Bring the drawing action into view after the user connects to a session.
     * @return {void}
     */
    revealDrawing() {
        this.draw.scrollIntoView({ block: "nearest" });
        this.draw.focus({ preventScroll: true });
    }

    /**
     * Render a polygon's name, geometry actions and optional text note.
     * @param {import("./model.js").AnnotationPolygon} polygon Saved polygon.
     * @return {HTMLLIElement} Annotation row.
     */
    polygonRow(polygon) {
        const row = this.document.createElement("li");
        row.dataset.polygonId = polygon.id;
        const name = this.createLabeledInput("Polygon name", "text", polygon.name, value => {
            polygon.name = value.trim() || "Polygon";
            this.actions.change(false);
        }, 160);
        const actions = this.document.createElement("div");
        actions.className = "annotation-actions";
        const note = this.document.createElement("label");
        note.className = "annotation-field";
        note.hidden = !polygon.note;
        const label = this.document.createElement("span");
        label.textContent = "Note";
        const textarea = this.document.createElement("textarea");
        textarea.rows = 3;
        textarea.maxLength = 10000;
        textarea.value = polygon.note;
        textarea.addEventListener("input", () => { polygon.note = textarea.value; this.actions.change(false); });
        note.append(label, textarea);
        actions.append(this.button("Edit", () => this.actions.edit(polygon.id)), this.button(polygon.note ? "Edit note" : "Add note", () => {
            note.hidden = false; textarea.focus();
        }), this.button("Delete", () => this.actions.removePolygon(polygon.id)));
        row.append(name, actions, note);
        return row;
    }

    /**
     * Expand and focus a requested control after the owner reveals this layer in the annotation panel.
     * @param {"style"|"filter"|"info"} control Requested control.
     * @return {void}
     */
    open(control) {
        const details = control === "style" ? this.appearance : control === "filter" ? this.filter : this.polygons;
        details.open = true;
        details.scrollIntoView({ block: "nearest" });
        (details.querySelector("input") ?? details.querySelector("summary"))?.focus();
    }
}
