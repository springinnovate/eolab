/** Bounded gzip and Base64URL transport for portable saved-map documents. */

export const SAVED_MAP_VIEW_FRAGMENT_PREFIX = "#view=";
export const MAX_SAVED_MAP_VIEW_FRAGMENT_CHARACTERS = 128 * 1024;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BYTE_STRING_CHUNK_SIZE = 0x8000;

/**
 * Compress serialized saved-map content into a bounded URL fragment.
 *
 * @param {string} serialized Validated saved-map JSON text.
 * @param {Object} [options] Codec dependencies and resource limits.
 * @param {number} [options.maximumInputBytes] Maximum uncompressed byte count.
 * @param {number} [options.maximumFragmentCharacters] Maximum fragment length.
 * @param {typeof CompressionStream} [options.CompressionStreamClass]
 * Browser gzip stream constructor.
 * @return {Promise<string>} Complete `#view=` fragment with an unpadded
 * Base64URL payload.
 * @throws {Error} If input, browser support, or output violates the contract.
 */
export async function encodeSavedMapViewFragment(
    serialized,
    {
        maximumInputBytes,
        maximumFragmentCharacters = MAX_SAVED_MAP_VIEW_FRAGMENT_CHARACTERS,
        CompressionStreamClass = globalThis.CompressionStream,
    } = {}
) {
    if (typeof serialized !== "string") {
        throw new Error("Saved map content must be text.");
    }
    requirePositiveLimit(maximumInputBytes, "uncompressed saved-map limit");
    requirePositiveLimit(maximumFragmentCharacters, "map-link limit");
    requireTransformSupport(CompressionStreamClass, "compress");
    const input = new TextEncoder().encode(serialized);
    if (input.byteLength > maximumInputBytes) {
        throw new Error(formatUncompressedLimit(maximumInputBytes));
    }
    const maximumCompressedBytes = Math.floor(
        (maximumFragmentCharacters - SAVED_MAP_VIEW_FRAGMENT_PREFIX.length) *
        3 / 4
    );
    const compressed = await transformBytes(
        input,
        new CompressionStreamClass("gzip"),
        maximumCompressedBytes,
        "The compressed map view is too large to share as a link."
    );
    const fragment = SAVED_MAP_VIEW_FRAGMENT_PREFIX +
        encodeBase64Url(compressed);
    if (fragment.length > maximumFragmentCharacters) {
        throw new Error(
            "The compressed map view is too large to share as a link."
        );
    }
    return fragment;
}

/**
 * Decode one bounded `#view=` fragment into saved-map JSON text.
 *
 * @param {string} fragment Candidate browser fragment.
 * @param {Object} [options] Codec dependencies and resource limits.
 * @param {number} [options.maximumOutputBytes] Maximum decompressed byte count.
 * @param {number} [options.maximumFragmentCharacters] Maximum fragment length.
 * @param {typeof DecompressionStream} [options.DecompressionStreamClass]
 * Browser gzip stream constructor.
 * @return {Promise<string>} Decoded UTF-8 JSON text.
 * @throws {Error} If syntax, browser support, compression, or limits fail.
 */
export async function decodeSavedMapViewFragment(
    fragment,
    {
        maximumOutputBytes,
        maximumFragmentCharacters = MAX_SAVED_MAP_VIEW_FRAGMENT_CHARACTERS,
        DecompressionStreamClass = globalThis.DecompressionStream,
    } = {}
) {
    requirePositiveLimit(maximumOutputBytes, "uncompressed saved-map limit");
    requirePositiveLimit(maximumFragmentCharacters, "map-link limit");
    if (typeof fragment !== "string" ||
        !fragment.startsWith(SAVED_MAP_VIEW_FRAGMENT_PREFIX)) {
        throw new Error("This URL does not contain an EOLab map view.");
    }
    if (fragment.length > maximumFragmentCharacters) {
        throw new Error("The map link is too large to open safely.");
    }
    const payload = fragment.slice(SAVED_MAP_VIEW_FRAGMENT_PREFIX.length);
    if (payload.length === 0 || !BASE64URL_PATTERN.test(payload)) {
        throw new Error("The map link contains an invalid encoded view.");
    }
    requireTransformSupport(DecompressionStreamClass, "open compressed");
    let compressed;
    try {
        compressed = decodeBase64Url(payload);
    } catch {
        throw new Error("The map link contains an invalid encoded view.");
    }
    let decompressed;
    try {
        decompressed = await transformBytes(
            compressed,
            new DecompressionStreamClass("gzip"),
            maximumOutputBytes,
            formatUncompressedLimit(maximumOutputBytes)
        );
    } catch (error) {
        if (error instanceof ResourceLimitError) throw error;
        throw new Error("The map link does not contain valid compressed data.");
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(decompressed);
    } catch {
        throw new Error("The map link does not contain valid UTF-8 content.");
    }
}

