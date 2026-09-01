/** Standard STAC Item retrieval for portable saved-map restoration. */

/** Resolve exact Catalog identities without sharing search cancellation state. */
export class SavedMapViewCatalogClient {
    /**
     * Create a focused exact-Item client.
     *
     * @param {string} catalogUrl Browser-facing STAC root URL.
     * @param {Function} fetchImplementation Fetch-compatible request function.
     */
    constructor(catalogUrl, fetchImplementation = globalThis.fetch) {
        this.catalogUrl = catalogUrl.replace(/\/$/, "");
        this.fetchImplementation = fetchImplementation.bind(globalThis);
    }

    /**
     * Retrieve one authoritative Item by its composite Catalog identity.
     *
     * @param {{collection:string,id:string}} identity Saved Catalog identity.
     * @return {Promise<Object>} Current STAC Item.
     * @throws {Error} If the Item is absent or the response identity differs.
     */
    async get(identity) {
        const url = `${this.catalogUrl}/collections/` +
            `${encodeURIComponent(identity.collection)}/items/` +
            encodeURIComponent(identity.id);
        const response = await this.fetchImplementation(url, {
            headers: { Accept: "application/geo+json" },
        });
        if (!response.ok) {
            throw new Error(
                response.status === 404
                    ? "Catalog Item is no longer available."
                    : `Catalog Item request returned ${response.status}.`
            );
        }
        const item = await response.json();
        if (item?.collection !== identity.collection || item?.id !== identity.id) {
            throw new Error("Catalog returned a different Item identity.");
        }
        return item;
    }
}
