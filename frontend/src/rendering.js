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
