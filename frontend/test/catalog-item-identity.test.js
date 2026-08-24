import assert from "node:assert/strict";
import test from "node:test";

import { getCatalogItemKey } from "../src/catalog-item-identity.js";

/**
 * Create one Catalog Item identity.
 *
 * @param {unknown} collection Candidate Collection identifier.
 * @param {unknown} id Candidate Item identifier.
 * @return {{collection:unknown,id:unknown}} Minimal identity candidate.
 */
function catalogItem(collection, id) {
    return { collection, id };
}

test("Catalog Item keys validate and preserve composite identity", () => {
    const splitAfterFirstCharacter = catalogItem("a", "bc");
    const splitBeforeLastCharacter = catalogItem("ab", "c");
    const delimiterValues = catalogItem("a\",\"b", "[c]");

    assert.equal(
        getCatalogItemKey(splitAfterFirstCharacter),
        getCatalogItemKey({ ...splitAfterFirstCharacter }),
    );
    assert.notEqual(
        getCatalogItemKey(splitAfterFirstCharacter),
        getCatalogItemKey(splitBeforeLastCharacter),
    );
    assert.notEqual(
        getCatalogItemKey(delimiterValues),
        getCatalogItemKey(catalogItem("a", "b\",\"[c]")),
    );

    for (const invalidItem of [
        null,
        {},
        catalogItem("", "item"),
        catalogItem("collection", ""),
        catalogItem(7, "item"),
        catalogItem("collection", 7),
    ]) {
        assert.throws(() => getCatalogItemKey(invalidItem), TypeError);
    }
});
