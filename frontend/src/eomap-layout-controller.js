/**
 * EOMap control-panel and workspace disclosure controller.
 *
 * This component owns only disclosure state, layout classes, ARIA/hidden
 * presentation, disclosure focus, and delayed map-size invalidation. It has no
 * knowledge of Catalog Items, layers, rasters, renderers, APIs, or source data.
 */

/** Delay matching the control-panel width and transform transitions. */
export const CONTROL_PANEL_TRANSITION_MILLISECONDS = 240;

/**
 * @typedef {Object} WorkspaceDisclosureConfiguration
 * @property {string} regionSelector Selector for the semantic region.
 * @property {string} toggleSelector Selector for the region disclosure button.
 * @property {string} bodySelector Selector for the disclosed region body.
 * @property {string} name Lowercase accessible name used in button text.
 */

/**
 * @typedef {Object} WorkspaceDisclosureState
 * @property {WorkspaceDisclosureConfiguration} configuration Static contract.
 * @property {Element} region Semantic workspace region.
 * @property {Element} toggle Disclosure button.
 * @property {Element} body Disclosed region body.
 * @property {boolean} isExpanded Whether the body is available.
 * @property {() => void} handleToggle Bound click listener.
 */

/** @type {WorkspaceDisclosureConfiguration[]} */
const WORKSPACE_DISCLOSURES = [
    {
        regionSelector: "#eomap-operational-status-region",
        toggleSelector: "#toggle-operational-status",
        bodySelector: "#eomap-operational-status-body",
        name: "operational status",
    },
    {
        regionSelector: "#eomap-map-layers-region",
        toggleSelector: "#toggle-map-layers",
        bodySelector: "#eomap-map-layers-body",
        name: "map and layers",
    },
    {
        regionSelector: "#eomap-raster-interpretation-region",
        toggleSelector: "#toggle-raster-interpretation",
        bodySelector: "#eomap-raster-interpretation-body",
        name: "raster interpretation",
    },
];

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

