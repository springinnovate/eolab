/** Shared non-modal presentation surface for independent map-side tools. */
export class MapInspectionController {
    /**
     * Bind independent close controls for the shared exploration surface.
     *
     * @param {Object} dependencies Presentation dependencies.
     * @param {Document} [dependencies.documentContext=document] Owning document.
     */
    constructor({ documentContext = document } = {}) {
        this.document = documentContext;
        this.root = documentContext.querySelector("#map-inspection");
        this.histogram = documentContext.querySelector("#map-histogram-panel");
        this.style = documentContext.querySelector("#layer-style-editor");
        this.feature = documentContext.querySelector("#vector-feature-inspector");
        this.featureDetails = documentContext.querySelector(
            "#vector-feature-inspector-details"
        );
        this.featureDetailsToggle = documentContext.querySelector(
            "#toggle-vector-inspector-details"
        );
        this.vectorTimeSeries = documentContext.querySelector(
            "#vector-time-series"
        );
        this.vectorFeatureProfile = documentContext.querySelector(
            "#vector-feature-profile"
        );
        this.analysisToolsButton = documentContext.querySelector(
            "#open-analysis-tools"
        );
        this.map = documentContext.querySelector("#map");
        this.closeButton = documentContext.querySelector("#close-map-histogram");
        this.isOpen = false;
        this.onClose = () => this.closeHistogram();
        this.onToggleFeatureDetails = () =>
            this.setFeatureInspectorExpanded(this.featureDetails.hidden);
        this.onKeydown = (event) => {
            if (event.key !== "Escape" || this.histogram.hidden ||
                !this.histogram.contains(this.document.activeElement)) return;
            event.preventDefault();
            event.stopPropagation();
            this.closeHistogram();
        };
        this.closeButton.addEventListener("click", this.onClose);
        this.featureDetailsToggle.addEventListener(
            "click", this.onToggleFeatureDetails
        );
        this.document.addEventListener("keydown", this.onKeydown);
    }

    /** Reveal histogram results without changing analysis. @return {void} */
    showHistogram() {
        this.histogram.hidden = false;
        this.#synchronize();
    }

    /** Hide histogram results and return focus to the map. @return {void} */
    closeHistogram() {
        if (this.histogram.hidden) return;
        this.histogram.hidden = true;
        this.#synchronize();
        this.map.focus();
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

    /**
     * Reveal vector feature results without changing retained map layers.
     *
     * @return {void}
     */
    showFeatureInspector() {
        this.feature.hidden = false;
        this.#synchronize();
    }

    /**
     * Hide vector feature results without changing any other map-side tool.
     *
     * @return {void}
     */
    hideFeatureInspector() {
        this.feature.hidden = true;
        this.#synchronize();
    }

    /**
     * Collapse or expand Feature Inspector details without changing its data.
     *
     * @param {boolean} expanded Whether detailed inspector content is visible.
     * @return {void}
     */
    setFeatureInspectorExpanded(expanded) {
        this.featureDetails.hidden = !expanded;
        this.featureDetailsToggle.setAttribute(
            "aria-expanded", String(expanded)
        );
        this.featureDetailsToggle.textContent = expanded ? "Collapse" : "Expand";
    }

    /** Reveal selected-feature analysis as the active series presentation. @return {void} */
    showVectorTimeSeries() {
        this.vectorFeatureProfile.hidden = true;
        this.vectorTimeSeries.hidden = false;
        this.#synchronize();
    }

    /**
     * Hide vector time-series analysis without clearing its retained settings.
     *
     * @param {boolean} [moveFocus=false] Restore focus to the map.
     * @return {void}
     */
    hideVectorTimeSeries(moveFocus = false) {
        this.vectorTimeSeries.hidden = true;
        this.#synchronize();
        if (moveFocus) this.map.focus();
    }

    /** Reveal feature-field analysis as the active series presentation. @return {void} */
    showVectorFeatureProfile() {
        this.vectorTimeSeries.hidden = true;
        this.vectorFeatureProfile.hidden = false;
        this.#synchronize();
    }

    /**
     * Hide feature-field analysis without clearing its per-source settings.
     *
     * @param {boolean} [moveFocus=false] Restore focus to the map.
     * @return {void}
     */
    hideVectorFeatureProfile(moveFocus = false) {
        this.vectorFeatureProfile.hidden = true;
        this.#synchronize();
        if (moveFocus) this.map.focus();
    }

    /** Keep one native top-layer surface open while either tool is visible. @return {void} */
    #synchronize() {
        const shouldOpen = !this.histogram.hidden || !this.style.hidden ||
            !this.feature.hidden || !this.vectorTimeSeries.hidden ||
            !this.vectorFeatureProfile.hidden;
        this.analysisToolsButton.hidden = shouldOpen;
        if (shouldOpen === this.isOpen) return;
        this.isOpen = shouldOpen;
        if (shouldOpen) this.root.showPopover();
        else this.root.hidePopover();
    }

    /** Release presentation listeners without changing retained analysis state. @return {void} */
    destroy() {
        this.closeButton.removeEventListener("click", this.onClose);
        this.featureDetailsToggle.removeEventListener(
            "click", this.onToggleFeatureDetails
        );
        this.document.removeEventListener("keydown", this.onKeydown);
        this.histogram.hidden = true;
        this.style.hidden = true;
        this.feature.hidden = true;
        this.vectorTimeSeries.hidden = true;
        this.vectorFeatureProfile.hidden = true;
        this.setFeatureInspectorExpanded(true);
        this.#synchronize();
    }
}
