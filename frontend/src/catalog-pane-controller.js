/**
 * Catalog pane disclosure and progressive-inspector presentation.
 *
 * Catalog search and results remain continuously available. The selected
 * Item is revealed only when a result is chosen: CSS presents it as an
 * adjacent column when space permits and as a drill-in view otherwise.
 */

/**
 * @typedef {Object} CatalogPaneControls
 * @property {(options?: CatalogPaneFocusOptions) => void} showInspector
 * Reveals the selected Item with optional metadata initially collapsed.
 * @property {(options?: CatalogPaneFocusOptions) => void} showResults Hides
 * the selected-Item inspector and returns to the results presentation.
 * @property {() => boolean} isInspectorVisible Reports whether the selected
 * Item is currently presented.
 */

/**
 * @typedef {Object} CatalogPaneFocusOptions
 * @property {boolean} [moveFocus=false] Whether to move focus to the heading
 * of the pane being shown.
 */

/**
 * Connects the persistent Catalog results and progressive inspector navigation.
 *
 * @param {Document} documentContext Document containing the Catalog workspace.
 * @param {() => void} [onLayoutChange=() => {}] Notifies the composition root
 * when progressive inspector visibility changes the workspace allocation.
 * @return {CatalogPaneControls} Narrow presentation contract used by Catalog
 * selection without exposing layout or breakpoint decisions.
 * @throws {TypeError} When the layout-change notifier is not callable.
 * @throws {Error} When required Catalog pane markup is absent.
 */
export function initializeCatalogPaneControls(
    documentContext = document,
    onLayoutChange = () => {}
) {
    if (typeof onLayoutChange !== "function") {
        throw new TypeError("Catalog layout-change notifier must be callable");
    }
    const requiredElements = {
        layout: "#catalog-layout",
        resultsPane: "#catalog-results-pane",
        resultsBody: "#catalog-results-body",
        resultsHeading: "#catalog-results-heading",
        inspectorPane: "#catalog-item-inspector",
        inspectorBody: "#catalog-inspector-body",
        itemDetails: "#catalog-item-details",
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
     * Applies selected-Item visibility without deciding its CSS placement.
     *
     * @param {boolean} isVisible Whether the inspector is presented.
     * @param {CatalogPaneFocusOptions} [options={}] Focus behavior.
     * @return {void}
     */
    function setInspectorVisible(isVisible, { moveFocus = false } = {}) {
        const visibilityChanged = elements.inspectorPane.hidden === isVisible;
        elements.inspectorPane.hidden = !isVisible;
        elements.inspectorPane.setAttribute(
            "aria-hidden",
            String(!isVisible)
        );
        elements.inspectorBody.hidden = !isVisible;
        elements.layout.classList.toggle(
            "is-catalog-inspector-visible",
            isVisible
        );
        elements.layout.classList.toggle(
            "is-catalog-inspector-collapsed",
            !isVisible
        );
        elements.itemDetails.open = false;
        elements.inspectorBody.scrollTop = 0;

        if (moveFocus) {
            const target = isVisible
                ? elements.inspectorHeading
                : elements.resultsHeading;
            target.focus();
        }
        if (visibilityChanged) {
            onLayoutChange();
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

    setInspectorVisible(!elements.inspectorPane.hidden);

    elements.backToResults.addEventListener("click", () => {
        setInspectorVisible(false, { moveFocus: true });
    });
    elements.inspectorPane.addEventListener(
        "keydown",
        handleInspectorKeydown
    );

    return Object.freeze({
        /**
         * Reveals the selected Item with details closed and optional focus.
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
         * @return {boolean} True when the selected-Item pane is visible.
         */
        isInspectorVisible() {
            return !elements.inspectorPane.hidden;
        }
    });
}
