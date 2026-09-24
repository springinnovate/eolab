/** Synchronize author-owned polygons for shared layers attached to this map. */
import { AnnotationSessionsApi } from "./api.js";
import { AnnotationSessionsView } from "./view.js";

const STORAGE_KEY = "eolab-shared-annotation-layers-v1";

/** Keep each attached shared layer synchronized without transferring another author's edit rights. */
export class AnnotationSessionsController {
    /** Connect sharing to annotation editing through composition-supplied callbacks.
     * @param {Object} options Dependencies and layer callbacks.
     * @param {Document} options.document Browser document.
     * @param {()=>Object[]} options.getLayers Device-saved own polygon collections.
     * @param {(name:string,collection:Object,options?:Object)=>Promise<string>} options.createLayer Restore an author's polygons, optionally reusing a device layer.
     * @param {(id:string,data:Object)=>void} options.present Display collaborators and sharing status on one layer.
     * @param {(id:string)=>void} options.revealLayer Focus drawing controls.
     * @param {(id:string)=>void} [options.drawAfterJoining] Resume a visitor's Draw polygon request after joining.
     * @param {Storage} [options.storage=globalThis.localStorage] Binding/revision persistence; no credentials or remote polygons.
     * @param {AnnotationSessionsApi} [options.api] Same-origin session API.
     * @param {Function} [options.createView] Dialog factory for presentation tests.
     */
    constructor({ document, getLayers, createLayer, present, revealLayer, drawAfterJoining = () => {}, storage = globalThis.localStorage,
        api = new AnnotationSessionsApi(), createView = (doc, actions) => new AnnotationSessionsView(doc, actions) }) {
        Object.assign(this, { getLayers, createLayer, present, revealLayer, drawAfterJoining, storage, api });
        this.savedBindings = [];
        this.bindings = new Map(); this.closed = false; this.running = null; this.connecting = false;
        this.view = createView(document, { connect: (...args) => this.connect(...args), rename: (id, name) => this.renameContributor(id, name) });
    }

