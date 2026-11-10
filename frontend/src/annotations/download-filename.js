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

/**
 * Prepare an edited polygon filename for download without replacing the user's name.
 * Trim surrounding whitespace and add the .geojson extension when omitted. Keep
 * spaces and Unicode within the name; reject unsafe or overlong names so the
 * dialog can explain the problem instead of silently changing the user's input.
 * @param {string} value Filename entered in the download dialog.
 * @return {string} Safe filename with a lowercase .geojson extension, at most 240 UTF-8 bytes.
 * @throws {Error} If the name is empty, contains forbidden characters, is a reserved device name, or exceeds the byte limit.
 */
export function normalizeAnnotationDownloadFilename(value) {
    const basename = value.trim().replace(/\.geojson$/i, "");
    if (!basename.trim() || /^\.+$/.test(basename.trim())) {
        throw new Error("Enter a filename before .geojson.");
    }
    if (/[<>:"/\\|?*\x00-\x1f\x7f]/.test(basename)) {
        throw new Error('Remove these characters from the filename: < > : " / \\ | ? * and control characters.');
    }
    if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(basename.split(".")[0].trimEnd())) {
        throw new Error("This filename is reserved by Windows. Choose a different name.");
    }
    const filename = `${basename}.geojson`;
    if (new TextEncoder().encode(filename).length > 240) {
        throw new Error("This filename is too long. Shorten it and try again.");
    }
    return filename;
}
