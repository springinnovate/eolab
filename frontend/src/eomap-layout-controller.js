/**
 * EOMap control-panel and Catalog-workspace layout controller.
 *
 * This component owns only disclosure state, layout classes, ARIA/hidden
 * presentation, disclosure focus, and delayed map-size invalidation. It has no
 * knowledge of Catalog Items, layers, rasters, renderers, APIs, or source data.
 */

/** Delay matching the control-panel width and transform transitions. */
export const CONTROL_PANEL_TRANSITION_MILLISECONDS = 240;

/**
 * Resolve one required element from the static EOMap layout contract.
 *
 * @param {Document} documentContext Document containing the EOMap layout.
 * @param {string} selector CSS selector for one required layout element.
 * @return {Element} The matching layout element.
 * @throws {Error} If the required element is absent.
 */
function requireLayoutElement(documentContext, selector) {
    const element = documentContext.querySelector(selector);
    if (element === null) {
        throw new Error(`Required EOMap layout element is missing: ${selector}`);
    }
    return element;
}

/**
 * @typedef {Object} EomapLayoutDependencies
 * @property {() => void} invalidateMapSize Notifies the map after transitions.
 * @property {Document} [documentContext=globalThis.document] Layout document.
 * @property {(callback: () => void, delay: number) => *} [schedule]
 * Transition scheduler; defaults to the browser timer.
 */

/** Own the EOMap panel and wide-Catalog disclosure presentation. */
export class EomapLayoutController {
    /**
     * Resolve and bind the static EOMap layout controls.
     *
     * @param {EomapLayoutDependencies} dependencies Injected presentation
     * dependencies.
     * @throws {TypeError} If invalidation or scheduling is not callable.
     * @throws {Error} If the static layout DOM contract is incomplete.
     */
    constructor({
        invalidateMapSize,
        documentContext = globalThis.document,
        schedule = globalThis.setTimeout.bind(globalThis),
    }) {
        if (typeof invalidateMapSize !== "function") {
            throw new TypeError("Map-size invalidation must be callable");
        }
        if (typeof schedule !== "function") {
            throw new TypeError("Layout transition scheduling must be callable");
        }
        this.invalidateMapSize = invalidateMapSize;
        this.documentContext = documentContext;
        this.schedule = schedule;
        this.appElement = requireLayoutElement(documentContext, "#app");
        this.controlPanelElement = requireLayoutElement(
            documentContext,
            "#control-panel"
        );
        this.collapsePanelButton = requireLayoutElement(
            documentContext,
            "#collapse-panel"
        );
        this.openPanelButton = requireLayoutElement(
            documentContext,
            "#open-panel"
        );
        this.catalogWorkspaceToggle = requireLayoutElement(
            documentContext,
            "#toggle-catalog-workspace"
        );
        this.catalogInspector = requireLayoutElement(
            documentContext,
            "#catalog-item-inspector"
        );
        this.catalogWorkspaceIsExpanded =
            this.catalogWorkspaceToggle.getAttribute("aria-expanded") !==
            "false";
        this.boundToggleCatalogWorkspace =
            this.#handleToggleCatalogWorkspace.bind(this);
        this.boundDocumentKeydown = this.#handleDocumentKeydown.bind(this);
        this.boundCollapsePanel = this.#handleCollapsePanel.bind(this);
        this.boundOpenPanel = this.#handleOpenPanel.bind(this);
        this.catalogWorkspaceToggle.addEventListener(
            "click",
            this.boundToggleCatalogWorkspace
        );
        this.documentContext.addEventListener(
            "keydown",
            this.boundDocumentKeydown
        );
        this.collapsePanelButton.addEventListener(
            "click",
            this.boundCollapsePanel
        );
        this.openPanelButton.addEventListener("click", this.boundOpenPanel);
    }

    /**
     * Set whether the Catalog uses the expanded workspace layout.
     *
     * A changed state updates the layout class, disclosure text and ARIA state,
     * inspector visibility, then schedules one post-transition map resize.
     *
     * @param {boolean} isExpanded Whether the workspace is expanded.
     * @return {void}
     */
    setCatalogWorkspaceExpanded(isExpanded) {
        if (isExpanded === this.catalogWorkspaceIsExpanded) {
            return;
        }
        this.catalogWorkspaceIsExpanded = isExpanded;
        this.appElement.classList.toggle("is-catalog-workspace", isExpanded);
        this.catalogWorkspaceToggle.setAttribute(
            "aria-expanded",
            String(isExpanded)
        );
        this.catalogWorkspaceToggle.textContent = isExpanded
            ? "Minimize catalog"
            : "Expand catalog";
        this.catalogInspector.setAttribute(
            "aria-hidden",
            String(!isExpanded)
        );
        this.#scheduleMapInvalidation();
    }

    /**
     * Set whether the complete control panel is visually collapsed.
     *
     * Collapsing first minimizes the Catalog workspace. Reopening preserves the
     * minimized Catalog state. Exactly one map invalidation is scheduled for a
     * state-changing panel action, matching the previous composition behavior.
     *
     * @param {boolean} isCollapsed Whether the panel should be collapsed.
     * @return {void}
     */
    setControlPanelCollapsed(isCollapsed) {
        const catalogWorkspaceWasExpanded =
            this.catalogWorkspaceIsExpanded;
        if (isCollapsed) {
            this.setCatalogWorkspaceExpanded(false);
        }
        this.controlPanelElement.classList.toggle(
            "is-collapsed",
            isCollapsed
        );
        this.openPanelButton.hidden = !isCollapsed;
        if (!catalogWorkspaceWasExpanded) {
            this.#scheduleMapInvalidation();
        }
    }

    /**
     * Detach every DOM listener installed during construction.
     *
     * Already scheduled invalidations still complete, matching browser timer
     * behavior; subsequent control events no longer change layout state.
     *
     * @return {void}
     */
    destroy() {
        this.catalogWorkspaceToggle.removeEventListener(
            "click",
            this.boundToggleCatalogWorkspace
        );
        this.documentContext.removeEventListener(
            "keydown",
            this.boundDocumentKeydown
        );
        this.collapsePanelButton.removeEventListener(
            "click",
            this.boundCollapsePanel
        );
        this.openPanelButton.removeEventListener("click", this.boundOpenPanel);
    }

    /** Schedule one map resize after the visual layout transition. @return {void} */
    #scheduleMapInvalidation() {
        this.schedule(
            this.invalidateMapSize,
            CONTROL_PANEL_TRANSITION_MILLISECONDS
        );
    }

    /** Toggle the wide Catalog workspace from its disclosure. @return {void} */
    #handleToggleCatalogWorkspace() {
        this.setCatalogWorkspaceExpanded(!this.catalogWorkspaceIsExpanded);
    }

    /**
     * Minimize an expanded Catalog workspace when Escape is pressed.
     *
     * @param {KeyboardEvent} keyboardEvent Document keyboard event.
     * @return {void}
     */
    #handleDocumentKeydown(keyboardEvent) {
        if (
            keyboardEvent.key !== "Escape" ||
            !this.catalogWorkspaceIsExpanded
        ) {
            return;
        }
        keyboardEvent.preventDefault();
        this.setCatalogWorkspaceExpanded(false);
        this.catalogWorkspaceToggle.focus();
    }

    /** Collapse the complete control panel. @return {void} */
    #handleCollapsePanel() {
        this.setControlPanelCollapsed(true);
    }

    /** Reopen the complete control panel. @return {void} */
    #handleOpenPanel() {
        this.setControlPanelCollapsed(false);
    }
}
