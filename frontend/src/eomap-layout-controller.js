/**
 * EOMap control-panel and workspace disclosure controller.
 *
 * This component owns only disclosure state, layout classes, ARIA/hidden
 * presentation, disclosure focus, and delayed map-size invalidation. It has no
 * knowledge of Catalog Items, layers, rasters, renderers, APIs, or source data.
 */

/** Delay matching the workspace rail and control-panel transitions. */
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
];

/**
 * @typedef {Object} ToolTabConfiguration
 * @property {string} tabSelector Selector for the workbench tab.
 * @property {string} panelSelector Selector for the owned semantic panel.
 */

/**
 * @typedef {Object} ToolTabState
 * @property {Element} tab Workbench tab element.
 * @property {Element} panel Semantic panel selected by the tab.
 * @property {() => void} handleClick Bound selection listener.
 * @property {(event: KeyboardEvent) => void} handleKeydown Bound keyboard
 * listener.
 */

/** @type {ToolTabConfiguration[]} */
const TOOL_TABS = [
    {
        tabSelector: "#toggle-map-layers",
        panelSelector: "#eomap-map-layers-region",
    },
    {
        tabSelector: "#toggle-raster-interpretation",
        panelSelector: "#eomap-raster-interpretation-region",
    },
    {
        tabSelector: "#show-temporary-aoi-workspace",
        panelSelector: "#temporary-aoi",
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

/** Own the EOMap panel, rail, tab, and disclosure presentation. */
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
        this.catalogRegion = requireLayoutElement(
            documentContext,
            "#eomap-catalog-region"
        );
        this.openCatalogWorkspaceButton = requireLayoutElement(
            documentContext,
            "#open-catalog-workspace"
        );
        this.toolsNavigation = requireLayoutElement(
            documentContext,
            "#eomap-tools-workbench"
        );
        this.toolsWorkspaceToggle = requireLayoutElement(
            documentContext,
            "#toggle-tools-workspace"
        );
        this.openToolsWorkspaceButton = requireLayoutElement(
            documentContext,
            "#open-tools-workspace"
        );
        this.catalogWorkspaceIsExpanded =
            this.catalogWorkspaceToggle.getAttribute("aria-expanded") !==
            "false";
        this.toolsWorkspaceIsExpanded =
            this.toolsWorkspaceToggle.getAttribute("aria-expanded") !==
            "false";
        this.activeWorkspace = this.appElement.classList.contains(
            "is-active-tools-workspace"
        ) ? "tools" : "catalog";
        this.controlPanelIsCollapsed =
            this.controlPanelElement.classList.contains("is-collapsed");
        this.workspaceDisclosures = WORKSPACE_DISCLOSURES.map(
            (configuration) => this.#createWorkspaceDisclosure(configuration)
        );
        this.boundToggleCatalogWorkspace =
            this.#handleToggleCatalogWorkspace.bind(this);
        this.boundOpenCatalogWorkspace =
            this.#handleOpenCatalogWorkspace.bind(this);
        this.boundToggleToolsWorkspace =
            this.#handleToggleToolsWorkspace.bind(this);
        this.boundOpenToolsWorkspace =
            this.#handleOpenToolsWorkspace.bind(this);
        this.boundDocumentKeydown = this.#handleDocumentKeydown.bind(this);
        this.boundCollapsePanel = this.#handleCollapsePanel.bind(this);
        this.boundOpenPanel = this.#handleOpenPanel.bind(this);
        this.catalogWorkspaceToggle.addEventListener(
            "click",
            this.boundToggleCatalogWorkspace
        );
        this.openCatalogWorkspaceButton.addEventListener(
            "click",
            this.boundOpenCatalogWorkspace
        );
        this.toolsWorkspaceToggle.addEventListener(
            "click",
            this.boundToggleToolsWorkspace
        );
        this.openToolsWorkspaceButton.addEventListener(
            "click",
            this.boundOpenToolsWorkspace
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
        this.toolTabs = TOOL_TABS.map((configuration, index) =>
            this.#createToolTab(configuration, index)
        );
        const selectedToolIndex = this.toolTabs.findIndex(
            ({ tab }) => tab.getAttribute("aria-selected") === "true"
        );
        this.selectedToolIndex = selectedToolIndex < 0 ? 0 : selectedToolIndex;
        this.#synchronizeCatalogWorkspacePresentation();
        this.#synchronizeToolsWorkspacePresentation();
        this.#synchronizeActiveWorkspacePresentation();
        this.#synchronizeControlPanelPresentation();
    }

    /**
     * Set whether the Catalog rail is available beside or over the map.
     *
     * A changed state updates the layout class, disclosure text and ARIA state,
     * region visibility, then schedules one post-transition map resize.
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
     * Individual rail state is preserved so reopening restores the workspace
     * the user intentionally left available. Exactly one map invalidation is
     * scheduled for a state-changing panel action.
     *
     * @param {boolean} isCollapsed Whether the panel should be collapsed.
     * @return {void}
     */
    setControlPanelCollapsed(isCollapsed) {
        if (isCollapsed === this.controlPanelIsCollapsed) {
            return;
        }
        this.controlPanelIsCollapsed = isCollapsed;
        this.#synchronizeControlPanelPresentation();
        this.#scheduleMapInvalidation();
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
        this.openCatalogWorkspaceButton.removeEventListener(
            "click",
            this.boundOpenCatalogWorkspace
        );
        this.toolsWorkspaceToggle.removeEventListener(
            "click",
            this.boundToggleToolsWorkspace
        );
        this.openToolsWorkspaceButton.removeEventListener(
            "click",
            this.boundOpenToolsWorkspace
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
        for (const toolTab of this.toolTabs) {
            toolTab.tab.removeEventListener("click", toolTab.handleClick);
            toolTab.tab.removeEventListener("keydown", toolTab.handleKeydown);
        }
    }

    /**
     * Resolve and bind one tab in the layout-owned map-tools workbench.
     *
     * @param {ToolTabConfiguration} configuration Static tab/panel contract.
     * @param {number} index Zero-based tab position used by keyboard navigation.
     * @return {ToolTabState} Bound tab and semantic panel state.
     * @throws {Error} If either required element is absent.
     */
    #createToolTab(configuration, index) {
        const tab = requireLayoutElement(
            this.documentContext,
            configuration.tabSelector
        );
        const panel = requireLayoutElement(
            this.documentContext,
            configuration.panelSelector
        );
        const toolTab = {
            tab,
            panel,
            handleClick: () => {
                this.#setActiveWorkspace("tools");
                this.#selectToolTab(index, false);
            },
            handleKeydown: (event) => this.#handleToolTabKeydown(event, index),
        };
        tab.addEventListener("click", toolTab.handleClick);
        tab.addEventListener("keydown", toolTab.handleKeydown);
        return toolTab;
    }

    /**
     * Select one map-tools panel without changing any feature-owned state.
     *
     * @param {number} index Zero-based tab position.
     * @param {boolean} moveFocus Whether the selected tab receives focus.
     * @return {void}
     * @throws {RangeError} If the tab position is outside the static contract.
     */
    #selectToolTab(index, moveFocus) {
        if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= this.toolTabs.length
        ) {
            throw new RangeError(
                "Map-tools tab index is outside the layout contract"
            );
        }
        this.selectedToolIndex = index;
        this.#synchronizeToolsWorkspacePresentation();
        if (moveFocus) {
            this.toolTabs[index].tab.focus();
        }
    }

    /**
     * Support the standard horizontal tab-list arrow, Home, and End keys.
     *
     * @param {KeyboardEvent} event Tab keyboard event.
     * @param {number} currentIndex Zero-based position of the focused tab.
     * @return {void}
     */
    #handleToolTabKeydown(event, currentIndex) {
        const finalIndex = this.toolTabs.length - 1;
        const destinations = {
            ArrowLeft: (currentIndex + finalIndex) % this.toolTabs.length,
            ArrowRight: (currentIndex + 1) % this.toolTabs.length,
            Home: 0,
            End: finalIndex,
        };
        if (!(event.key in destinations)) {
            return;
        }
        event.preventDefault();
        this.#setActiveWorkspace("tools");
        this.#selectToolTab(destinations[event.key], true);
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
                ? "Hide catalog"
                : "Show catalog";
        this.catalogWorkspaceToggle.setAttribute(
            "aria-label",
            this.catalogWorkspaceIsExpanded
                ? "Hide Catalog workspace"
                : "Show Catalog workspace"
        );
        this.catalogRegion.hidden = !this.catalogWorkspaceIsExpanded;
        this.catalogRegion.setAttribute(
            "aria-hidden",
            String(!this.catalogWorkspaceIsExpanded)
        );
        this.openCatalogWorkspaceButton.setAttribute(
            "aria-expanded",
            String(this.catalogWorkspaceIsExpanded)
        );
    }

    /** Synchronize the right workbench, its tabs, and owned panels. @return {void} */
    #synchronizeToolsWorkspacePresentation() {
        this.appElement.classList.toggle(
            "is-tools-workspace",
            this.toolsWorkspaceIsExpanded
        );
        this.toolsNavigation.hidden = !this.toolsWorkspaceIsExpanded;
        this.toolsNavigation.setAttribute(
            "aria-hidden",
            String(!this.toolsWorkspaceIsExpanded)
        );
        this.toolsWorkspaceToggle.setAttribute(
            "aria-expanded",
            String(this.toolsWorkspaceIsExpanded)
        );
        this.toolsWorkspaceToggle.setAttribute(
            "aria-label",
            this.toolsWorkspaceIsExpanded ? "Hide map tools" : "Show map tools"
        );
        this.openToolsWorkspaceButton.setAttribute(
            "aria-expanded",
            String(this.toolsWorkspaceIsExpanded)
        );
        for (const [index, toolTab] of this.toolTabs.entries()) {
            const isSelected = index === this.selectedToolIndex;
            toolTab.tab.setAttribute("aria-selected", String(isSelected));
            toolTab.tab.setAttribute("tabindex", isSelected ? "0" : "-1");
            toolTab.panel.hidden =
                !this.toolsWorkspaceIsExpanded || !isSelected;
            toolTab.panel.setAttribute(
                "aria-hidden",
                String(!this.toolsWorkspaceIsExpanded || !isSelected)
            );
        }
    }

    /** Synchronize the narrow-layout foreground workspace class. @return {void} */
    #synchronizeActiveWorkspacePresentation() {
        this.appElement.classList.toggle(
            "is-active-catalog-workspace",
            this.activeWorkspace === "catalog"
        );
        this.appElement.classList.toggle(
            "is-active-tools-workspace",
            this.activeWorkspace === "tools"
        );
    }

    /**
     * Select which expanded rail is foregrounded by narrow-layout CSS.
     *
     * @param {"catalog"|"tools"} workspace Layout workspace name.
     * @return {void}
     * @throws {RangeError} If the workspace is outside the static layout contract.
     */
    #setActiveWorkspace(workspace) {
        if (workspace !== "catalog" && workspace !== "tools") {
            throw new RangeError("Active workspace must be Catalog or map tools");
        }
        this.activeWorkspace = workspace;
        this.#synchronizeActiveWorkspacePresentation();
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
        if (!this.catalogWorkspaceIsExpanded) {
            this.openCatalogWorkspaceButton.focus();
        }
    }

    /** Open and foreground the Catalog rail. @return {void} */
    #handleOpenCatalogWorkspace() {
        this.#setActiveWorkspace("catalog");
        this.setCatalogWorkspaceExpanded(true);
    }

    /**
     * Toggle the map-tools rail and return focus to its persistent opener.
     *
     * @return {void}
     */
    #handleToggleToolsWorkspace() {
        this.toolsWorkspaceIsExpanded = !this.toolsWorkspaceIsExpanded;
        this.#synchronizeToolsWorkspacePresentation();
        this.#scheduleMapInvalidation();
        if (!this.toolsWorkspaceIsExpanded) {
            this.openToolsWorkspaceButton.focus();
        }
    }

    /** Open and foreground the map-tools rail. @return {void} */
    #handleOpenToolsWorkspace() {
        this.#setActiveWorkspace("tools");
        if (!this.toolsWorkspaceIsExpanded) {
            this.toolsWorkspaceIsExpanded = true;
            this.#synchronizeToolsWorkspacePresentation();
            this.#scheduleMapInvalidation();
        }
    }

    /**
     * Collapse the focused workspace disclosure when Escape is pressed.
     *
     * Native form controls keep Escape. Operational details collapse
     * independently. Focus within the Catalog or map-tools rail closes only
     * that rail and returns focus to its persistent opener.
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
            this.catalogWorkspaceIsExpanded &&
            focusedElement !== null &&
            focusedElement !== undefined &&
            (focusedElement === this.catalogWorkspaceToggle ||
                this.catalogRegion.contains(focusedElement))
        ) {
            keyboardEvent.preventDefault();
            this.setCatalogWorkspaceExpanded(false);
            this.openCatalogWorkspaceButton.focus();
            return;
        }
        if (
            this.toolsWorkspaceIsExpanded &&
            focusedElement !== null &&
            focusedElement !== undefined &&
            (this.toolsNavigation.contains(focusedElement) ||
                this.toolTabs.some(({ panel }) => panel.contains(focusedElement)))
        ) {
            keyboardEvent.preventDefault();
            this.toolsWorkspaceIsExpanded = false;
            this.#synchronizeToolsWorkspacePresentation();
            this.#scheduleMapInvalidation();
            this.openToolsWorkspaceButton.focus();
        }
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
