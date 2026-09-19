/** Own session membership, contribution synchronization and refresh scheduling. */
import { AnnotationSessionsApi } from "./api.js";
import { AnnotationSessionsView } from "./view.js";

const STORAGE_KEY = "eolab-annotation-session";

/**
 * Manage the annotation session open in this browser tab.
 * Creates, joins and reopens sessions; uploads saved changes to shared layers;
 * and refreshes other contributors' layers on the map. Reports connection,
 * revision-conflict and expiration errors through the session panel.
 * Local polygon editing and device storage remain owned by Annotations.
 */
export class AnnotationSessionsController {
    /**
     * Connect session controls without importing the annotation editor or layer stack.
     * @param {Object} options Feature dependencies.
     * @param {HTMLElement} options.root Shared annotations disclosure.
     * @param {()=>string} options.createLayer Add an empty local annotation layer and return its identifier.
     * @param {()=>{id:string,collection:Object}[]} options.getLayers Committed, device-saved layers.
     * @param {(id:string,label:string)=>void} options.setShareLabel Local layer status callback.
     * @param {(key:string,label:string,collection:Object)=>void} options.showLayer Read-only contribution presentation.
     * @param {(keys:Set<string>)=>void} options.retainLayers Remove displayed contributions outside this set.
     * @param {AnnotationSessionsApi} [options.api] Same-origin API.
     * @param {Storage} [options.storage] Small local synchronization bookmarks; never credentials.
     * @param {function(HTMLElement,Object):Object} [options.createView] Testable view factory.
     */
    constructor({ root, createLayer, getLayers, setShareLabel, showLayer, retainLayers,
        api = new AnnotationSessionsApi(), storage = globalThis.localStorage,
        createView = (element, actions) => new AnnotationSessionsView(element, actions) }) {
        Object.assign(this, { root, createLayer, getLayers, setShareLabel, showLayer, retainLayers, api, storage });
        this.snapshot = null; this.sharing = new Map(); this.generation = 0; this.refreshing = false;
        this.visibleContributions = new Map(); this.showContributions = false; this.closed = false;
        this.delay = 5000; this.timer = null; this.debounce = null; this.transitioning = false;
        this.view = createView(root, {
            create: (name, contributorName) => void this.openSession("", { name, contributorName }),
            join: (joinCode, contributorName) => void this.openSession("/join", { joinCode, contributorName }),
            open: id => void this.openSession(`/${id}`),
            copy: () => void this.copyInvitation(),
            extend: () => void this.applySessionAction("extend"),
            allowNewContributors: allowed => void this.setAllowNewContributors(allowed),
            show: () => { this.showContributions = true; this.visibleContributions.clear(); void this.refreshSession(); },
            refresh: () => { for (const state of this.sharing.values()) if (!state.conflict) state.paused = false; void this.sendChangedLayers(); void this.refreshSession(); },
            leave: () => void this.leave(),
            withdraw: id => void this.stopSharingLayer(id),
        });
        this.onPageHide = () => this.destroy();
        globalThis.addEventListener?.("pagehide", this.onPageHide);
    }

    /**
     * Restore an existing membership or prefill an invitation without joining automatically.
     * @return {Promise<void>} Completion with any connection failure shown in the panel.
     */
    async start() {
        try {
            const sessions = await this.api.request();
            if (this.closed) return;
            this.view.memberships(sessions);
            const code = new URL(globalThis.location?.href ?? "https://localhost").searchParams.get("annotationSession");
            if (code && /^[A-Z2-9]{8}$/i.test(code)) {
                const joined = sessions.find(session => session.joinCode === code.toUpperCase());
                if (joined) { await this.openSession(`/${joined.id}`); return; }
                this.view.code.value = code.toUpperCase(); this.root.open = true;
                this.view.message("Enter your name, then join the annotation session."); return;
            }
            const saved = this.readBookmark();
            if (saved?.sessionId && sessions.some(session => session.id === saved.sessionId)) await this.openSession(`/${saved.sessionId}`);
            else this.view.message("Create or join a session to share annotation layers on this EOLab site.");
        } catch (error) { this.view.message(error.message, true); }
    }

