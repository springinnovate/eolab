/** Stable left-panel controls for contributors and session owners. */

/** Present session membership, contribution status and invitation/download controls. */
export class AnnotationSessionsView {
    /**
     * Build controls once so status refreshes do not disturb text input or focus.
     * @param {HTMLElement} root Empty Shared annotations details element.
     * @param {Object} actions Controller callbacks for user actions.
     */
    constructor(root, actions) {
        this.root = root;
        this.document = root.ownerDocument;
        this.actions = actions;
        this.summary = this.element("summary", "Shared annotations");
        this.status = this.element("p", ""); this.status.setAttribute("role", "status");
        this.status.className = "annotation-session-status";
        this.setup = this.element("div"); this.setup.className = "annotation-session-fields";
        this.displayName = this.input("Your name", 160);
        this.sessionName = this.input("Session name", 160);
        this.code = this.input("Join code", 8); this.code.autocapitalize = "characters";
        this.create = this.button("Create session", () => actions.create(this.sessionName.value, this.displayName.value));
        this.join = this.button("Join session", () => actions.join(this.code.value, this.displayName.value));
        this.setup.append(this.displayName, this.sessionName, this.create, this.code, this.join);
        this.existing = this.element("select"); this.existing.setAttribute("aria-label", "Previously joined sessions");
        this.existing.addEventListener("change", () => { if (this.existing.value) actions.open(this.existing.value); });
        this.setup.append(this.existing);
        this.session = this.element("div"); this.session.hidden = true;
        this.heading = this.element("strong"); this.invitation = this.element("p");
        this.expiry = this.element("p"); this.people = this.element("p");
        this.copy = this.button("Copy invitation", actions.copy);
        this.download = this.element("a", "Download annotations"); this.download.className = "secondary-button";
        this.extend = this.button("Keep for another day", actions.extend);
        this.show = this.button("Show contributions on map", actions.show);
        this.refresh = this.button("Refresh", actions.refresh);
        this.leave = this.button("Leave session", actions.leave);
        this.closeJoining = this.button("Close joining", actions.toggleJoining);
        this.layers = this.element("ul"); this.layers.className = "annotation-session-contributions";
        this.layerRows = new Map();
        this.help = this.element("p", "Use Share on an annotation layer below. Saved edits are shared automatically; unfinished polygons stay on this device. Leaving or removing a local layer keeps its last shared copy. Use Withdraw to remove that copy.");
        const options = this.element("details");
        options.append(this.element("summary", "Session options and saving"), this.extend, this.closeJoining, this.leave, this.help);
        this.session.append(this.heading, this.invitation, this.copy, this.people, this.layers,
            this.show, this.download, this.refresh, this.expiry, options);
        root.append(this.summary, this.setup, this.session, this.status);
    }

    /** @param {string} tag HTML tag. @param {string} [text=""] Plain text. @return {HTMLElement} New element. */
    element(tag, text = "") { const node = this.document.createElement(tag); node.textContent = text; return node; }

    /** @param {string} label Accessible input label. @param {number} maximum Maximum text length. @return {HTMLInputElement} Text input. */
    input(label, maximum) {
        const input = this.element("input"); input.placeholder = label; input.setAttribute("aria-label", label);
        input.maxLength = maximum; input.autocomplete = "off"; return input;
    }

    /** @param {string} label Button text. @param {()=>void} action Click handler. @return {HTMLButtonElement} Button. */
    button(label, action) {
        const button = this.element("button", label); button.type = "button"; button.className = "secondary-button";
        button.addEventListener("click", action); return button;
    }

    /** @param {Object[]} sessions Browser's unexpired memberships. @return {void} */
    memberships(sessions) {
        this.existing.replaceChildren(this.element("option", "Reopen a session…"));
        this.existing.firstChild.value = "";
        for (const session of sessions) { const option = this.element("option", session.name); option.value = session.id; this.existing.append(option); }
        this.existing.hidden = sessions.length === 0;
    }

    /** @param {string} text Visible status. @param {boolean} [error=false] Whether action is needed. @return {void} */
    message(text, error = false) { this.status.textContent = text; this.status.classList.toggle("is-error", error); }

    /** @param {boolean} busy Whether membership is changing. @return {void} */
    busy(busy) { for (const button of [this.create, this.join, this.leave]) button.disabled = busy; this.existing.disabled = busy; }

    /**
     * Update session text and retain contribution row nodes between polls.
     * @param {Object|null} snapshot Authoritative metadata snapshot.
     * @param {Map<string,Object>} sharing Local upload state by layer identifier.
     * @return {void}
     */
    render(snapshot, sharing) {
        this.setup.hidden = !!snapshot; this.session.hidden = !snapshot;
        this.summary.textContent = snapshot ? `Shared annotations · ${snapshot.name}` : "Shared annotations";
        if (!snapshot) { this.layers.replaceChildren(); this.layerRows.clear(); return; }
        this.heading.textContent = snapshot.name;
        this.invitation.textContent = `Join code: ${snapshot.joinCode} · ${snapshot.joinsOpen ? "Joining open" : "Joining closed"}`;
        this.expiry.textContent = `Available until ${new Date(snapshot.expiresAt).toLocaleString()}. Download a permanent copy before it expires.`;
        this.people.textContent = `${snapshot.contributors.length} contributors: ${snapshot.contributors.map(person => person.name + (person.isOwner ? " (owner)" : "")).join(", ")}`;
        this.closeJoining.hidden = !snapshot.isOwner;
        this.closeJoining.textContent = snapshot.joinsOpen ? "Close joining" : "Open joining";
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
            row.withdraw.hidden = layer.contributorId !== snapshot.contributorId;
            row.withdraw.disabled = !!local?.sending;
        }
        for (const [key, row] of this.layerRows) if (!keys.has(key)) { row.remove(); this.layerRows.delete(key); }
    }
}
