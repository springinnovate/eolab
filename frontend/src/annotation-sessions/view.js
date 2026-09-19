/** Session setup and management; polygon editing stays in Map layers. */
export class AnnotationSessionsView {
    /**
     * Build stable forms, a compact connected bar and optional session details.
     * @param {HTMLElement} root Annotation session section.
     * @param {Object} actions Session commands supplied by the controller.
     */
    constructor(root, actions) {
        this.root = root; this.document = root.ownerDocument; this.actions = actions;
        this.title = this.element("strong", "Annotation session");
        this.setup = this.element("div");
        this.choices = this.element("div"); this.choices.className = "annotation-session-actions";
        this.enterCode = this.button("Enter a code", () => this.showSetup("join"));
        this.startSession = this.button("Start a session", () => this.showSetup("create"));
        this.choices.append(this.enterCode, this.startSession);
        this.sessionName = this.input("Session name", 160, "Watershed planning");
        this.displayName = this.input("Your display name", 160, "Maria");
        this.code = this.input("Session code", 8, "ABCDEFGH");
        this.code.autocapitalize = "characters"; this.code.pattern = "[A-Za-z2-9]{8}";
        this.createForm = this.form(() => actions.create(this.sessionName.value.trim(), "Session owner"));
        this.create = this.element("button", "Start session"); this.create.type = "submit";
        this.createBack = this.button("Back", () => this.showSetup("choose"));
        this.createForm.append(this.field("Session name", this.sessionName, "Choose a name that tells contributors what this session is for."), this.create, this.createBack);
        this.joinForm = this.form(() => actions.join(this.code.value.trim(), this.displayName.value.trim()));
        this.join = this.element("button", "Join session"); this.join.type = "submit";
        this.joinBack = this.button("Back", () => this.showSetup("choose"));
        this.joinForm.append(this.field("Session code", this.code, "Enter the eight-character code from the session owner."),
            this.field("Your display name", this.displayName, "This name appears beside your annotations."), this.join, this.joinBack);
        this.recent = this.element("details");
        this.existing = this.element("select"); this.existing.setAttribute("aria-label", "Previously joined sessions");
        this.existing.addEventListener("change", () => { if (this.existing.value) actions.open(this.existing.value); });
        this.recent.append(this.element("summary", "Recent sessions"), this.existing); this.recent.hidden = true;
        this.setup.append(this.choices, this.createForm, this.joinForm, this.recent);

        this.session = this.element("div"); this.session.hidden = true;
        this.bar = this.element("div"); this.bar.className = "annotation-session-bar";
        this.heading = this.element("strong"); this.membership = this.element("span");
        this.copy = this.button("Copy invitation", actions.copy);
        this.bar.append(this.heading, this.membership);
        this.details = this.element("details"); this.details.append(this.element("summary", "Session details"));
        this.invitation = this.element("p"); this.expiry = this.element("p"); this.people = this.element("p");
        this.inviteActions = this.element("div");
        this.download = this.element("a", "Download annotations"); this.download.className = "secondary-button";
        this.extend = this.button("Keep for another day", actions.extend);
        this.show = this.button("Show contributions on map", actions.show);
        this.refresh = this.button("Refresh", actions.refresh);
        this.leave = this.button("Leave session", actions.leave);
        this.profileName = this.input("Your display name in this session", 160, "Maria");
        this.profileName.addEventListener("input", () => { this.profileDirty = true; });
        this.profileForm = this.form(() => actions.rename(this.profileName.value.trim()));
        this.saveName = this.element("button", "Save name"); this.saveName.type = "submit";
        this.profileForm.append(this.field("Your display name", this.profileName, "Changes the name beside your contributions in this session."), this.saveName);
        this.joiningControl = this.element("label"); this.joiningControl.className = "annotation-session-joining";
        this.allowContributors = this.element("input"); this.allowContributors.type = "checkbox";
        this.allowContributors.setAttribute("role", "switch"); this.allowContributors.setAttribute("aria-label", "Allow new contributors");
        this.allowContributors.addEventListener("change", () => actions.allowNewContributors(this.allowContributors.checked));
        this.joiningState = this.element("small"); this.joiningState.setAttribute("aria-hidden", "true");
        this.joiningControl.append(this.allowContributors, this.element("span", "Allow new contributors"), this.joiningState);
        this.layers = this.element("ul"); this.layers.className = "annotation-session-contributions"; this.layerRows = new Map();
        this.help = this.element("p", "Draw and edit polygons in Map layers. New layers and saved edits are shared automatically. Use Share for older local layers; unfinished polygons stay on this device. Leaving or removing a local layer keeps its last shared copy. Use Withdraw to remove that copy.");
        this.details.append(this.invitation, this.inviteActions, this.profileForm, this.people, this.layers,
            this.show, this.download, this.refresh, this.expiry, this.extend, this.joiningControl, this.leave, this.help);
        this.session.append(this.bar, this.details);
        this.status = this.element("p"); this.status.setAttribute("role", "status"); this.status.className = "annotation-session-status";
        root.append(this.title, this.setup, this.session, this.status);
        this.showSetup("choose", false);
    }