    /** @return {Object|null} Validated synchronization bookmark, or null if unavailable. */
    readBookmark() {
        try {
            const value = JSON.parse(this.storage.getItem(STORAGE_KEY));
            if (!value || typeof value.sessionId !== "string" || !Array.isArray(value.layers)) return null;
            if (value.layers.length > 32 || value.layers.some(layer => typeof layer.id !== "string" || !Number.isSafeInteger(layer.revision) || layer.revision < 0)) return null;
            return value;
        } catch { return null; }
    }

    /** Save only identifiers and acknowledged revisions; polygon data remains in Annotations. @return {void} */
    rememberSharingRevisions() {
        try {
            if (!this.snapshot) this.storage.removeItem(STORAGE_KEY);
            else this.storage.setItem(STORAGE_KEY, JSON.stringify({ sessionId: this.snapshot.id,
                layers: [...this.sharing].map(([id, state]) => ({ id, revision: state.revision })) }));
        } catch { this.view.message("Shared changes are saved on the server, but this browser cannot remember sharing after reload.", true); }
    }

    /**
     * Create, join, or reopen a session after existing uploads finish.
     * Explicit create/join actions add a local layer when none belongs to this session;
     * reopening after reload never creates another layer.
     * @param {string} path API command path or existing session identifier path.
     * @param {Object} [body] Create/join form values; absent when reopening.
     * @return {Promise<void>} Completion with errors shown beside the controls.
     */
    async openSession(path, body) {
        if (this.transitioning || this.closed) return;
        this.transitioning = true; this.view.busy(true); this.view.message("Connecting…");
        try {
            const snapshot = await this.api.request(path, body ? "POST" : "GET", body);
            if (this.closed) return;
            await this.stopUploads();
            this.snapshot = snapshot; this.sharing.clear(); this.visibleContributions.clear(); this.retainLayers(new Set());
            this.showContributions = snapshot.isOwner;
            const bookmark = this.readBookmark();
            if (bookmark?.sessionId === snapshot.id) for (const layer of bookmark.layers) {
                this.sharing.set(layer.id, { revision: layer.revision, sent: null, sending: null, message: "Checking shared copy…" });
            }
            const localIds = new Set(this.getLayers().map(layer => layer.id));
            for (const layer of snapshot.layers) {
                if (layer.contributorId === snapshot.contributorId && localIds.has(layer.layerId) && !this.sharing.has(layer.layerId)) {
                    // Without an acknowledged revision, accept only identical content;
                    // the server rejects a changed local copy instead of overwriting edits.
                    this.trackSharedLayer(layer.layerId, 0);
                }
            }
            this.rememberSharingRevisions(); this.root.open = true;
            this.view.render(snapshot, this.sharing);
            this.view.message("New annotation layers are shared with this session automatically. Add a polygon to get started.");
            await this.refreshSession();
            if (body && this.snapshot?.id === snapshot.id && ![...this.sharing.keys()].some(id => localIds.has(id))) {
                this.trackSharedLayer(this.createLayer(), 0);
            }
        } catch (error) { this.view.message(error.message, true); }
        finally { this.transitioning = false; this.view.busy(false); if (this.snapshot) this.committedLayersChanged(); }
    }

    /**
     * Begin sharing one local layer, using its saved revision on reconnect.
     * @param {string} id Local annotation layer identifier.
     * @return {void}
     */
    shareLayer(id) {
        this.root.open = true;
        if (this.transitioning) return;
        if (!this.snapshot) { this.view.message("Create or join a session, then click Share on this layer."); return; }
        const previous = this.sharing.get(id);
        if (previous && !previous.conflict) { this.view.message("Saved edits to this layer are shared automatically. Use Withdraw below to remove the shared copy."); return; }
        const existing = this.snapshot.layers.find(layer => layer.contributorId === this.snapshot.contributorId && layer.layerId === id);
        // This explicit Share action may replace the last observed shared copy.
        // Automatic reconnects instead retain their acknowledged revision above.
        this.trackSharedLayer(id, existing?.revision ?? 0);
        void this.sendChangedLayers();
    }

