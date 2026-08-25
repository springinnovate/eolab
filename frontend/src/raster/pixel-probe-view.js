/**
 * DOM presentation adapter for the floating raster pixel readout.
 *
 * This adapter owns probe element lookup and presentation only. Pixel request
 * scheduling, value formatting, viewport positioning decisions, and raster
 * lifecycle state remain outside it.
 */
import { requireRasterControl } from "./required-control.js";

/** Own floating pixel-probe DOM presentation. */
export class RasterPixelProbeView {
    /**
     * Resolve the required pixel-probe elements once at startup.
     *
     * @param {Document} [documentContext=globalThis.document] Document that
     * owns the probe.
     * @throws {Error} If any required probe element is missing.
     */
    constructor(documentContext = globalThis.document) {
        this.pixelProbe = requireRasterControl(
            documentContext,
            "#raster-pixel-probe"
        );
        this.pixelProbeName = requireRasterControl(
            documentContext,
            "#raster-pixel-probe-name"
        );
        this.pixelProbeReading = requireRasterControl(
            documentContext,
            "#raster-pixel-probe-reading"
        );
    }

    /**
     * Return whether the pointer probe is currently visible.
     *
     * @return {boolean} Whether the pointer probe is visible.
     */
    isVisible() {
        return !this.pixelProbe.hidden;
    }

    /**
     * Replace the raster name and sampled detail in the pointer probe.
     *
     * @param {string} label Raster display basename.
     * @param {string} detail Formatted coordinate and sample detail.
     * @return {void}
     */
    setContent(label, detail) {
        this.pixelProbeName.textContent = label;
        this.pixelProbeName.title = label;
        this.pixelProbeReading.textContent = detail;
    }

    /**
     * Show and measure the pointer probe after its content changes.
     *
     * @return {{width: number, height: number}} Probe dimensions.
     */
    show() {
        this.pixelProbe.hidden = false;
        const bounds = this.pixelProbe.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
    }

    /**
     * Move the pointer probe to one browser-viewport position.
     *
     * @param {{x: number, y: number}} position Probe top-left position.
     * @return {void}
     */
    position(position) {
        this.pixelProbe.style.transform =
            `translate3d(${position.x}px, ${position.y}px, 0)`;
    }

    /** Hide the pointer probe without changing retained content. @return {void} */
    hide() {
        this.pixelProbe.hidden = true;
    }
}
