/** Keep the exact source bytes for a recoverable model submission until admission settles. */
export class PendingModelInputs {
    /** @param {IDBFactory|undefined} [indexedDB] Device storage used across page reloads. */
    constructor(indexedDB = globalThis.indexedDB) {
        this.indexedDB = indexedDB;
        this.database = null;
        this.memory = new Map();
    }

    /** Open pending source storage and remove abandoned sources when the application next uses it.
     * @return {Promise<IDBDatabase>} The database shared by this browser's EOLab tabs.
     * @throws {Error} If the browser cannot open its database.
     */
    open() {
        this.database ??= new Promise((resolve, reject) => {
            const request = this.indexedDB.open("eolab-model-inputs", 1);
            request.onupgradeneeded = () => request.result.createObjectStore("sources").createIndex("expires", "expires");
            request.onerror = () => { this.database = null; reject(request.error); };
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => { db.close(); this.database = null; };
                const tx = db.transaction("sources", "readwrite");
                const expired = tx.objectStore("sources").index("expires").openCursor(IDBKeyRange.upperBound(Date.now()));
                expired.onsuccess = () => { if (expired.result) { expired.result.delete(); expired.result.continue(); } };
                resolve(db);
            };
        });
        return this.database;
    }

    /** Run an input read or write and wait for its transaction to commit.
     * @param {IDBTransactionMode} mode Read-only or read-write access.
     * @param {(store:IDBObjectStore)=>IDBRequest} action The single input operation.
     * @return {Promise<*>} Result of the committed operation.
     * @throws {Error} If the operation cannot commit.
     */
    async transaction(mode, action) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("sources", mode);
            const result = action(tx.objectStore("sources"));
            tx.oncomplete = () => resolve(result.result);
            tx.onabort = () => reject(tx.error ?? new Error("Could not save the model input."));
        });
    }

    /** Capture one immutable source before saving the compact run request.
     * @param {Object} source JSON document supplied by a vector source owner.
     * @return {Promise<{id:string,sha256:string}>} Random ID and checksum of its exact transmitted bytes.
     * @throws {Error} If the browser cannot retain the source.
     */
    async capture(source) {
        const body = new Blob([JSON.stringify(source)]);
        const id = crypto.randomUUID().replaceAll("-", "");
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await body.arrayBuffer()));
        const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
        if (this.indexedDB) await this.transaction("readwrite", store => store.put({body, expires: Date.now() + 86400000}, id));
        else this.memory.set(id, body);
        return {id, sha256};
    }

    /** Remove a source after acceptance, definite rejection, or abandonment of this setup.
     * @param {string} id Previously captured input ID.
     * @return {Promise<void>} Resolves after releasing the pending source.
     */
    async discard(id) {
        if (this.indexedDB) await this.transaction("readwrite", store => store.delete(id));
        else this.memory.delete(id);
    }

    /** Attach locally retained sources to the compact run in declared input order.
     * @param {Object} submission Original model invocation, including its stable retry ID.
     * @return {Promise<{body:Object|Blob,ids:string[]}>} Request body and attached IDs to release on acknowledgement.
     */
    async forSubmission(submission) {
        const ids = new Set();
        /** Collect private source IDs from selections and polygon groups without interpreting recipe roles.
         * @param {*} value Input subtree.
         * @return {void}
         */
        function collect(value) {
            if (!value || typeof value !== "object") return;
            if (value.kind === "capturedVector") ids.add(value.reference.id);
            if (value.kind === "drawing" && value.polygonArea?.id) ids.add(value.polygonArea.id);
            if (value.enabled === false && Array.isArray(value.rules)) return;
            Object.values(value).forEach(collect);
        }
        collect(submission.inputs);
        const attached = [], parts = [];
        for (const id of ids) {
            const source = this.indexedDB ? (await this.transaction("readonly", store => store.get(id)))?.body : this.memory.get(id);
            if (source) { attached.push(id); parts.push(source, "\n"); }
        }
        const body = attached.length ? new Blob([JSON.stringify(submission), "\n", JSON.stringify(attached), "\n", ...parts],
            {type: "application/x-ndjson"}) : submission;
        return {body, ids: attached};
    }
}