    /**
     * Remember a layer's sharing intent without uploading its unsaved contents.
     * @param {string} id Local annotation layer identifier.
     * @param {number} revision Last acknowledged revision, or zero for a new contribution.
     * @return {void}
     */
    trackSharedLayer(id, revision) {
        this.sharing.set(id, { revision, sent: null, sending: null, message: "Waiting for saved changes…" });
        this.setShareLabel(id, "Sharing…"); this.rememberSharingRevisions();
    }

    /**
     * Automatically share a newly created or imported layer with the active session.
     * Existing layers, restored layers and unfinished polygon drafts do not trigger this callback.
     * @param {string} id New local annotation layer identifier.
     * @return {void} The next successful local save schedules its first upload.
     */
    annotationLayerCreated(id) {
        if (!this.snapshot || this.closed || this.transitioning) return;
        this.trackSharedLayer(id, 0);
    }

    /** Debounce uploads after successful local saves; editor drafts never enter this callback. @return {void} */
    committedLayersChanged() {
        clearTimeout(this.debounce);
        if (!this.snapshot || this.closed || this.transitioning) return;
        this.debounce = setTimeout(() => void this.sendChangedLayers(), 600);
    }

    /**
     * Send each changed layer serially, coalescing further edits while a request is in flight.
     * @return {Promise<void>} Completion after current changed layers are acknowledged or fail.
     */
    async sendChangedLayers() {
        if (!this.snapshot || this.closed || this.transitioning) return;
        const generation = this.generation;
        for (const [id, state] of this.sharing) {
            if (state.sending || state.paused) continue;
            state.sending = this.uploadLayer(id, state, generation);
            await state.sending;
            state.sending = null;
            if (generation !== this.generation || this.closed) return;
        }
        this.view.render(this.snapshot, this.sharing);
    }

    /**
     * Upload the newest saved content until this layer has caught up.
     * @param {string} id Local layer identifier.
     * @param {Object} state Acknowledged revision and synchronization state.
     * @param {number} generation Session transition guard.
     * @return {Promise<void>} Completion; network errors leave the latest local version available for retry.
     */
    async uploadLayer(id, state, generation) {
        while (generation === this.generation && !this.closed && this.snapshot && !state.paused) {
            const layer = this.getLayers().find(layer => layer.id === id);
            if (!layer) { state.message = state.revision === 0 ? "Waiting for this layer to be saved on the device" : "Local layer removed; last shared copy kept"; return; }
            const text = JSON.stringify(layer.collection);
            if (text === state.sent) return;
            this.setShareLabel(id, "Sharing…"); state.message = "Sending…";
            try {
                const accepted = await this.api.request(`/${this.snapshot.id}/layers/${id}`, "PUT", { revision: state.revision, collection: layer.collection });
                state.revision = accepted.revision; state.sent = text; state.message = "Saved";
                if (generation !== this.generation || this.closed) return;
                this.rememberSharingRevisions(); this.setShareLabel(id, "Shared · Saved");
                this.view.message("All sent changes are saved in the session.");
            } catch (error) {
                if (generation !== this.generation || this.closed) return;
                state.conflict = error.status === 409;
                state.paused = !!error.status && error.status < 500;
                state.message = state.conflict
                    ? "This shared layer changed in another tab. Refresh, then use Share local version to replace it with this device's copy."
                    : state.paused ? error.message : "Connection interrupted — changes saved on this device";
                this.setShareLabel(id, state.conflict ? "Share local version" : state.paused ? "Sharing needs attention" : "Shared · Offline");
                this.view.message(state.message, true); return;
            }
        }
    }