    /** @param {string} tag HTML tag. @param {string} [text=""] Plain text. @return {HTMLElement} New element. */
    element(tag, text = "") { const node = this.document.createElement(tag); node.textContent = text; return node; }

    /** Build a required text field with an accessible name and a whitespace check.
     * @param {string} label Accessible name. @param {number} maximum Character limit.
     * @param {string} placeholder Example input. @return {HTMLInputElement} Text field.
     */
    input(label, maximum, placeholder) {
        const input = this.element("input"); input.placeholder = placeholder; input.setAttribute("aria-label", label);
        input.maxLength = maximum; input.required = true; input.pattern = ".*\\S.*"; input.autocomplete = "off"; return input;
    }

    /** Place a visible label and explanation beside their input.
     * @param {string} label Visible label. @param {HTMLInputElement} input Field to wrap.
     * @param {string} help Short explanation. @return {HTMLLabelElement} Field group.
     */
    field(label, input, help) {
        const wrapper = this.element("label"); wrapper.className = "annotation-session-field";
        wrapper.append(this.element("span", label), input, this.element("small", help)); return wrapper;
    }

    /** Submit with Enter or the primary button after native form validation.
     * @param {()=>void} action Validated form action. @return {HTMLFormElement} Empty form.
     */
    form(action) {
        const form = this.element("form"); form.className = "annotation-session-form";
        form.addEventListener("submit", event => { event.preventDefault(); action(); }); return form;
    }

    /** @param {string} label Button text. @param {()=>void} action Click handler. @return {HTMLButtonElement} Button. */
    button(label, action) {
        const button = this.element("button", label); button.type = "button"; button.className = "secondary-button";
        button.addEventListener("click", action); return button;
    }

    /** Show one connection form, preserving typed values when switching or retrying.
     * @param {"choose"|"create"|"join"} mode Requested setup step.
     * @param {boolean} [focus=true] Focus the first relevant control after user navigation.
     * @return {void}
     */
    showSetup(mode, focus = true) {
        this.choices.hidden = mode !== "choose"; this.createForm.hidden = mode !== "create"; this.joinForm.hidden = mode !== "join";
        if (focus) (mode === "create" ? this.sessionName : mode === "join" ? this.code : this.enterCode).focus();
    }

    /** Open an invitation's join form without requiring the user to copy its code.
     * @param {string} code Validated invitation code. @return {void}
     */
    showInvitation(code) { this.code.value = code; this.showSetup("join", false); this.displayName.focus(); }

    /** Reveal session management following an explicit sharing action. @return {void} */
    showDetails() { this.details.open = true; }

    /** @param {Object[]} sessions Browser's unexpired memberships. @return {void} */
    memberships(sessions) {
        this.existing.replaceChildren(this.element("option", "Choose a session…")); this.existing.firstChild.value = "";
        for (const session of sessions) { const option = this.element("option", session.name); option.value = session.id; this.existing.append(option); }
        this.recent.hidden = sessions.length === 0;
    }

    /** Show status outside the disclosure so errors remain visible.
     * @param {string} text Visible status. @param {boolean} [error=false] Whether action is needed. @return {void}
     */
    message(text, error = false) { this.status.textContent = text; this.status.hidden = !text; this.status.classList.toggle("is-error", error); }

