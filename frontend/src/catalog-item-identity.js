/** Catalog-owned identity contract shared by browser capabilities. */

/**
 * Return one stable key from a STAC Item's composite identity.
 *
 * @param {Object} item Catalog STAC Item.
 * @return {string} Collision-safe serialized Collection and Item identity.
 * @throws {TypeError} If the Item identity violates the Catalog contract.
 */
export function getCatalogItemKey(item) {
    if (
        typeof item?.collection !== "string" ||
        item.collection.length === 0 ||
        typeof item?.id !== "string" ||
        item.id.length === 0
    ) {
        throw new TypeError(
            "Catalog Items require non-empty collection and id strings."
        );
    }
    return JSON.stringify([item.collection, item.id]);
}