    /**
     * Refresh authoritative metadata and only fetch changed displayed contributions.
     * A failed poll backs off and retries; a missing membership clears remote presentation.
     * @return {Promise<void>} Completion of one refresh, with a later refresh scheduled.
     */
    async refreshSession() {
        if (!this.snapshot || this.refreshing || this.closed) return;
        clearTimeout(this.timer); this.refreshing = true;
        const generation = this.generation; const id = this.snapshot.id;
        try {
            const snapshot = await this.api.request(`/${id}`);
            if (generation !== this.generation || this.closed) return;
            this.snapshot = snapshot; this.delay = 5000;
            this.view.render(snapshot, this.sharing);
            const displayed = new Set();
            if (this.showContributions) for (const layer of snapshot.layers) {
                if (layer.contributorId === snapshot.contributorId && this.getLayers().some(local => local.id === layer.layerId)) continue;
                const key = `${id}/${layer.contributorId}/${layer.layerId}`; displayed.add(key);
                if (this.visibleContributions.get(key) === layer.revision) continue;
                let data;
                try { data = await this.api.request(`/${id}/contributors/${layer.contributorId}/layers/${layer.layerId}`); }
                catch (error) {
                    if (generation !== this.generation || this.closed) return;
                    // Withdrawal may race the metadata response; the session can still be valid.
                    if (error.status !== 404) throw error;
                    displayed.delete(key); this.visibleContributions.delete(key); continue;
                }
                if (generation !== this.generation || this.closed) return;
                const author = snapshot.contributors.find(person => person.id === layer.contributorId);
                this.showLayer(key, `${author.name} · ${layer.name}`, data.collection);
                this.visibleContributions.set(key, data.revision);
            }
            this.retainLayers(displayed);
            for (const key of this.visibleContributions.keys()) if (!displayed.has(key)) this.visibleContributions.delete(key);
            void this.sendChangedLayers();
        } catch (error) {
            if (generation !== this.generation || this.closed) return;
            this.view.message(error.message, true); this.delay = Math.min(this.delay * 2, 30000);
            if (error.status === 404) { await this.stopUploads(); this.snapshot = null; this.retainLayers(new Set()); this.view.render(null, this.sharing); }
        } finally {
            this.refreshing = false;
            if (this.snapshot && !this.closed) this.timer = setTimeout(() => void this.refreshSession(), this.delay);
        }
    }

    /**
     * Save the owner's joining switch; restore its previous setting if saving fails.
     * @param {boolean} allowed Whether new contributors may redeem the join code.
     * @return {Promise<void>} Completion with the saved setting or a visible error.
     */
    async setAllowNewContributors(allowed) {
        if (!this.snapshot?.isOwner || this.transitioning || this.joiningBusy || this.closed) return;
        const generation = this.generation;
        const sessionId = this.snapshot.id;
        this.joiningBusy = true; this.view.setJoiningBusy(true);
        try {
            await this.api.request(`/${sessionId}/actions/${allowed ? "open-joining" : "close-joining"}`, "POST");
            if (generation !== this.generation || this.closed) return;
            this.snapshot.joinsOpen = allowed;
            this.view.message(allowed ? "New contributors can join with the session code." : "New contributors cannot join. Existing contributors can keep working.");
        } catch (error) {
            if (generation === this.generation && !this.closed) this.view.message(error.message, true);
        } finally {
            this.joiningBusy = false; this.view.setJoiningBusy(false);
            this.view.render(this.snapshot, this.sharing);
        }
    }

    /** @param {string} action Authorized session management command. @return {Promise<void>} Completion with visible errors. */
    async applySessionAction(action) {
        if (!this.snapshot) return;
        try { await this.api.request(`/${this.snapshot.id}/actions/${action}`, "POST"); await this.refreshSession(); }
        catch (error) { this.view.message(error.message, true); }
    }