    /** @param {boolean} busy Whether membership is changing. @return {void} */
    busy(busy) {
        this.membershipBusy = busy;
        for (const control of [this.create, this.join, this.leave, this.existing, this.enterCode, this.startSession,
            this.createBack, this.joinBack, this.sessionName, this.code, this.displayName]) control.disabled = busy;
        this.allowContributors.disabled = busy || !!this.joiningBusy;
        this.setNameBusy(!!this.nameBusy);
    }

    /** @param {boolean} busy Whether the joining policy is being saved. @return {void} */
    setJoiningBusy(busy) { this.joiningBusy = busy; this.allowContributors.disabled = busy || !!this.membershipBusy; }

    /** @param {boolean} busy Whether a display-name change is in flight. @return {void} */
    setNameBusy(busy) { this.nameBusy = busy; this.saveName.disabled = this.profileName.disabled = busy || !!this.membershipBusy; }

    /** Accept a saved name without allowing background refresh to overwrite edits.
     * @param {string} name Name accepted by the server. @return {void}
     */
    nameSaved(name) { this.profileDirty = false; this.profileName.value = name; }

    /** Update membership and contribution rows without expanding details or replacing forms.
     * @param {Object|null} snapshot Authoritative metadata snapshot.
     * @param {Map<string,Object>} sharing Local upload state by layer identifier. @return {void}
     */
    render(snapshot, sharing) {
        this.setup.hidden = !!snapshot; this.session.hidden = !snapshot;
        if (this.sessionId !== snapshot?.id) {
            this.details.open = false; this.profileDirty = false;
            if (!snapshot) this.showSetup("choose", false);
        }
        this.sessionId = snapshot?.id;
        if (!snapshot) { this.layers.replaceChildren(); this.layerRows.clear(); return; }
        const member = snapshot.contributors.find(person => person.id === snapshot.contributorId);
        this.heading.textContent = snapshot.name;
        this.membership.textContent = snapshot.isOwner ? `${snapshot.contributors.length} ${snapshot.contributors.length === 1 ? "contributor" : "contributors"}` : `Joined as ${member?.name ?? "Contributor"}`;
        if (!this.profileDirty && !this.nameBusy) this.profileName.value = member?.name ?? "";
        const copyParent = snapshot.isOwner ? this.bar : this.inviteActions;
        if (this.copy.parentElement !== copyParent) copyParent.append(this.copy);
        this.invitation.textContent = `Session code: ${snapshot.joinCode} · ${snapshot.joinsOpen ? "Joining open" : "Joining closed"}`;
        this.expiry.textContent = `Available until ${new Date(snapshot.expiresAt).toLocaleString()}. Download a permanent copy before it expires.`;
        this.people.textContent = `Contributors: ${snapshot.contributors.map(person => person.name + (person.isOwner ? " (owner)" : "")).join(", ")}`;
        this.joiningControl.hidden = !snapshot.isOwner;
        if (!this.joiningBusy) this.allowContributors.checked = snapshot.joinsOpen;
        this.joiningState.textContent = snapshot.joinsOpen ? "On" : "Off";
        this.download.href = `/api/annotation-sessions/${snapshot.id}/export`;
        const keys = new Set();
        for (const layer of snapshot.layers) {
            const key = `${layer.contributorId}/${layer.layerId}`; keys.add(key);
            let row = this.layerRows.get(key);
            if (!row) {
                row = this.element("li"); row.label = this.element("span"); row.detail = this.element("small");
                row.withdraw = this.button("Withdraw", () => this.actions.withdraw(layer.layerId));
                row.append(row.label, row.detail, row.withdraw); this.layerRows.set(key, row); this.layers.append(row);
            }
            const author = snapshot.contributors.find(person => person.id === layer.contributorId);
            row.label.textContent = `${author?.name ?? "Contributor"} · ${layer.name}`;
            const local = layer.contributorId === snapshot.contributorId ? sharing.get(layer.layerId) : null;
            row.detail.textContent = `${layer.polygonCount} polygons · ${local?.message ?? `Updated ${new Date(layer.updatedAt).toLocaleTimeString()}`}`;
            row.withdraw.hidden = layer.contributorId !== snapshot.contributorId; row.withdraw.disabled = !!local?.sending;
        }
        for (const [key, row] of this.layerRows) if (!keys.has(key)) { row.remove(); this.layerRows.delete(key); }
    }
}