    /** Restore bindings only for layers still on this map, then resume synchronization.
     * @param {Object} [options] Startup policy.
     * @param {boolean} [options.restoreBindings=true] Activate private bookmarks; false waits for explicit saved-map references.
     * @param {boolean} [options.refreshImmediately=true] Fetch updates before returning; composition can defer until map restoration.
     * @return {Promise<void>} Completion of the initial refresh.
     */
    async start({ restoreBindings = true, refreshImmediately = true } = {}) {
        try {
            const saved = JSON.parse(this.storage.getItem(STORAGE_KEY) ?? "[]");
            if (!Array.isArray(saved)) throw new Error("Invalid shared-layer bookmarks.");
            for (const item of saved) {
                if (!item || !/^[\da-f-]{36}$/i.test(item.sessionId) || typeof item.localId !== "string" || !Number.isSafeInteger(item.revision) || item.revision < 0) continue;
                if (item.pendingColor !== undefined && !/^#[\da-f]{6}$/i.test(item.pendingColor)) continue;
                this.savedBindings.push(item);
                if (restoreBindings && this.getLayers().some(layer => layer.id === item.localId)) this.bindings.set(item.localId, { ...item, remote: new Map(), retryDelay: 5000 });
            }
        } catch (error) { this.view.message(`Could not restore shared layers: ${error.message}`); }
        if (refreshImmediately) await this.refresh();
    }

    /** Persist layer identities and acknowledged revisions for safe reloads.
     * @return {void}
     * @throws {Error} If browser storage cannot preserve synchronization state.
     */
    saveBindings() {
        const inactive = JSON.parse(this.storage.getItem(STORAGE_KEY) ?? "[]").filter(item => !this.bindings.has(item.localId));
        const active = [...this.bindings.values()].map(({ localId, sessionId, contributorId, revision, pendingColor, joinCode }) => ({ localId, sessionId, contributorId, revision, pendingColor, joinCode }));
        this.savedBindings = [...inactive, ...active];
        this.storage.setItem(STORAGE_KEY, JSON.stringify(this.savedBindings));
    }

    /** Export only the invitation for a shared layer, never polygons or private identity.
     * @param {string} localId Local annotation identity.
     * @return {{id:string,joinCode:string}|null} Portable reference, or null for an unshared layer.
     */
    getMapReference(localId) {
        const binding = this.bindings.get(localId);
        if (!binding) return null;
        const joinCode = binding.snapshot?.joinCode ?? binding.joinCode;
        if (!joinCode) throw new Error("Wait for the shared layer to connect before sharing this map.");
        return { id: binding.sessionId, joinCode };
    }

    /** Open a live invitation without joining, reusing only this browser's matching contribution.
     * @param {{id:string,joinCode:string}} reference Validated same-site invitation.
     * @param {()=>boolean} [isCurrent] Whether the requesting map restoration is still active.
     * @return {Promise<string|null>} Local layer identity, or null after supersession.
     * @throws {Error} If the layer is unavailable or local persistence fails.
     */
    async openMapReference(reference, isCurrent = () => true) {
        const path = `/invitations/${reference.id}/${reference.joinCode}`;
        const snapshot = await this.api.request(path);
        if (this.closed || !isCurrent()) return null;
        const existing = [...this.bindings.values()].find(binding => binding.sessionId === reference.id && this.getLayers().some(layer => layer.id === binding.localId));
        if (existing) {
            if (existing.contributorId !== snapshot.contributorId) throw new Error("This browser's contributor changed. Reload the map before editing.");
            return existing.localId;
        }
        const bookmark = this.savedBindings.find(binding => binding.sessionId === reference.id && binding.contributorId === snapshot.contributorId && this.getLayers().some(layer => layer.id === binding.localId));
        const own = snapshot.layers.find(layer => layer.contributorId === snapshot.contributorId);
        const data = own ? await this.api.request(`${path}/contributors/${own.contributorId}/layers/${own.layerId}`)
            : { revision: 0, collection: { type: "FeatureCollection", name: snapshot.name, features: [] } };
        if (this.closed || !isCurrent()) return null;
        const localId = await this.createLayer(snapshot.name, data.collection, { localId: bookmark?.localId });
        const binding = { ...bookmark, localId, sessionId: reference.id, joinCode: reference.joinCode,
            contributorId: snapshot.contributorId, revision: bookmark?.revision ?? data.revision,
            snapshot, remote: new Map(), retryDelay: 5000 };
        this.bindings.set(localId, binding); this.saveBindings();
        this.display(binding, "Loading shared layers…");
        await this.refresh();
        return localId;
    }

    /** Permit an existing contributor to draw, or prompt an invited visitor for a name.
     * @param {string} localId Layer the user chose to edit.
     * @return {boolean} Whether editing can begin now.
     */
    requestDrawing(localId) {
        const binding = this.bindings.get(localId);
        if (!binding || binding.contributorId) return true;
        this.view.open("contribute", localId, binding.joinCode);
        return false;
    }

    /** Create/join a layer, restoring only polygons owned by this browser credential.
     * @param {"create"|"join"|"contribute"} mode Create, explicit join, or first drawing in an invited layer.
     * @param {string} value Name or code.
     * @param {string} name Contributor display name.
     * @param {string|null} [localId=null] Existing local layer to share.
     * @return {Promise<void>} Completion or an error retained in the dialog.
     */
    async connect(mode, value, name, localId = null) {
        if (this.connecting || this.closed) return;
        this.connecting = true; this.view.busy(true); this.view.message("Connecting…");
        try {
            const snapshot = await this.api.request(mode === "create" ? "" : "/join", "POST",
                mode === "create" ? { name: value, contributorName: name } : { joinCode: value, contributorName: name });
            if (this.closed) return;
            const existing = [...this.bindings.values()].find(item => item.sessionId === snapshot.id && this.getLayers().some(layer => layer.id === item.localId));
            if (existing?.contributorId) {
                if (existing.contributorId !== snapshot.contributorId) throw new Error("This device's saved layer belongs to a different contributor. Export it before removing it and joining again.");
                this.view.connected(); this.revealLayer(existing.localId); await this.refresh(); return;
            }
            const own = snapshot.layers.find(layer => layer.contributorId === snapshot.contributorId);
            const data = own ? await this.api.request(`/${snapshot.id}/contributors/${own.contributorId}/layers/${own.layerId}`)
                : { revision: 0, collection: { type: "FeatureCollection", name: snapshot.name, features: [] } };
            if (this.closed) return;
            if (existing) localId = await this.createLayer(snapshot.name, data.collection, { localId: existing.localId, replacePolygons: true });
            else if (!localId) localId = await this.createLayer(snapshot.name, data.collection);
            const binding = { localId, sessionId: snapshot.id, joinCode: snapshot.joinCode, contributorId: snapshot.contributorId, revision: data.revision, remote: new Map(), snapshot, retryDelay: 5000 };
            this.bindings.set(localId, binding); this.saveBindings();
            this.display(binding, "Sharing…"); this.view.connected(); this.revealLayer(localId);
            await this.refresh();
            if (mode === "contribute") this.drawAfterJoining(localId);
        } catch (error) { this.view.message(error.message); }
        finally { this.connecting = false; this.view.busy(false); }
    }

    /** Open your current name for editing in one shared layer.
     * @param {string} localId Local layer whose contributor name should change.
     * @return {void}
     */
    editContributorName(localId) {
        const binding = this.bindings.get(localId);
        const own = binding?.snapshot?.contributors.find(person => person.id === binding.contributorId);
        if (!own || this.closed || this.connecting) return;
        this.view.open("rename", localId, own.name);
    }

    /** Save your display name without changing membership or polygon ownership.
     * Server validation errors leave the entered name in the dialog for correction.
     * @param {string} localId Local layer bound to the session being updated.
     * @param {string} name New contributor name; the server validates uniqueness and length.
     * @return {Promise<void>} Completion, with errors displayed in the dialog.
     */
    async renameContributor(localId, name) {
        if (this.connecting || this.closed) return;
        const binding = this.bindings.get(localId);
        if (!binding?.contributorId) return;
        this.connecting = true; this.view.busy(true); this.view.message("Saving name…");
        try {
            const saved = await this.api.request(`/${binding.sessionId}/profile`, "PATCH", { name });
            // Finish any older snapshot before requesting the newly saved name.
            if (this.running) await this.running;
            if (this.closed || this.bindings.get(localId) !== binding) return;
            const own = binding.snapshot?.contributors.find(person => person.id === binding.contributorId);
            if (own) own.name = saved.name;
            binding.nextAttempt = 0;
            this.display(binding, "Name saved");
            await this.refresh();
            if (!this.closed) this.view.connected();
        } catch (error) { this.view.message(error.message); }
        finally { this.connecting = false; this.view.busy(false); }
    }

    /** Copy a bound layer's code, or offer to share an existing local layer.
     * @param {string} localId Local layer identity. @return {Promise<void>}
     */
    async shareLayer(localId) {
        const binding = this.bindings.get(localId);
        if (!binding) {
            this.view.open("create", localId, this.getLayers().find(layer => layer.id === localId)?.collection.name ?? ""); return;
        }
        if (!binding.snapshot) { void this.refresh(); return; }
        try { await navigator.clipboard.writeText(binding.snapshot.joinCode); this.display(binding, "Share code copied"); }
        catch { this.display(binding, `Share code: ${binding.snapshot.joinCode}`); }
    }

    /** Publish session presentation without exposing credentials or editable remote polygons.
     * @param {Object} binding Shared-layer synchronization state.
     * @param {string} status User-facing save status.
     * @param {boolean} [error=false] Whether attention is required.
     * @return {void}
     */
    display(binding, status, error = false) {
        const snapshot = binding.snapshot;
        this.present(binding.localId, { name: snapshot?.name, contributors: snapshot?.contributors.map(person => ({
            ...person, own: person.id === snapshot.contributorId,
            color: person.id === snapshot.contributorId ? binding.pendingColor ?? person.color : person.color,
            polygonCount: snapshot.layers.filter(layer => layer.contributorId === person.id).reduce((sum, layer) => sum + layer.polygonCount, 0),
        })) ?? [], collections: [...binding.remote.values()].map(item => item.collection),
        status, error, canContribute: !!binding.contributorId, code: snapshot?.joinCode ?? "", exportUrl: binding.contributorId ? `/api/annotation-sessions/${binding.sessionId}/export` : null });
    }

    /** Save your color choice for one layer and retry failed transfers with its usual refresh.
     * Rapid changes replace the pending choice; an older reply cannot replace a newer choice.
     * @param {string} localId Local layer bound to a shared session.
     * @param {string} color Six-digit hexadecimal fill color from the color picker.
     * @return {Promise<void>} Completion of the current synchronization cycle.
     */
    async setContributorColor(localId, color) {
        const binding = this.bindings.get(localId);
        if (!binding?.contributorId || this.closed) return;
        try {
            if (!/^#[\da-f]{6}$/i.test(color)) throw new Error("Choose a valid polygon color.");
            binding.pendingColor = color;
            this.saveBindings();
            binding.nextAttempt = 0;
            this.display(binding, "Saving color…");
            await this.refresh();
        } catch (error) { this.display(binding, error.message, true); }
    }

    /** Debounce committed device changes; drawings are sent only after local saving succeeds.
     * @return {void}
     */
    committedLayersChanged() {
        if (this.closed) return;
        clearTimeout(this.timer); this.timer = setTimeout(() => void this.refresh(), 350);
    }

    /** Refresh all attached shared layers; serialize cycles and retry transient errors.
     * @return {Promise<void>} Completion of the current refresh cycle.
     */
    async refresh() {
        if (this.closed) return;
        if (this.running) { this.again = true; return this.running; }
        clearTimeout(this.timer);
        this.running = this.refreshLayers();
        try { await this.running; }
        finally {
            this.running = null;
            if (!this.closed) { this.timer = setTimeout(() => void this.refresh(), this.again ? 350 : 5000); this.again = false; }
        }
    }

    /** Transfer changed contributions and save only this contributor's own collection.
     * Revision conflicts preserve device data and stop automatic writes for that layer.
     * @return {Promise<void>} Completion with per-layer status, including failures.
     */
    async refreshLayers() {
        const local = new Map(this.getLayers().map(layer => [layer.id, layer]));
        for (const [id, binding] of this.bindings) {
            if (!local.has(id) || binding.nextAttempt > Date.now()) continue;
            try {
                const readPath = binding.contributorId ? `/${binding.sessionId}` : `/invitations/${binding.sessionId}/${binding.joinCode}`;
                const snapshot = await this.api.request(readPath);
                if (this.closed || this.bindings.get(id) !== binding || !this.getLayers().some(layer => layer.id === id)) continue;
                if (snapshot.contributorId !== binding.contributorId) throw new Error("This layer belongs to a different contributor. Your local polygons have not been shared.");
                binding.snapshot = snapshot;
                binding.joinCode = snapshot.joinCode;
                if (binding.pendingColor) {
                    const color = binding.pendingColor;
                    const saved = await this.api.request(`/${snapshot.id}/color`, "PATCH", { color });
                    if (this.closed || !this.getLayers().some(layer => layer.id === id)) continue;
                    snapshot.contributors.find(person => person.id === snapshot.contributorId).color = saved.color;
                    if (binding.pendingColor === color) delete binding.pendingColor;
                    else this.again = true;
                    this.saveBindings();
                }
                const keys = new Set();
                for (const layer of snapshot.layers) {
                    if (layer.contributorId === snapshot.contributorId) continue;
                    const key = `${layer.contributorId}/${layer.layerId}`; keys.add(key);
                    const author = snapshot.contributors.find(person => person.id === layer.contributorId);
                    const cached = binding.remote.get(key);
                    if (cached?.revision === layer.revision && cached.authorName === author?.name) continue;
                    const data = cached?.revision === layer.revision ? cached
                        : await this.api.request(`${readPath}/contributors/${layer.contributorId}/layers/${layer.layerId}`);
                    binding.remote.set(key, { revision: data.revision, authorName: author?.name, collection: { ...data.collection,
                        features: data.collection.features.map((feature, index) => ({ ...feature, id: `${layer.contributorId}-${index}`,
                            properties: { ...feature.properties, contributor: author?.name ?? "Contributor", contributorId: layer.contributorId } })) } });
                }
                for (const key of binding.remote.keys()) if (!keys.has(key)) binding.remote.delete(key);
                if (this.bindings.get(id) !== binding) continue;
                if (!binding.contributorId) {
                    binding.retryDelay = 5000; binding.nextAttempt = 0;
                    this.display(binding, "Choose Draw polygon to add your contribution.");
                    continue;
                }
                const saved = this.getLayers().find(layer => layer.id === id);
                if (!saved || this.closed) continue;
                const collection = { ...saved.collection, name: snapshot.name };
                const text = JSON.stringify(collection);
                if (!binding.conflict && text !== binding.sent) {
                    this.display(binding, "Saving…");
                    // Retry the identical upload after a lost reply before sending newer edits.
                    binding.pending ??= { revision: binding.revision, collection: structuredClone(collection), text };
                    const pending = binding.pending;
                    const response = await this.api.request(`/${snapshot.id}/layers/${snapshot.id}`, "PUT", { revision: pending.revision, collection: pending.collection });
                    binding.revision = response.revision; binding.sent = pending.text; this.saveBindings();
                    binding.pending = null;
                    if (text !== binding.sent) this.again = true;
                }
                binding.retryDelay = 5000; binding.nextAttempt = 0;
                const own = snapshot.layers.find(layer => layer.contributorId === snapshot.contributorId);
                if (own) own.polygonCount = collection.features.length;
                else snapshot.layers.push({ contributorId: snapshot.contributorId, polygonCount: collection.features.length });
                this.display(binding, binding.conflict ? "Changed in another tab. Your local edits are safe; export them before rejoining." : "Saved", !!binding.conflict);
            } catch (error) {
                if (this.closed) return;
                if (error.status === 409) binding.conflict = true;
                binding.nextAttempt = Date.now() + binding.retryDelay;
                binding.retryDelay = Math.min(binding.retryDelay * 2, 30000);
                this.display(binding, error.message, true);
            }
        }
    }

    /** Stop refreshes when the application closes. @return {void} */
    destroy() { this.closed = true; clearTimeout(this.timer); }
}