    /**
     * Stop sharing a layer and delete its shared copy from the session.
     * Keep the local annotation layer, including its polygons and notes.
     * Wait for this layer's current upload before requesting deletion. On success,
     * later local edits stay private until the user explicitly shares it again.
     * @param {string} id Identifier of this contributor's local annotation layer.
     * @return {Promise<void>} Completion after removal and refresh, or a displayed API error.
     */
    async stopSharingLayer(id) {
        if (!this.snapshot) return;
        const generation = this.generation;
        const state = this.sharing.get(id); if (state) state.paused = true;
        await state?.sending;
        if (generation !== this.generation) return;
        const layer = this.snapshot.layers.find(layer => layer.layerId === id && layer.contributorId === this.snapshot.contributorId);
        try {
            await this.api.request(`/${this.snapshot.id}/layers/${id}?revision=${Math.max(state?.revision ?? 0, layer?.revision ?? 0)}`, "DELETE");
            this.sharing.delete(id); this.setShareLabel(id, "Share"); this.rememberSharingRevisions();
            this.view.message("Shared copy withdrawn. Your local layer is unchanged."); await this.refreshSession();
        } catch (error) { this.view.message(error.message, true); }
    }

    /**
     * Restore a removed shared layer by fetching its current authorized contribution.
     * @param {string} key Opaque session/contributor/layer identity retained by Undo.
     * @param {()=>boolean} isCurrent Whether Undo still owns the user's intent.
     * @return {Promise<void>} Completion after the current contribution is shown.
     * @throws {Error} If membership changed, the contribution was withdrawn, or Undo is obsolete.
     */
    async restoreContribution(key, isCurrent) {
        const [sessionId, contributorId, layerId] = key.split("/");
        const generation = this.generation;
        if (!this.snapshot || this.snapshot.id !== sessionId) throw new Error("Rejoin the annotation session to show this contribution.");
        const data = await this.api.request(`/${sessionId}/contributors/${contributorId}/layers/${layerId}`);
        if (!isCurrent() || generation !== this.generation || this.closed) throw new Error("Layer restoration was superseded.");
        const author = this.snapshot.contributors.find(person => person.id === contributorId);
        this.showLayer(key, `${author?.name ?? "Contributor"} · ${data.collection.name}`, data.collection);
        this.visibleContributions.set(key, data.revision);
    }

    /** Stop scheduling uploads and wait for the one already sent before changing sessions. @return {Promise<void>} */
    async stopUploads() {
        this.generation++; clearTimeout(this.timer); clearTimeout(this.debounce);
        await Promise.all([...this.sharing.values()].map(state => state.sending));
        for (const id of this.sharing.keys()) this.setShareLabel(id, "Share");
    }

    /** Leave the current view without deleting any local or contributed polygons. @return {Promise<void>} */
    async leave() {
        if (this.transitioning) return;
        this.transitioning = true; this.view.busy(true);
        await this.stopUploads(); this.snapshot = null; this.sharing.clear(); this.retainLayers(new Set()); this.rememberSharingRevisions();
        this.view.render(null, this.sharing); this.view.message("Left the session. Shared copies remain available until expiration.");
        try { this.view.memberships(await this.api.request()); } catch (error) { this.view.message(error.message, true); }
        this.transitioning = false; this.view.busy(false);
    }

    /** Copy an invitation containing only the site URL and public join code. @return {Promise<void>} */
    async copyInvitation() {
        if (!this.snapshot) return;
        const url = new URL(globalThis.location.origin); url.searchParams.set("annotationSession", this.snapshot.joinCode);
        try { await navigator.clipboard.writeText(url.href); this.view.message("Invitation copied."); }
        catch { this.view.message(`Copy this join code: ${this.snapshot.joinCode}`); }
    }

    /** Stop background work when this application page leaves. @return {void} */
    destroy() {
        this.closed = true; this.generation++; clearTimeout(this.timer); clearTimeout(this.debounce);
        globalThis.removeEventListener?.("pagehide", this.onPageHide);
    }
}
