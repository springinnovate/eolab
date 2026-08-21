/**
 * Request and validate the public WMS capabilities document.
 *
 * @param {string} wmsUrl Browser-facing WMS endpoint.
 * @param {Function} fetchImplementation Fetch implementation used by the browser.
 * @return {Promise<string>} URL of the validated capabilities document.
 * @throws {Error} If WMS is unavailable or returns a different document.
 */
export async function loadWmsCapabilities(
    wmsUrl,
    fetchImplementation = globalThis.fetch
) {
    const query = new URLSearchParams({
        service: "WMS",
        version: "1.3.0",
        request: "GetCapabilities"
    });
    const capabilitiesUrl = `${wmsUrl}${wmsUrl.includes("?") ? "&" : "?"}${query}`;
    const response = await fetchImplementation.call(globalThis, capabilitiesUrl, {
        headers: { Accept: "application/xml" }
    });
    if (!response.ok) {
        throw new Error(`WMS GetCapabilities returned ${response.status}`);
    }

    const capabilitiesDocument = await response.text();
    if (
        !capabilitiesDocument.includes("<WMS_Capabilities") &&
        !capabilitiesDocument.includes("<WMT_MS_Capabilities")
    ) {
        throw new Error("WMS GetCapabilities returned an unexpected document");
    }
    return capabilitiesUrl;
}

/**
 * Ask EOLab to publish the authoritative STAC Item as a WMS layer.
 *
 * @param {Object} item Selected STAC Item.
 * @param {Function} fetchImplementation Fetch implementation used by the browser.
 * @return {Promise<{layerName: string, bbox: number[]}>} Published WMS layer.
 * @throws {Error} If publication fails or violates the response contract.
 */
export async function publishCatalogRaster(
    item,
    fetchImplementation = globalThis.fetch
) {
    const response = await fetchImplementation.call(
        globalThis,
        "/api/rendering/layers",
        {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                collectionId: item.collection,
                itemId: item.id
            })
        }
    );
    if (!response.ok) {
        const errorDocument = await response.json();
        throw new Error(errorDocument.detail);
    }

    return response.json();
}

/** Manage one WMS layer while ignoring publication results for stale selections. */
export class CatalogRasterLayerController {
    /**
     * @param {Object} leafletMap Leaflet-compatible map.
     * @param {Function} publishRaster Publishes one selected STAC Item.
     * @param {Function} layerFactory Creates a Leaflet layer from publication.
     */
    constructor(leafletMap, publishRaster, layerFactory) {
        this.leafletMap = leafletMap;
        this.publishRaster = publishRaster;
        this.layerFactory = layerFactory;
        this.activeLayer = null;
        this.requestSequence = 0;
    }

    /**
     * Publish and display one Item unless selection changed while awaiting it.
     *
     * @param {Object} item Selected STAC Item.
     * @return {Promise<Object|null>} Published layer details, or null after a
     * selection change.
     */
    async show(item) {
        const requestSequence = ++this.requestSequence;
        const publishedRaster = await this.publishRaster(item);
        if (requestSequence !== this.requestSequence) {
            return null;
        }
        this.clear();
        this.activeLayer = this.layerFactory(publishedRaster).addTo(
            this.leafletMap
        );
        return publishedRaster;
    }

    /** Invalidate pending publication and remove a displayed layer, if any. */
    clear() {
        this.requestSequence += 1;
        if (this.activeLayer !== null) {
            this.leafletMap.removeLayer(this.activeLayer);
            this.activeLayer = null;
        }
    }
}
