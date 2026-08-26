/**
 * EOMap workspace-sidebar presentation controller.
 *
 * This component owns only the selected workspace tab, the operational-status
 * disclosure, whole-sidebar visibility, accessible focus behavior, layout
 * classes, and delayed map-size invalidation. It has no knowledge of Catalog
 * Items, map layers, rasters, rendering, APIs, or source data.
 */

/** Delay matching the workspace-sidebar transition. */
export const CONTROL_PANEL_TRANSITION_MILLISECONDS = 240;

/**
 * @typedef {Object} WorkspaceTabConfiguration
 * @property {string} name Stable layout-only workspace name.
 * @property {string} tabSelector Selector for the workspace tab.
 * @property {string} panelSelector Selector for the tab's semantic panel.
 */

/**
 * @typedef {Object} WorkspaceTabState
 * @property {WorkspaceTabConfiguration} configuration Static tab contract.
 * @property {Element} tab Workspace tab element.
 * @property {Element} panel Semantic panel selected by the tab.
 * @property {() => void} handleClick Bound selection listener.
 * @property {(event: KeyboardEvent) => void} handleKeydown Bound keyboard
 * listener.
 */

/** @type {WorkspaceTabConfiguration[]} */
const WORKSPACE_TABS = [
    {
        name: "catalog",
        tabSelector: "#toggle-catalog-workspace",
        panelSelector: "#eomap-catalog-region",
    },
    {
        name: "rendering",
        tabSelector: "#toggle-map-layers",
        panelSelector: "#eomap-map-layers-region",
    },
    {
        name: "raster-analysis",
        tabSelector: "#toggle-raster-interpretation",
        panelSelector: "#eomap-raster-interpretation-region",
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

/** Own the EOMap workspace-sidebar disclosure and tab presentation. */
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
        this.operationalRegion = requireLayoutElement(
            documentContext,
            "#eomap-operational-status-region"
        );
        this.operationalToggle = requireLayoutElement(
            documentContext,
            "#toggle-operational-status"
        );
        this.operationalBody = requireLayoutElement(
            documentContext,
            "#eomap-operational-status-body"
        );
        this.analysisAoiDisclosure = requireLayoutElement(
            documentContext,
            "#analysis-aoi-disclosure"
        );
        this.analysisAoiToggle = requireLayoutElement(
            documentContext,
            "#toggle-analysis-aoi"
        );
        this.operationalStatusIsExpanded =
            this.operationalToggle.getAttribute("aria-expanded") !== "false";
        this.controlPanelIsCollapsed =
            this.controlPanelElement.classList.contains("is-collapsed");

        this.boundOperationalToggle =
            this.#handleOperationalToggle.bind(this);
        this.boundDocumentKeydown = this.#handleDocumentKeydown.bind(this);
        this.boundCollapsePanel = this.#handleCollapsePanel.bind(this);
        this.boundOpenPanel = this.#handleOpenPanel.bind(this);
        this.boundAnalysisAoiToggle =
            this.#handleAnalysisAoiToggle.bind(this);
        this.boundAnalysisAoiKeydown =
            this.#handleAnalysisAoiKeydown.bind(this);
        this.operationalToggle.addEventListener(
            "click",
            this.boundOperationalToggle
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
        this.analysisAoiDisclosure.addEventListener(
            "toggle",
            this.boundAnalysisAoiToggle
        );
        this.analysisAoiDisclosure.addEventListener(
            "keydown",
            this.boundAnalysisAoiKeydown
        );

        this.workspaceTabs = WORKSPACE_TABS.map((configuration, index) =>
            this.#createWorkspaceTab(configuration, index)
        );
        const selectedWorkspaceIndex = this.workspaceTabs.findIndex(
            ({ tab }) => tab.getAttribute("aria-selected") === "true"
        );
        this.selectedWorkspaceIndex = selectedWorkspaceIndex < 0
            ? 0
            : selectedWorkspaceIndex;
        this.#synchronizeOperationalStatusPresentation();
        this.#synchronizeAnalysisAoiPresentation();
        this.#synchronizeWorkspacePresentation();
        this.#synchronizeControlPanelPresentation();
    }

    /**
     * Set whether the complete workspace sidebar is visually collapsed.
     *
     * The selected workspace and operational disclosure state are retained so
     * reopening restores the user's context. A changed state schedules one
     * map invalidation after the layout transition and moves focus to the
     * corresponding persistent disclosure control.
     *
     * @param {boolean} isCollapsed Whether the sidebar should be collapsed.
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
     * Reveal one semantic workspace by its layout-only name.
     *
     * This method lets the browser composition root respond to an explicit
     * feature presentation request without giving this controller feature
     * state or sibling implementation knowledge.
     *
     * @param {"catalog"|"rendering"|"raster-analysis"} name Workspace name.
     * @param {boolean} [moveFocus=false] Whether its tab receives focus.
     * @return {void}
     * @throws {RangeError} If the name is outside the static layout contract.
     */
    showWorkspace(name, moveFocus = false) {
        const index = this.workspaceTabs.findIndex(
            ({ configuration }) => configuration.name === name
        );
        if (index < 0) {
            throw new RangeError(`Unknown EOMap workspace: ${name}`);
        }
        if (this.controlPanelIsCollapsed) {
            this.controlPanelIsCollapsed = false;
            this.#synchronizeControlPanelPresentation();
            this.#scheduleMapInvalidation();
        }
        this.#selectWorkspace(index, moveFocus);
    }

    /**
     * Notify the map after a feature-neutral layout allocation changes.
     *
     * The browser composition root uses this boundary for CSS-driven changes,
     * such as the progressive Catalog inspector, without exposing feature
     * identity or state to the layout controller.
     *
     * @return {void}
     */
    notifyLayoutChange() {
        this.#scheduleMapInvalidation();
    }

    /**
     * Detach every DOM listener installed during construction.
     *
     * Already scheduled invalidations still complete, matching browser timer
     * behavior; subsequent layout-control events no longer change state.
     *
     * @return {void}
     */
    destroy() {
        this.operationalToggle.removeEventListener(
            "click",
            this.boundOperationalToggle
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
        this.analysisAoiDisclosure.removeEventListener(
            "toggle",
            this.boundAnalysisAoiToggle
        );
        this.analysisAoiDisclosure.removeEventListener(
            "keydown",
            this.boundAnalysisAoiKeydown
        );
        for (const workspaceTab of this.workspaceTabs) {
            workspaceTab.tab.removeEventListener(
                "click",
                workspaceTab.handleClick
            );
            workspaceTab.tab.removeEventListener(
                "keydown",
                workspaceTab.handleKeydown
            );
        }
    }

    /**
     * Resolve and bind one tab in the layout-owned workspace navigation.
     *
     * @param {WorkspaceTabConfiguration} configuration Static tab/panel
     * contract.
     * @param {number} index Zero-based tab position used by keyboard navigation.
     * @return {WorkspaceTabState} Bound tab and semantic panel state.
     * @throws {Error} If either required element is absent.
     */
    #createWorkspaceTab(configuration, index) {
        const tab = requireLayoutElement(
            this.documentContext,
            configuration.tabSelector
        );
        const panel = requireLayoutElement(
            this.documentContext,
            configuration.panelSelector
        );
        const workspaceTab = {
            configuration,
            tab,
            panel,
            handleClick: () => this.#selectWorkspace(index, false),
            handleKeydown: (event) =>
                this.#handleWorkspaceTabKeydown(event, index),
        };
        tab.addEventListener("click", workspaceTab.handleClick);
        tab.addEventListener("keydown", workspaceTab.handleKeydown);
        return workspaceTab;
    }

    /**
     * Select one semantic workspace and preserve every feature-owned state.
     *
     * A changed selection schedules map remeasurement because the Catalog's
     * progressive inspector can give that tab a different wide-screen width.
     *
     * @param {number} index Zero-based workspace-tab position.
     * @param {boolean} moveFocus Whether the selected tab receives focus.
     * @return {void}
     * @throws {RangeError} If the position is outside the static contract.
     */
    #selectWorkspace(index, moveFocus) {
        if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= this.workspaceTabs.length
        ) {
            throw new RangeError(
                "Workspace tab index is outside the layout contract"
            );
        }
        const selectionChanged = index !== this.selectedWorkspaceIndex;
        this.selectedWorkspaceIndex = index;
        this.#synchronizeWorkspacePresentation();
        if (selectionChanged) {
            this.#scheduleMapInvalidation();
        }
        if (moveFocus) {
            this.workspaceTabs[index].tab.focus();
        }
    }

    /**
     * Support the standard horizontal tab-list arrow, Home, and End keys.
     *
     * @param {KeyboardEvent} event Tab keyboard event.
     * @param {number} currentIndex Zero-based position of the focused tab.
     * @return {void}
     */
    #handleWorkspaceTabKeydown(event, currentIndex) {
        const finalIndex = this.workspaceTabs.length - 1;
        const destinations = {
            ArrowLeft:
                (currentIndex + finalIndex) % this.workspaceTabs.length,
            ArrowRight: (currentIndex + 1) % this.workspaceTabs.length,
            Home: 0,
            End: finalIndex,
        };
        if (!(event.key in destinations)) {
            return;
        }
        event.preventDefault();
        this.#selectWorkspace(destinations[event.key], true);
    }

    /**
     * Synchronize the selected tab, its panel, and active-layout class.
     *
     * @return {void}
     */
    #synchronizeWorkspacePresentation() {
        for (const [index, workspaceTab] of this.workspaceTabs.entries()) {
            const isSelected = index === this.selectedWorkspaceIndex;
            workspaceTab.tab.setAttribute("aria-selected", String(isSelected));
            workspaceTab.tab.setAttribute("tabindex", isSelected ? "0" : "-1");
            workspaceTab.panel.hidden = !isSelected;
            workspaceTab.panel.setAttribute(
                "aria-hidden",
                String(!isSelected)
            );
            this.appElement.classList.toggle(
                `is-active-${workspaceTab.configuration.name}-workspace`,
                isSelected
            );
        }
    }

    /**
     * Apply the expanded/collapsed operational-status presentation.
     *
     * @return {void}
     */
    #synchronizeOperationalStatusPresentation() {
        this.operationalRegion.classList.toggle(
            "is-collapsed",
            !this.operationalStatusIsExpanded
        );
        this.operationalToggle.setAttribute(
            "aria-expanded",
            String(this.operationalStatusIsExpanded)
        );
        this.operationalToggle.textContent = this.operationalStatusIsExpanded
            ? "Hide status details"
            : "Show status details";
        this.operationalBody.hidden = !this.operationalStatusIsExpanded;
        this.operationalBody.setAttribute(
            "aria-hidden",
            String(!this.operationalStatusIsExpanded)
        );
    }

    /** Synchronize the native AOI disclosure's explicit ARIA state. @return {void} */
    #synchronizeAnalysisAoiPresentation() {
        this.analysisAoiToggle.setAttribute(
            "aria-expanded",
            String(Boolean(this.analysisAoiDisclosure.open))
        );
    }

    /** Synchronize AOI disclosure state after a native toggle. @return {void} */
    #handleAnalysisAoiToggle() {
        this.#synchronizeAnalysisAoiPresentation();
    }

    /**
     * Close the nearest open AOI disclosure before Escape reaches the sidebar.
     *
     * @param {KeyboardEvent} event Keyboard event originating in the details.
     * @return {void}
     */
    #handleAnalysisAoiKeydown(event) {
        const focusedElement = this.documentContext.activeElement;
        if (
            event.key !== "Escape" ||
            !this.analysisAoiDisclosure.open ||
            focusedElement === null ||
            focusedElement === undefined ||
            !this.analysisAoiDisclosure.contains(focusedElement) ||
            this.#focusOwnsEscape(focusedElement)
        ) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.analysisAoiDisclosure.open = false;
        this.#synchronizeAnalysisAoiPresentation();
        this.analysisAoiToggle.focus();
    }

    /** Synchronize the whole sidebar's accessible presentation. @return {void} */
    #synchronizeControlPanelPresentation() {
        this.controlPanelElement.classList.toggle(
            "is-collapsed",
            this.controlPanelIsCollapsed
        );
        this.appElement.classList.toggle(
            "is-control-panel-collapsed",
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

    /** Schedule one map resize after the visual transition. @return {void} */
    #scheduleMapInvalidation() {
        this.schedule(
            this.invalidateMapSize,
            CONTROL_PANEL_TRANSITION_MILLISECONDS
        );
    }

    /** Toggle compact operational-status details. @return {void} */
    #handleOperationalToggle() {
        this.operationalStatusIsExpanded =
            !this.operationalStatusIsExpanded;
        this.#synchronizeOperationalStatusPresentation();
        this.#scheduleMapInvalidation();
    }

    /**
     * Collapse the closest active layout disclosure when Escape is pressed.
     *
     * Native form controls retain Escape. Expanded operational details close
     * before the complete sidebar. Nested presentation controls can stop the
     * event before it reaches this document-level handler.
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
        if (
            this.operationalStatusIsExpanded &&
            focusedElement !== null &&
            focusedElement !== undefined &&
            this.operationalRegion.contains(focusedElement)
        ) {
            keyboardEvent.preventDefault();
            this.operationalStatusIsExpanded = false;
            this.#synchronizeOperationalStatusPresentation();
            this.#scheduleMapInvalidation();
            this.operationalToggle.focus();
            return;
        }
        if (
            !this.controlPanelIsCollapsed &&
            focusedElement !== null &&
            focusedElement !== undefined &&
            this.controlPanelElement.contains(focusedElement)
        ) {
            keyboardEvent.preventDefault();
            this.setControlPanelCollapsed(true);
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

    /** Collapse the complete workspace sidebar. @return {void} */
    #handleCollapsePanel() {
        this.setControlPanelCollapsed(true);
    }

    /** Reopen the complete workspace sidebar. @return {void} */
    #handleOpenPanel() {
        this.setControlPanelCollapsed(false);
    }
}
