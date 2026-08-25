/**
 * Catalog pane disclosure and progressive-inspector presentation.
 *
 * Catalog results retain their independent disclosure state. The selected
 * record is revealed only when a result is chosen: CSS presents it as an
 * adjacent column when space permits and as a drill-in view otherwise.
 */

/**
 * @typedef {Object} CatalogPaneControls
 * @property {(options?: CatalogPaneFocusOptions) => void} showInspector
 * Reveals and expands the selected-record inspector.
 * @property {(options?: CatalogPaneFocusOptions) => void} showResults Hides
 * the selected-record inspector and returns to the results presentation.
 * @property {() => boolean} isInspectorVisible Reports whether the selected
 * record is currently presented.
 */

/**
 * @typedef {Object} CatalogPaneFocusOptions
 * @property {boolean} [moveFocus=false] Whether to move focus to the heading
 * of the pane being shown.
 */

/**
 * Connects Catalog result disclosure and progressive inspector navigation.
 *
 * @param {Document} documentContext Document containing the Catalog workspace.
 * @return {CatalogPaneControls} Narrow presentation contract used by Catalog
 * selection without exposing layout or breakpoint decisions.
 * @throws {Error} When required Catalog pane markup is absent.
 */
export function initializeCatalogPaneControls(documentContext = document) {
    const requiredElements = {
        layout: "#catalog-layout",
        resultsPane: "#catalog-results-pane",
        resultsBody: "#catalog-results-body",
        resultsToggle: "#toggle-catalog-results",
        resultsHeading: "#catalog-results-heading",
        inspectorPane: "#catalog-item-inspector",
        inspectorBody: "#catalog-inspector-body",
        inspectorToggle: "#toggle-catalog-inspector",
        inspectorHeading: "#catalog-inspector-heading",
        backToResults: "#back-to-catalog-results"
    };
    const elements = Object.fromEntries(
        Object.entries(requiredElements).map(([key, selector]) => [
            key,
            documentContext.querySelector(selector)
        ])
    );
    const missingElement = Object.entries(elements).find(
        ([, element]) => element === null
    );
    if (missingElement !== undefined) {
        throw new Error(
            `Catalog panes require ${requiredElements[missingElement[0]]}`
        );
    }

    /**
     * Applies the Catalog-results disclosure state.
     *
     * @param {boolean} isExpanded Whether result controls and cards are shown.
     * @return {void}
     */
    function setResultsExpanded(isExpanded) {
        elements.resultsBody.hidden = !isExpanded;
        elements.resultsPane.classList.toggle("is-collapsed", !isExpanded);
        elements.layout.classList.toggle(
            "is-catalog-browser-collapsed",
            !isExpanded
        );
        elements.resultsToggle.setAttribute(
            "aria-expanded",
            String(isExpanded)
        );
        elements.resultsToggle.textContent = `${
            isExpanded ? "Collapse" : "Expand"
        } Catalog results`;
    }

    /**
     * Applies selected-record visibility without deciding its CSS placement.
     *
     * @param {boolean} isVisible Whether the inspector is presented.
     * @param {CatalogPaneFocusOptions} [options={}] Focus behavior.
     * @return {void}
     */
    function setInspectorVisible(isVisible, { moveFocus = false } = {}) {
        elements.inspectorPane.hidden = !isVisible;
        elements.inspectorPane.setAttribute(
            "aria-hidden",
            String(!isVisible)
        );
        elements.inspectorBody.hidden = !isVisible;
        elements.inspectorPane.classList.toggle("is-collapsed", !isVisible);
        elements.layout.classList.toggle(
            "is-catalog-inspector-visible",
            isVisible
        );
        elements.layout.classList.toggle(
            "is-catalog-inspector-collapsed",
            !isVisible
        );
        elements.inspectorToggle.setAttribute(
            "aria-expanded",
            String(isVisible)
        );
        elements.inspectorToggle.textContent = `${
            isVisible ? "Collapse" : "Expand"
        } Selected record`;

        if (moveFocus) {
            const target = isVisible
                ? elements.inspectorHeading
                : elements.resultsHeading;
            target.focus();
        }
    }

    /**
     * Returns from the active inspector without closing the Catalog workspace.
     *
     * @param {KeyboardEvent} event Keyboard event dispatched within inspector.
     * @return {void}
     */
    function handleInspectorKeydown(event) {
        if (event.key !== "Escape" || elements.inspectorPane.hidden) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        setInspectorVisible(false, { moveFocus: true });
    }

    setResultsExpanded(
        elements.resultsToggle.getAttribute("aria-expanded") !== "false"
    );
    setInspectorVisible(!elements.inspectorPane.hidden);

    elements.resultsToggle.addEventListener("click", () => {
        setResultsExpanded(
            elements.resultsToggle.getAttribute("aria-expanded") !== "true"
        );
    });
    elements.inspectorToggle.addEventListener("click", () => {
        setInspectorVisible(false, { moveFocus: true });
    });
    elements.backToResults.addEventListener("click", () => {
        setInspectorVisible(false, { moveFocus: true });
    });
    elements.inspectorPane.addEventListener(
        "keydown",
        handleInspectorKeydown
    );

    return Object.freeze({
        /**
         * Reveals the selected record and optionally focuses its heading.
         *
         * @param {CatalogPaneFocusOptions} [options={}] Focus behavior.
         * @return {void}
         */
        showInspector(options = {}) {
            setInspectorVisible(true, options);
        },

        /**
         * Returns to results and optionally focuses their heading.
         *
         * @param {CatalogPaneFocusOptions} [options={}] Focus behavior.
         * @return {void}
         */
        showResults(options = {}) {
            setInspectorVisible(false, options);
        },

        /**
         * Reports the current inspector presentation state.
         *
         * @return {boolean} True when the selected-record pane is visible.
         */
        isInspectorVisible() {
            return !elements.inspectorPane.hidden;
        }
    });
}