/**
 * Test whether a browser fragment declares a saved-map payload.
 *
 * @param {unknown} fragment Candidate fragment value.
 * @return {boolean} Whether the saved-map prefix is present.
 */
export function isSavedMapViewFragment(fragment) {
    return typeof fragment === "string" &&
        fragment.startsWith(SAVED_MAP_VIEW_FRAGMENT_PREFIX);
}

/** Error used internally to preserve bounded-output failures. */
class ResourceLimitError extends Error {}

/**
 * Transform bytes through a browser stream while enforcing an output bound.
 *
 * @param {Uint8Array} input Input bytes.
 * @param {{readable:ReadableStream,writable:WritableStream}} transform Stream.
 * @param {number} maximumOutputBytes Maximum accepted output bytes.
 * @param {string} limitMessage User-facing bound failure.
 * @return {Promise<Uint8Array>} Concatenated bounded output.
 */
async function transformBytes(
    input,
    transform,
    maximumOutputBytes,
    limitMessage
) {
    if (maximumOutputBytes <= 0) throw new ResourceLimitError(limitMessage);
    const reader = transform.readable.getReader();
    const writer = transform.writable.getWriter();
    const chunks = [];
    let byteLength = 0;
    const readOutput = async () => {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            byteLength += value.byteLength;
            if (byteLength > maximumOutputBytes) {
                throw new ResourceLimitError(limitMessage);
            }
            chunks.push(value);
        }
    };
    try {
        await Promise.all([
            (async () => {
                await writer.write(input);
                await writer.close();
            })(),
            readOutput(),
        ]);
    } catch (error) {
        await Promise.allSettled([
            writer.abort(error),
            reader.cancel(error),
        ]);
        throw error;
    }
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

/**
 * Encode bytes as unpadded URL-safe Base64 without large argument spreads.
 *
 * @param {Uint8Array} bytes Bytes to encode.
 * @return {string} Unpadded Base64URL content.
 */
function encodeBase64Url(bytes) {
    let byteString = "";
    for (let offset = 0; offset < bytes.length;
        offset += BYTE_STRING_CHUNK_SIZE) {
        byteString += String.fromCharCode(
            ...bytes.subarray(offset, offset + BYTE_STRING_CHUNK_SIZE)
        );
    }
    return globalThis.btoa(byteString)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
}

/**
 * Decode unpadded Base64URL content into bytes.
 *
 * @param {string} payload Unpadded Base64URL content.
 * @return {Uint8Array} Decoded bytes.
 */
function decodeBase64Url(payload) {
    const padded = payload.replaceAll("-", "+").replaceAll("_", "/") +
        "=".repeat((4 - payload.length % 4) % 4);
    const byteString = globalThis.atob(padded);
    return Uint8Array.from(byteString, (character) => character.charCodeAt(0));
}

/**
 * Require one explicit finite positive resource bound.
 *
 * @param {unknown} value Candidate limit.
 * @param {string} label Limit name for programming errors.
 * @return {void}
 */
function requirePositiveLimit(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${label} must be a positive integer.`);
    }
}

/**
 * Require browser-native compression support.
 *
 * @param {unknown} StreamClass Candidate stream constructor.
 * @param {string} operation User-facing operation phrase.
 * @return {void}
 */
function requireTransformSupport(StreamClass, operation) {
    if (typeof StreamClass !== "function") {
        throw new Error(`This browser cannot ${operation} shared map links.`);
    }
}

/**
 * Format a decompressed saved-map byte limit for users.
 *
 * @param {number} byteLimit Maximum uncompressed byte count.
 * @return {string} User-facing bound failure.
 */
function formatUncompressedLimit(byteLimit) {
    const kibibytes = Math.floor(byteLimit / 1024);
    return `Saved map content must be ${kibibytes} KiB or smaller.`;
}
