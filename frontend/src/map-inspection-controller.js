/** Shared non-modal map-side presentation for histograms and layer styling. */
export class MapInspectionController {
    /**
     * Bind the persistent histogram opener and its independent close control.
     * @param {Object} dependencies Presentation dependencies.
     * @param {Document} [dependencies.documentContext=document] Owning document.
     * @param {() => void} dependencies.onHistogramClose Pauses map selection.
     */
    constructor({ documentContext = document, onHistogramClose }) {
        this.document = documentContext;
        this.onHistogramClose = onHistogramClose;
        this.root = documentContext.querySelector("#map-inspection");
        this.histogram = documentContext.querySelector("#map-histogram-panel");
        this.style = documentContext.querySelector("#layer-style-editor");
        this.opener = documentContext.querySelector("#open-map-histogram");
        this.closeButton = documentContext.querySelector("#close-map-histogram");
        this.isOpen = false;
        this.onOpen = () => this.showHistogram(true);
        this.onClose = () => this.closeHistogram();
        this.onKeydown = (event) => {
            if (event.key !== "Escape" || this.histogram.hidden ||
                !(this.histogram.contains(this.document.activeElement) ||
                    this.document.activeElement === this.opener)) return;
            event.preventDefault();
            event.stopPropagation();
            this.closeHistogram();
        };
        this.opener.addEventListener("click", this.onOpen);
        this.closeButton.addEventListener("click", this.onClose);
        this.document.addEventListener("keydown", this.onKeydown);
    }

    /**
     * Reveal results and hide their redundant opener without changing analysis.
     * @param {boolean} [moveFocus=false] Focus Close for an explicit opener click.
     * @return {void}
     */
    showHistogram(moveFocus = false) {
        this.histogram.hidden = false;
        this.opener.hidden = true;
        this.opener.setAttribute("aria-expanded", "true");
        this.#synchronize();
        if (moveFocus) this.closeButton.focus();
    }

    /** Pause selection, retain results, and return focus to the map opener. @return {void} */
    closeHistogram() {
        if (this.histogram.hidden) return;
        this.histogram.hidden = true;
        this.opener.hidden = false;
        this.opener.setAttribute("aria-expanded", "false");
        this.onHistogramClose();
        this.#synchronize();
        this.opener.focus();
    }

    /** Reveal styling alongside any open histogram without stealing its state. @return {void} */
    showStyle() {
        this.style.hidden = false;
        this.#synchronize();
    }

    /** Hide styling without closing an open histogram or changing its sample. @return {void} */
    hideStyle() {
        this.style.hidden = true;
        this.#synchronize();
    }

    /** Keep one native top-layer surface open while either tool is visible. @return {void} */
    #synchronize() {
        const shouldOpen = !this.histogram.hidden || !this.style.hidden;
        if (shouldOpen === this.isOpen) return;
        this.isOpen = shouldOpen;
        if (shouldOpen) this.root.showPopover();
        else this.root.hidePopover();
    }

    /** Release presentation listeners without changing retained analysis state. @return {void} */
    destroy() {
        this.opener.removeEventListener("click", this.onOpen);
        this.closeButton.removeEventListener("click", this.onClose);
        this.document.removeEventListener("keydown", this.onKeydown);
        this.histogram.hidden = true;
        this.style.hidden = true;
        this.opener.setAttribute("aria-expanded", "false");
        this.opener.hidden = false;
        this.#synchronize();
    }
}
