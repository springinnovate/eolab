/** Connect to a shared annotation layer or change your contributor name. */
export class AnnotationSessionsView {
    /** Build the connection/name dialog and wire Map layers actions.
     * @param {Document} document Browser document.
     * @param {Object} actions Commands supplied by the session controller.
     * @param {(mode:string,value:string,name:string,localId:string|null)=>Promise<void>} actions.connect Create or join a shared layer.
     * @param {(localId:string,name:string)=>Promise<void>} actions.rename Save your contributor name.
     */
    constructor(document, actions) {
        this.document = document;
        this.dialog = document.createElement("dialog");
        this.dialog.className = "shared-annotation-dialog";
        this.heading = document.createElement("h2"); this.heading.id = "shared-annotation-dialog-title";
        this.dialog.setAttribute("aria-labelledby", this.heading.id);
        this.form = document.createElement("form");
        this.layerName = this.field("Layer name", 160);
        this.code = this.field("Share code", 8); this.code.input.autocapitalize = "characters";
        this.name = this.field("Your name", 160);
        this.help = document.createElement("p");
        this.status = document.createElement("p"); this.status.setAttribute("role", "status");
        this.submit = document.createElement("button"); this.submit.type = "submit";
        this.cancel = document.createElement("button"); this.cancel.type = "button"; this.cancel.textContent = "Cancel";
        this.cancel.addEventListener("click", () => this.dialog.close());
        this.form.append(this.layerName, this.code, this.name, this.help, this.status, this.submit, this.cancel);
        this.form.addEventListener("submit", event => {
            event.preventDefault();
            if (this.mode === "rename") { void actions.rename(this.localId, this.name.input.value.trim()); return; }
            void actions.connect(this.mode, this.mode === "create" ? this.layerName.input.value.trim() : this.code.input.value.trim(), this.name.input.value.trim(), this.localId);
        });
        this.dialog.append(this.heading, this.form); document.body.append(this.dialog);
        document.querySelector("#create-shared-annotation-layer").addEventListener("click", () => this.open("create"));
        document.querySelector("#join-shared-annotation-layer").addEventListener("click", () => this.open("join"));
    }

    /** Create a required, visibly labeled text field.
     * @param {string} label Field label. @param {number} maximum Maximum characters.
     * @return {HTMLLabelElement & {input:HTMLInputElement}} Label with its input.
     */
    field(label, maximum) {
        const wrapper = this.document.createElement("label");
        const text = this.document.createElement("span"); text.textContent = label;
        wrapper.input = this.document.createElement("input"); wrapper.input.required = true;
        wrapper.input.maxLength = maximum; wrapper.input.pattern = ".*\\S.*";
        wrapper.append(text, wrapper.input); return wrapper;
    }

    /** Open a connection form or a prefilled contributor-name form.
     * @param {"create"|"join"|"contribute"|"rename"} mode Form purpose; contribute uses the map's fixed invitation.
     * @param {string|null} [localId=null] Local layer to share or rename yourself in.
     * @param {string} [value=""] Layer name, invitation code, or current contributor name.
     * @return {void}
     */
    open(mode, localId = null, value = "") {
        this.mode = mode; this.localId = localId;
        this.layerName.hidden = mode !== "create"; this.layerName.input.disabled = mode !== "create";
        this.code.hidden = mode !== "join"; this.code.input.disabled = mode !== "join";
        const field = mode === "create" ? this.layerName.input : this.code.input; field.value = value;
        this.heading.textContent = mode === "create" ? "Create shared annotation layer" : mode === "contribute" ? "Your name for this annotation layer" : "Join shared annotation layer";
        this.submit.textContent = mode === "create" ? "Create layer" : mode === "contribute" ? "Join and draw polygon" : "Join layer";
        this.help.textContent = mode === "rename" ? "Changes your name only in this shared layer. Your polygons and editing access stay the same."
            : "Everyone with the code can join and see all polygons. You can edit only your own polygons.";
        if (mode === "rename") {
            this.name.input.value = value;
            this.heading.textContent = "Change your name";
            this.submit.textContent = "Save name";
        }
        this.message(""); this.dialog.showModal(); (value ? this.name.input : field).focus();
    }

    /** Show a request error without clearing entered values.
     * @param {string} text User-facing status. @return {void}
     */
    message(text) { this.status.textContent = text; }

    /** Keep the dialog open while a request is pending.
     * @param {boolean} busy Whether a request is pending. @return {void}
     */
    busy(busy) {
        this.submit.disabled = this.cancel.disabled = busy;
        this.dialog.oncancel = busy ? event => event.preventDefault() : null;
    }

    /** Close after the connection or name change succeeds. @return {void} */
    connected() { this.dialog.close(); }
}
