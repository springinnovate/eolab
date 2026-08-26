/**
 * EOMap workspace-sidebar presentation controller.
 *
 * This component owns only independent workspace disclosures, the
 * operational-status disclosure, whole-sidebar visibility, accessible focus
 * behavior, layout classes, and delayed map-size invalidation. It has no
 * knowledge of Catalog Items, map layers, rasters, rendering, APIs, or source
 * data.
 */

/** Delay matching the workspace-sidebar transition. */
export const CONTROL_PANEL_TRANSITION_MILLISECONDS = 240;

/**
 * @typedef {Object} WorkspaceDisclosureConfiguration
 * @property {string} name Stable layout-only workspace name.
 * @property {string} toggleSelector Selector for the disclosure button.
 * @property {string} panelSelector Selector for the semantic panel.
 * @property {string} scrollSelector Selector for the workspace scroll owner.
 */

/**
 * @typedef {Object} WorkspaceDisclosureState
 * @property {WorkspaceDisclosureConfiguration} configuration Static
 * disclosure contract.
 * @property {Element} toggle Workspace disclosure button.
 * @property {Element} panel Semantic panel controlled by the button.
 * @property {Element} scrollElement Workspace's layout-owned scroll element.
 * @property {boolean} isExpanded Whether the panel is currently expanded.
 * @property {() => void} handleClick Bound disclosure listener.
 */