/** Own the EOMap panel and workspace disclosure presentation. */
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
        this.catalogRegion = requireLayoutElement(
            documentContext,
            "#eomap-catalog-region"
        );
        this.catalogWorkspaceIsExpanded =
            this.catalogWorkspaceToggle.getAttribute("aria-expanded") !==
            "false";
        this.controlPanelIsCollapsed =
            this.controlPanelElement.classList.contains("is-collapsed");
        this.workspaceDisclosures = WORKSPACE_DISCLOSURES.map(
            (configuration) => this.#createWorkspaceDisclosure(configuration)
        );
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
        this.#synchronizeCatalogWorkspacePresentation();
        this.#synchronizeControlPanelPresentation();
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
        this.#synchronizeCatalogWorkspacePresentation();
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
        if (isCollapsed === this.controlPanelIsCollapsed) {
            return;
        }
        const catalogWorkspaceWasExpanded =
            this.catalogWorkspaceIsExpanded;
        if (isCollapsed) {
            this.setCatalogWorkspaceExpanded(false);
        }
        this.controlPanelIsCollapsed = isCollapsed;
        this.#synchronizeControlPanelPresentation();
        if (!catalogWorkspaceWasExpanded) {
            this.#scheduleMapInvalidation();
        }
        if (isCollapsed) {
            this.openPanelButton.focus();
        } else {
            this.collapsePanelButton.focus();
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
        for (const disclosure of this.workspaceDisclosures) {
            disclosure.toggle.removeEventListener(
                "click",
                disclosure.handleToggle
            );
        }
    }

    /**
     * Resolve, initialize, and bind one semantically identical workspace
     * disclosure.
     *
     * @param {WorkspaceDisclosureConfiguration} configuration Static DOM and
     * accessible-name contract.
     * @return {WorkspaceDisclosureState} Bound disclosure state and elements.
     * @throws {Error} If any required disclosure element is absent.
     */
    #createWorkspaceDisclosure(configuration) {
        /** @type {WorkspaceDisclosureState} */
        const disclosure = {
            configuration,
            region: requireLayoutElement(
                this.documentContext,
                configuration.regionSelector
            ),
            toggle: requireLayoutElement(
                this.documentContext,
                configuration.toggleSelector
            ),
            body: requireLayoutElement(
                this.documentContext,
                configuration.bodySelector
            ),
            isExpanded: false,
            handleToggle() {},
        };
        disclosure.isExpanded =
            disclosure.toggle.getAttribute("aria-expanded") !== "false";
        disclosure.handleToggle = () => {
            this.#setWorkspaceDisclosureExpanded(
                disclosure,
                !disclosure.isExpanded
            );
        };
        disclosure.toggle.addEventListener("click", disclosure.handleToggle);
        this.#synchronizeWorkspaceDisclosure(disclosure);
        return disclosure;
    }

    /**
     * Apply one workspace disclosure state and schedule map remeasurement.
     *
     * @param {WorkspaceDisclosureState} disclosure Workspace disclosure state.
     * @param {boolean} isExpanded Whether its body should be available.
     * @return {void}
     */
    #setWorkspaceDisclosureExpanded(disclosure, isExpanded) {
        if (isExpanded === disclosure.isExpanded) {
            return;
        }
        disclosure.isExpanded = isExpanded;
        this.#synchronizeWorkspaceDisclosure(disclosure);
        this.#scheduleMapInvalidation();
    }

    /**
     * Synchronize classes, ARIA, hidden state, and button text for one region.
     *
     * @param {WorkspaceDisclosureState} disclosure Workspace disclosure state.
     * @return {void}
     */
    #synchronizeWorkspaceDisclosure(disclosure) {
        disclosure.region.classList.toggle(
            "is-collapsed",
            !disclosure.isExpanded
        );
        disclosure.toggle.setAttribute(
            "aria-expanded",
            String(disclosure.isExpanded)
        );
        disclosure.toggle.textContent =
            (disclosure.isExpanded ? "Collapse " : "Expand ") +
            disclosure.configuration.name;
        disclosure.body.hidden = !disclosure.isExpanded;
        disclosure.body.setAttribute(
            "aria-hidden",
            String(!disclosure.isExpanded)
        );
    }

    /** Synchronize the outer Catalog workspace presentation. @return {void} */
    #synchronizeCatalogWorkspacePresentation() {
        this.appElement.classList.toggle(
            "is-catalog-workspace",
            this.catalogWorkspaceIsExpanded
        );
        this.catalogWorkspaceToggle.setAttribute(
            "aria-expanded",
            String(this.catalogWorkspaceIsExpanded)
        );
        this.catalogWorkspaceToggle.textContent =
            this.catalogWorkspaceIsExpanded
                ? "Minimize catalog"
                : "Expand catalog";
        this.catalogInspector.hidden = !this.catalogWorkspaceIsExpanded;
        this.catalogInspector.setAttribute(
            "aria-hidden",
            String(!this.catalogWorkspaceIsExpanded)
        );
    }

    /** Synchronize the complete panel's accessible presentation. @return {void} */
    #synchronizeControlPanelPresentation() {
        this.controlPanelElement.classList.toggle(
            "is-collapsed",
            this.controlPanelIsCollapsed
        );
        this.controlPanelElement.setAttribute(
            "aria-hidden",
            String(this.controlPanelIsCollapsed)
        );
        if (this.controlPanelIsCollapsed) {
            this.controlPanelElement.setAttribute("inert", "");
        } else {
            this.controlPanelElement.removeAttribute("inert");
        }
        this.controlPanelElement.inert = this.controlPanelIsCollapsed;
        this.collapsePanelButton.setAttribute(
            "aria-expanded",
            String(!this.controlPanelIsCollapsed)
        );
        this.openPanelButton.setAttribute(
            "aria-expanded",
            String(!this.controlPanelIsCollapsed)
        );
        this.openPanelButton.hidden = !this.controlPanelIsCollapsed;
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
     * Collapse the focused workspace disclosure when Escape is pressed.
     *
     * Native form controls keep Escape. A focused map/layers, raster, or
     * operational-status region collapses independently; otherwise a focused
     * expanded Catalog workspace minimizes and receives focus.
     *
     * @param {KeyboardEvent} keyboardEvent Document keyboard event.
     * @return {void}
     */
    #handleDocumentKeydown(keyboardEvent) {
        if (keyboardEvent.key !== "Escape") {
            return;
        }
        const focusedElement = this.documentContext.activeElement;
        if (this.#focusOwnsEscape(focusedElement)) {
            return;
        }
        const focusedDisclosure = this.workspaceDisclosures.find(
            (disclosure) =>
                disclosure.isExpanded &&
                disclosure.region.contains(focusedElement)
        );
        if (focusedDisclosure !== undefined) {
            keyboardEvent.preventDefault();
            this.#setWorkspaceDisclosureExpanded(focusedDisclosure, false);
            focusedDisclosure.toggle.focus();
            return;
        }
        if (
            !this.catalogWorkspaceIsExpanded ||
            (
                focusedElement !== null &&
                focusedElement !== undefined &&
                focusedElement !== this.catalogWorkspaceToggle &&
                !this.catalogRegion.contains(focusedElement)
            )
        ) {
            return;
        }
        keyboardEvent.preventDefault();
        this.setCatalogWorkspaceExpanded(false);
        this.catalogWorkspaceToggle.focus();
    }

    /**
     * Report whether the focused native input should retain Escape handling.
     *
     * @param {Element|null} focusedElement Current document focus target.
     * @return {boolean} Whether the layout controller must ignore Escape.
     */
    #focusOwnsEscape(focusedElement) {
        if (focusedElement === null || focusedElement === undefined) {
            return false;
        }
        return ["INPUT", "SELECT", "TEXTAREA"].includes(
            focusedElement.tagName
        );
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
