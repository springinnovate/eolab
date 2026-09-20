/** Connect the annotation session panel to session membership, saved-layer uploads and map updates. */
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
     * Create the session panel and connect its actions to the API and annotation callbacks.
     * Call start() after local annotations have loaded to restore a previous session.
     * @param {Object} options API, storage and callbacks supplied by browser composition.
     * @param {HTMLElement} options.root Container for session setup, status and management.
     * @param {HTMLButtonElement} options.entryButton Setup action placed in the annotation panel by composition.
     * @param {()=>void} [options.revealSetupEntry] Reveal the setup button when returning from an invitation.
     * @param {()=>void} [options.revealPanel] Reveal the containing workspace after an explicit action or invitation.
     * @param {(name:string)=>string} options.createLayer Add a named local annotation layer and return its identifier.
     * @param {(id:string)=>void} options.revealLayer Reveal this layer's editor and focus its drawing action after explicit navigation.
     * @param {()=>{id:string,collection:Object}[]} options.getLayers Committed, device-saved layers.
     * @param {(id:string,label:string,sessionName?:string)=>void} options.setShareLabel Local sharing status and optional session context.
     * @param {(key:string,label:string,collection:Object)=>void} options.showLayer Add or update a read-only shared layer on the map.
     * @param {(keys:Set<string>)=>void} options.retainLayers Keep only these shared layer IDs on the map; remove the other received layers.
     * @param {AnnotationSessionsApi} [options.api] Same-origin API.
     * @param {Storage} [options.storage] Store the active session ID and layer revisions for reload; never credentials or polygons.
     * @param {function(HTMLElement,Object,HTMLButtonElement):AnnotationSessionsView} [options.createView] Create the panel with its user-action callbacks.
     */
    constructor({ root, entryButton, revealPanel = () => {}, revealSetupEntry = () => {}, createLayer, revealLayer, getLayers, setShareLabel, showLayer, retainLayers,
        api = new AnnotationSessionsApi(), storage = globalThis.localStorage,
        createView = (element, actions, entry) => new AnnotationSessionsView(element, actions, entry) }) {
        Object.assign(this, { root, createLayer, revealLayer, getLayers, setShareLabel, showLayer, retainLayers, api, storage });
        this.snapshot = null; this.sharing = new Map(); this.generation = 0; this.refreshing = false;
        this.visibleContributions = new Map(); this.showContributions = false; this.closed = false;
        this.profileChangeVersion = 0;
        this.delay = 5000; this.timer = null; this.debounce = null; this.transitioning = false;
        this.view = createView(root, {
            reveal: revealPanel,
            revealEntry: revealSetupEntry,
            create: (name, contributorName) => void this.openSession("", { name, contributorName }),
            join: (joinCode, contributorName) => void this.openSession("/join", { joinCode, contributorName }),
            open: id => void this.openSession(`/${id}`, undefined, true),
            rename: name => void this.updateDisplayName(name),
            copy: () => void this.copyInvitation(),
            extend: () => void this.extendSessionExpiration(),
            allowNewContributors: allowed => void this.setAllowNewContributors(allowed),
            show: () => { this.showContributions = true; this.visibleContributions.clear(); void this.refreshSession(); },
            refresh: () => { for (const state of this.sharing.values()) if (!state.conflict) state.paused = false; void this.sendChangedLayers(); void this.refreshSession(); },
            leave: () => void this.leave(),
            withdraw: id => void this.stopSharingLayer(id),
        }, entryButton);
        this.onPageHide = () => this.destroy();
        globalThis.addEventListener?.("pagehide", this.onPageHide);
    }

    /**
     * Load this browser's memberships and reopen its saved session when available.
     * An invitation reopens an existing membership or prefills the join-code field;
     * a new contributor must still enter a name and choose Join session.
     * @return {Promise<void>} Completion after setup, with connection errors displayed in the panel.
     */
    async start() {
        try {
            const sessions = await this.api.request();
            if (this.closed) return;
            this.view.memberships(sessions);
            const code = new URL(globalThis.location?.href ?? "https://localhost").searchParams.get("annotationSession");
            if (code && /^[A-Z2-9]{8}$/i.test(code)) {
                const joined = sessions.find(session => session.joinCode === code.toUpperCase());
                if (joined) { await this.openSession(`/${joined.id}`, undefined, this.readSavedSession()?.sessionId !== joined.id); return; }
                this.view.showInvitation(code.toUpperCase());
                this.view.message("Enter your name, then join the annotation session."); return;
            }
            const saved = this.readSavedSession();
            if (saved?.sessionId && sessions.some(session => session.id === saved.sessionId)) await this.openSession(`/${saved.sessionId}`);
            else this.view.message("");
        } catch (error) { this.view.message(error.message, true); }
    }

    /**
     * Read the session and layer revisions saved on this device for reconnecting.
     * Ignore missing, malformed or inaccessible storage rather than preventing use.
     * @return {{sessionId:string,layers:{id:string,revision:number}[]}|null} Saved identifiers
     *     and acknowledged revisions, or null when no usable record exists.
     */
    readSavedSession() {
        try {
            const value = JSON.parse(this.storage.getItem(STORAGE_KEY));
            if (!value || typeof value.sessionId !== "string" || !Array.isArray(value.layers)) return null;
            if (value.layers.length > 32 || value.layers.some(layer => typeof layer.id !== "string" || !Number.isSafeInteger(layer.revision) || layer.revision < 0)) return null;
            return value;
        } catch { return null; }
    }

    /**
     * Save the active session ID and shared-layer revisions for the next page load.
     * Remove the saved record when no session is active. Store neither polygon data
     * nor credentials, and display a warning if device storage is unavailable.
     * @return {void}
     */
    saveSessionForReload() {
        try {
            if (!this.snapshot) this.storage.removeItem(STORAGE_KEY);
            else this.storage.setItem(STORAGE_KEY, JSON.stringify({ sessionId: this.snapshot.id,
                layers: [...this.sharing].map(([id, state]) => ({ id, revision: state.revision })) }));
        } catch { this.view.message("Shared changes are saved on the server, but this browser cannot remember sharing after reload.", true); }
    }

    /**
     * Create, join or reopen a session and make it the active session in this tab.
     * After the server accepts the request, finish uploads to the previous session,
     * restore this session's sharing settings and refresh its layers on the map.
     * Explicit create/join actions add a local layer if none is already shared here;
     * reopening after reload never creates another layer.
     * @param {string} path Empty to create, /join to join, or /<session ID> to reopen.
     * @param {{contributorName:string,name?:string,joinCode?:string}} [body] Create/join
     *     form values; omit when reopening an existing session.
     * @param {boolean} [reveal=!!body] Reveal the contribution after explicit navigation, never a background reload.
     * @return {Promise<void>} Completion after setup or a displayed error; repeated clicks
     *     during a session transition do not start another request.
     */
    async openSession(path, body, reveal = !!body) {
        if (this.transitioning || this.closed) return;
        this.transitioning = true; this.view.busy(true); this.view.message("Connecting…");
        try {
            const snapshot = await this.api.request(path, body ? "POST" : "GET", body);
            if (this.closed) return;
            await this.stopSessionSync();
            this.snapshot = snapshot; this.sharing.clear(); this.visibleContributions.clear(); this.retainLayers(new Set());
            this.showContributions = snapshot.isOwner;
            const bookmark = this.readSavedSession();
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
            this.saveSessionForReload();
            this.view.render(snapshot, this.sharing);
            this.view.message("Connected. Saved polygons are shared automatically.");
            await this.refreshSession();
            if (this.snapshot?.id === snapshot.id && !this.closed) {
                let layerId = [...this.sharing.keys()].find(id => localIds.has(id));
                if (body && !layerId) {
                    const member = snapshot.contributors.find(person => person.id === snapshot.contributorId);
                    layerId = this.createLayer(`${member?.name ?? "My"}’s annotations`.slice(0, 160));
                    this.trackSharedLayer(layerId, 0);
                }
                for (const id of this.sharing.keys()) this.setShareLabel(id, "Shared", snapshot.name);
                if (reveal && layerId) this.revealLayer(layerId);
            }
        } catch (error) { this.view.message(error.message, true); }
        finally { this.transitioning = false; this.view.busy(false); if (this.snapshot) this.committedLayersChanged(); }
    }

    /**
     * Share this local layer's saved polygons and keep uploading later saved edits.
     * This explicit action can replace a conflicting server copy using its last
     * observed revision. Automatic reconnects instead use the saved acknowledged revision.
     * If no session is active, ask the user to create or join one first.
     * @param {string} id Local annotation layer identifier.
     * @return {void} Starts the upload without waiting; progress and errors appear in the panel.
     */
    shareLayer(id) {
        if (this.snapshot) this.view.showDetails();
        if (this.transitioning) return;
        if (!this.snapshot) { this.view.showSetupPanel(); this.view.message("Create or join a session, then click Share on this layer."); return; }
        const previous = this.sharing.get(id);
        if (previous && !previous.conflict) { this.view.message("Saved edits to this layer are shared automatically. Use Withdraw below to remove the shared copy."); return; }
        const existing = this.snapshot.layers.find(layer => layer.contributorId === this.snapshot.contributorId && layer.layerId === id);
        // This explicit Share action may replace the last observed shared copy.
        // Automatic reconnects instead retain their acknowledged revision above.
        this.trackSharedLayer(id, existing?.revision ?? 0);
        void this.sendChangedLayers();
    }

    /**
     * Include a local layer in automatic sharing and remember its server revision.
     * Reset its upload status, but leave sending to the next saved-data upload.
     * @param {string} id Local annotation layer identifier.
     * @param {number} revision Last acknowledged revision, or zero for a new contribution.
     * @return {void}
     */
    trackSharedLayer(id, revision) {
        this.sharing.set(id, { revision, sent: null, sending: null, message: "Waiting for saved changes…" });
        this.setShareLabel(id, "Sharing…", this.snapshot.name); this.saveSessionForReload();
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

    /**
     * Schedule shared-layer uploads 600 ms after the latest successful device save.
     * Further saves restart the delay. Unshared layers and unfinished polygon drafts
     * are not uploaded; no upload is scheduled while the session is changing or closed.
     * @return {void}
     */
    committedLayersChanged() {
        clearTimeout(this.debounce);
        if (!this.snapshot || this.closed || this.transitioning) return;
        this.debounce = setTimeout(() => void this.sendChangedLayers(), 600);
    }

    /**
     * Upload changed saved layers that are neither paused nor already uploading.
     * This call waits for each upload it starts. Each layer's upload includes any
     * newer saves that arrive while it is waiting for the server.
     * @return {Promise<void>} Completion after this call's uploads and panel refresh;
     *     uploads already started by another call are left running.
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
     * Upload a layer's saved GeoJSON until no newer saved changes remain.
     * Keep the acknowledged revision for retries. Network failures remain retryable;
     * conflicts pause uploads until the user chooses whether to replace the server copy.
     * @param {string} id Local annotation layer identifier.
     * @param {{revision:number,sent:string|null,sending:Promise<void>|null,message:string,
     *     paused?:boolean,conflict?:boolean,error?:boolean,uploading?:boolean}} state This layer's revision and upload status.
     * @param {number} generation Session-change counter captured when the upload started.
     * @return {Promise<void>} Completion after the saved changes are sent, an error is
     *     displayed, or the request belongs to a session that is no longer active.
     */
    async uploadLayer(id, state, generation) {
        while (generation === this.generation && !this.closed && this.snapshot && !state.paused) {
            const layer = this.getLayers().find(layer => layer.id === id);
            if (!layer) { state.message = state.revision === 0 ? "Waiting for this layer to be saved on the device" : "Local layer removed; last shared copy kept"; return; }
            const text = JSON.stringify(layer.collection);
            if (text === state.sent) return;
            this.setShareLabel(id, "Sharing…", this.snapshot.name); state.message = "Sending…";
            state.uploading = true; this.view.render(this.snapshot, this.sharing);
            try {
                const accepted = await this.api.request(`/${this.snapshot.id}/layers/${id}`, "PUT", { revision: state.revision, collection: layer.collection });
                state.revision = accepted.revision; state.sent = text; state.message = "Saved"; state.error = false;
                if (generation !== this.generation || this.closed) return;
                this.saveSessionForReload(); this.setShareLabel(id, "Shared · Saved", this.snapshot.name);
                this.view.message("All sent changes are saved in the session.");
            } catch (error) {
                if (generation !== this.generation || this.closed) return;
                state.error = true; state.conflict = error.status === 409;
                state.paused = !!error.status && error.status < 500;
                state.message = state.conflict
                    ? "This shared layer changed in another tab. Refresh, then use Share local version to replace it with this device's copy."
                    : state.paused ? error.message : "Connection interrupted — changes saved on this device";
                this.setShareLabel(id, state.conflict ? "Share local version" : state.paused ? "Sharing needs attention" : "Shared · Offline", this.snapshot.name);
                this.view.message(state.message, true); return;
            } finally {
                state.uploading = false;
                if (generation === this.generation && !this.closed) this.view.render(this.snapshot, this.sharing);
            }
        }
    }

    /**
     * Refresh session members, layer revisions and received layers shown on the map.
     * Fetch GeoJSON when geometry revisions or contributor labels change, and retry eligible
     * saved-layer uploads. An expired or inaccessible session clears its map layers.
     * @return {Promise<void>} Completion of this refresh. While the session remains active,
     *     schedule the next refresh in 5 seconds, backing off to 30 seconds after failures.
     *     Successful recovery clears only the previous status-read error.
     */
    async refreshSession() {
        if (!this.snapshot || this.refreshing || this.closed) return;
        clearTimeout(this.timer); this.refreshing = true;
        const generation = this.generation; const id = this.snapshot.id;
        const profileVersion = this.profileChangeVersion;
        try {
            const snapshot = await this.api.request(`/${id}`);
            if (generation !== this.generation || this.closed) return;
            // A status read started before Save name must not restore the previous name.
            if (profileVersion !== this.profileChangeVersion) {
                snapshot.contributors.find(person => person.id === snapshot.contributorId).name =
                    this.snapshot.contributors.find(person => person.id === this.snapshot.contributorId).name;
            }
            this.snapshot = snapshot; this.delay = 5000;
            this.view.render(snapshot, this.sharing);
            const displayed = new Set();
            if (this.showContributions) for (const layer of snapshot.layers) {
                if (layer.contributorId === snapshot.contributorId && this.getLayers().some(local => local.id === layer.layerId)) continue;
                const key = `${id}/${layer.contributorId}/${layer.layerId}`; displayed.add(key);
                const author = snapshot.contributors.find(person => person.id === layer.contributorId);
                const label = `${author.name} · ${layer.name}`;
                const presentation = JSON.stringify([layer.revision, label]);
                if (this.visibleContributions.get(key) === presentation) continue;
                let data;
                try { data = await this.api.request(`/${id}/contributors/${layer.contributorId}/layers/${layer.layerId}`); }
                catch (error) {
                    if (generation !== this.generation || this.closed) return;
                    // Withdrawal may race the metadata response; the session can still be valid.
                    if (error.status !== 404) throw error;
                    displayed.delete(key); this.visibleContributions.delete(key); continue;
                }
                if (generation !== this.generation || this.closed) return;
                this.showLayer(key, label, data.collection);
                this.visibleContributions.set(key, JSON.stringify([data.revision, label]));
            }
            if (this.refreshError) { this.view.clearError(this.refreshError); this.refreshError = null; }
            this.retainLayers(displayed);
            for (const key of this.visibleContributions.keys()) if (!displayed.has(key)) this.visibleContributions.delete(key);
            void this.sendChangedLayers();
        } catch (error) {
            if (generation !== this.generation || this.closed) return;
            this.refreshError = error.message; this.view.message(error.message, true); this.delay = Math.min(this.delay * 2, 30000);
            if (error.status === 404) { await this.stopSessionSync(); this.snapshot = null; this.retainLayers(new Set()); this.view.render(null, this.sharing); }
        } finally {
            this.refreshing = false;
            if (this.snapshot && !this.closed) this.timer = setTimeout(() => void this.refreshSession(), this.delay);
        }
    }

    /** Save this member's display name without changing identity, layers or sharing revisions.
     * @param {string} name Requested name, validated by the session API.
     * @return {Promise<void>} Completion with a saved name or a visible error; late replies are ignored.
     */
    async updateDisplayName(name) {
        if (!this.snapshot || this.transitioning || this.nameBusy || this.closed) return;
        const generation = this.generation;
        this.nameBusy = true; this.view.setNameBusy(true);
        try {
            const saved = await this.api.request(`/${this.snapshot.id}/profile`, "PATCH", { name });
            if (generation !== this.generation || this.closed) return;
            this.snapshot.contributors.find(person => person.id === this.snapshot.contributorId).name = saved.name;
            this.profileChangeVersion++;
            this.view.nameSaved(saved.name);
            this.view.message("Display name saved.");
        } catch (error) {
            if (generation === this.generation && !this.closed) this.view.message(error.message, true);
        } finally {
            this.nameBusy = false; this.view.setNameBusy(false);
            this.view.render(this.snapshot, this.sharing);
        }
    }

    /**
     * Save whether the owner allows new contributors to join this session.
     * Disable the switch while saving and restore the server's last known setting
     * on failure. Existing contributors can keep working either way.
     * @param {boolean} allowed Whether new contributors may join using the session code.
     * @return {Promise<void>} Completion with the saved setting or a displayed error.
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

    /**
     * Ask the server to keep the active session for another day, then refresh its expiry.
     * @return {Promise<void>} Completion after the request and refresh, or a displayed error.
     */
    async extendSessionExpiration() {
        if (!this.snapshot) return;
        try { await this.api.request(`/${this.snapshot.id}/actions/extend`, "POST"); await this.refreshSession(); }
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
            this.sharing.delete(id); this.setShareLabel(id, "Share"); this.saveSessionForReload();
            this.view.message("Shared copy withdrawn. Your local layer is unchanged."); await this.refreshSession();
        } catch (error) { this.view.message(error.message, true); }
    }

    /**
     * Put a removed shared annotation layer back on this map for Undo.
     * Fetch the latest server copy using this browser's current session membership;
     * restoring the map layer does not recreate or modify anything on the server.
     * @param {string} key Session/contributor/layer identifier saved by the removal's Undo record.
     * @param {()=>boolean} isCurrent Whether this is still the most recent removal to undo.
     * @return {Promise<void>} Completion after the fetched layer is displayed.
     * @throws {Error} If the layer cannot be fetched, session access changed, the page
     *     closed, or a newer removal replaced this Undo request.
     */
    async restoreSharedLayer(key, isCurrent) {
        const [sessionId, contributorId, layerId] = key.split("/");
        const generation = this.generation;
        if (!this.snapshot || this.snapshot.id !== sessionId) throw new Error("Rejoin the annotation session to show this contribution.");
        const data = await this.api.request(`/${sessionId}/contributors/${contributorId}/layers/${layerId}`);
        if (!isCurrent() || generation !== this.generation || this.closed) throw new Error("Layer restoration was superseded.");
        const author = this.snapshot.contributors.find(person => person.id === contributorId);
        const label = `${author?.name ?? "Contributor"} · ${data.collection.name}`;
        this.showLayer(key, label, data.collection);
        this.visibleContributions.set(key, JSON.stringify([data.revision, label]));
    }

    /**
     * Stop scheduled session refreshes/uploads and wait for uploads already sent.
     * Mark pending replies as belonging to the old session so they cannot update
     * its replacement. Do not abort sent HTTP requests or delete saved layers.
     * Callers prevent new scheduling while switching, leaving or clearing a session.
     * @return {Promise<void>} Completion after outstanding uploads settle and Share labels reset.
     */
    async stopSessionSync() {
        this.generation++; this.refreshError = null; clearTimeout(this.timer); clearTimeout(this.debounce);
        await Promise.all([...this.sharing.values()].map(state => state.sending));
        for (const id of this.sharing.keys()) this.setShareLabel(id, "Share");
    }

    /**
     * Stop sharing in this tab and remove received layers from its map.
     * Keep local annotations, server copies and server membership so the session can
     * be reopened. Forget the active-session record and refresh the session chooser.
     * @return {Promise<void>} Completion after leaving, with any chooser refresh error displayed.
     */
    async leave() {
        if (this.transitioning) return;
        this.transitioning = true; this.view.busy(true);
        await this.stopSessionSync(); this.snapshot = null; this.sharing.clear(); this.retainLayers(new Set()); this.saveSessionForReload();
        this.view.render(null, this.sharing); this.view.message("Left the session. Shared copies remain available until expiration.");
        try { this.view.memberships(await this.api.request()); } catch (error) { this.view.message(error.message, true); }
        this.transitioning = false; this.view.busy(false);
    }

    /**
     * Copy a session invitation link, or display the join code if clipboard access fails.
     * The link contains the site URL and join code, without private credentials or polygons.
     * @return {Promise<void>} Completion after copying or displaying the fallback code.
     */
    async copyInvitation() {
        if (!this.snapshot) return;
        const url = new URL(globalThis.location.origin); url.searchParams.set("annotationSession", this.snapshot.joinCode);
        try { await navigator.clipboard.writeText(url.href); this.view.message("Invitation copied."); }
        catch { this.view.message(`Copy this join code: ${this.snapshot.joinCode}`); }
    }

    /**
     * Stop timers and ignore late session replies when this page closes.
     * Remove the pagehide listener; HTTP requests already sent are not aborted.
     * @return {void}
     */
    destroy() {
        this.closed = true; this.generation++; clearTimeout(this.timer); clearTimeout(this.debounce);
        globalThis.removeEventListener?.("pagehide", this.onPageHide);
    }
}