/** @type {WorkspaceDisclosureConfiguration[]} */
const WORKSPACE_DISCLOSURES = [
    {
        name: "catalog",
        toggleSelector: "#toggle-catalog-workspace",
        panelSelector: "#eomap-catalog-region",
        scrollSelector: "#eomap-catalog-region",
    },
    {
        name: "map-layers",
        toggleSelector: "#toggle-map-layers",
        panelSelector: "#eomap-map-layers-region",
        scrollSelector: "#eomap-map-layers-body",
    },
    {
        name: "histogram",
        toggleSelector: "#toggle-raster-interpretation",
        panelSelector: "#eomap-raster-interpretation-region",
        scrollSelector: "#eomap-raster-interpretation-body",
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

/** Own the EOMap workspace-sidebar disclosure presentation. */
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
        this.openMapLayerHistograms = requireLayoutElement(
            documentContext,
            "#open-map-layer-histograms"
        );
        this.openHistogramMapLayers = requireLayoutElement(
            documentContext,
            "#open-histogram-map-layers"
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
        this.boundOpenMapLayerHistograms = () =>
            this.showWorkspace("histogram", true);
        this.boundOpenHistogramMapLayers = () =>
            this.showWorkspace("map-layers", true);
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
        this.openMapLayerHistograms.addEventListener(
            "click",
            this.boundOpenMapLayerHistograms
        );
        this.openHistogramMapLayers.addEventListener(
            "click",
            this.boundOpenHistogramMapLayers
        );

        this.workspaceDisclosures = WORKSPACE_DISCLOSURES.map(
            (configuration, index) =>
                this.#createWorkspaceDisclosure(configuration, index)
        );
        this.#synchronizeOperationalStatusPresentation();
        this.#synchronizeAnalysisAoiPresentation();
        this.#synchronizeWorkspacePresentation();
        this.#synchronizeControlPanelPresentation();
    }

    /**
     * Set whether the complete workspace sidebar is visually collapsed.
     *
     * Workspace and operational disclosure states are retained so reopening
     * restores the user's context. A changed state schedules one map
     * invalidation after the layout transition and moves focus to the
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
     * Ensure one semantic workspace is expanded by its layout-only name.
     *
     * This method lets the browser composition root respond to an explicit
     * feature presentation request without giving this controller feature
     * state or sibling implementation knowledge.
     *
     * @param {"catalog"|"map-layers"|"histogram"} name Workspace name.
     * @param {boolean} [moveFocus=false] Whether its disclosure receives focus.
     * @return {void}
     * @throws {RangeError} If the name is outside the static layout contract.
     */
    showWorkspace(name, moveFocus = false) {
        const index = this.workspaceDisclosures.findIndex(
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
        const wasExpanded = this.workspaceDisclosures[index].isExpanded;
        this.#setWorkspaceExpanded(index, true, moveFocus);
        if (!wasExpanded) {
            this.workspaceDisclosures[index].scrollElement.scrollTop = 0;
        }
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
        this.openMapLayerHistograms.removeEventListener(
            "click",
            this.boundOpenMapLayerHistograms
        );
        this.openHistogramMapLayers.removeEventListener(
            "click",
            this.boundOpenHistogramMapLayers
        );
        for (const workspaceDisclosure of this.workspaceDisclosures) {
            workspaceDisclosure.toggle.removeEventListener(
                "click",
                workspaceDisclosure.handleClick
            );
        }
    }

    /**
     * Resolve and bind one layout-owned workspace disclosure.
     *
     * @param {WorkspaceDisclosureConfiguration} configuration Static
     * disclosure/panel contract.
     * @param {number} index Zero-based disclosure position.
     * @return {WorkspaceDisclosureState} Bound disclosure and panel state.
     * @throws {Error} If a required element is absent.
     */
    #createWorkspaceDisclosure(configuration, index) {
        const toggle = requireLayoutElement(
            this.documentContext,
            configuration.toggleSelector
        );
        const panel = requireLayoutElement(
            this.documentContext,
            configuration.panelSelector
        );
        const scrollElement = requireLayoutElement(
            this.documentContext,
            configuration.scrollSelector
        );
        const workspaceDisclosure = {
            configuration,
            toggle,
            panel,
            scrollElement,
            isExpanded: toggle.getAttribute("aria-expanded") !== "false",
            handleClick: () => this.#setWorkspaceExpanded(
                index,
                !this.workspaceDisclosures[index].isExpanded,
                false
            ),
        };
        toggle.addEventListener("click", workspaceDisclosure.handleClick);
        return workspaceDisclosure;
    }

    /**
     * Set one workspace's independent disclosure state.
     *
     * Other workspaces retain their current state. A changed disclosure
     * schedules map remeasurement because available sidebar allocation changed.
     *
     * @param {number} index Zero-based workspace-disclosure position.
     * @param {boolean} isExpanded Whether its semantic panel is visible.
     * @param {boolean} moveFocus Whether its disclosure receives focus.
     * @return {void}
     * @throws {RangeError} If the position is outside the static contract.
     */
    #setWorkspaceExpanded(index, isExpanded, moveFocus) {
        if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= this.workspaceDisclosures.length
        ) {
            throw new RangeError(
                "Workspace disclosure index is outside the layout contract"
            );
        }
        const workspaceDisclosure = this.workspaceDisclosures[index];
        const stateChanged = workspaceDisclosure.isExpanded !== isExpanded;
        workspaceDisclosure.isExpanded = isExpanded;
        this.#synchronizeWorkspacePresentation();
        if (stateChanged) {
            this.#scheduleMapInvalidation();
        }
        if (moveFocus) {
            workspaceDisclosure.toggle.focus();
        }
    }

    /**
     * Synchronize every independent disclosure and expanded-layout class.
     *
     * @return {void}
     */
    #synchronizeWorkspacePresentation() {
        for (const workspaceDisclosure of this.workspaceDisclosures) {
            const { isExpanded } = workspaceDisclosure;
            workspaceDisclosure.toggle.setAttribute(
                "aria-expanded",
                String(isExpanded)
            );
            workspaceDisclosure.panel.hidden = !isExpanded;
            workspaceDisclosure.panel.setAttribute(
                "aria-hidden",
                String(!isExpanded)
            );
            this.appElement.classList.toggle(
                `is-expanded-${workspaceDisclosure.configuration.name}-workspace`,
                isExpanded
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
     * Native form controls retain Escape. The focused expanded disclosure
     * closes before the complete sidebar. Nested presentation controls can
     * stop the event before it reaches this document-level handler.
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
        const focusedWorkspaceIndex = this.workspaceDisclosures.findIndex(
            ({ isExpanded, panel, toggle }) =>
                isExpanded &&
                (toggle === focusedElement || panel.contains(focusedElement))
        );
        if (focusedWorkspaceIndex >= 0) {
            keyboardEvent.preventDefault();
            this.#setWorkspaceExpanded(
                focusedWorkspaceIndex,
                false,
                true
            );
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
