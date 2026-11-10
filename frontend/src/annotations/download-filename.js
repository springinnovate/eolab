/** Name polygon downloads so their map, layer and export time remain recognizable. */

/**
 * Build a GeoJSON filename from admitted layer identity and the current named map.
 * The twelve identity characters refer to the shared session, or to
 * the local layer for private drawings. The UTC timestamp is the export time,
 * not a content revision. Shorten only the readable layer name to keep the whole
 * filename within 240 UTF-8 bytes, preserving the map, identity and time.
 * @param {Object} options Export metadata supplied by the annotation owner.
 * @param {string} options.name Layer display name.
 * @param {string} options.layerId Shared session UUID or admitted alphanumeric/hyphen private layer ID.
 * @param {string|null} [options.mapSlug=null] Validated published-map URL name (at most 80 ASCII characters).
 * @param {Date} [options.exportedAt=new Date()] Valid export instant.
 * @return {string} Filename safe for a browser's download attribute, ending in .geojson.
 */
export function createAnnotationDownloadFilename({ name, layerId, mapSlug = null, exportedAt = new Date() }) {
    const prefix = mapSlug ? `${mapSlug}_` : "";
    const identity = layerId.replaceAll("-", "").slice(0, 12);
    const suffix = `_${identity}_${exportedAt.toISOString().replaceAll(":", "")}.geojson`;
    let readableName = name.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_").trim().replace(/\s+/g, "-").replace(/\.+$/, "") || "annotations";
    // Windows reserves these names even when followed by a dot and an extension.
    if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])\./i.test(readableName)) readableName = `_${readableName}`;
    const encoder = new TextEncoder();
    const budget = 240 - encoder.encode(prefix + suffix).length;
    let shortenedName = "";
    let bytes = 0;
    for (const character of readableName) {
        bytes += encoder.encode(character).length;
        if (bytes > budget) break;
        shortenedName += character;
    }
    return `${prefix}${shortenedName}${suffix}`;
}
