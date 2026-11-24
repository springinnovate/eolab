/**
 * EOMap workspace-sidebar presentation controller.
 *
 * This component owns only workspace availability, independent disclosures, the
 * operational-status disclosure, whole-sidebar visibility, shared panel opacity, accessible focus
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
 * @property {boolean} openWhenAvailable Stored disclosure choice, retained while unavailable.
 * @property {boolean} isAvailable Whether the visitor may open the panel.
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
 * Keep the workspace panels readable while any panel has hover, keyboard input or a drag.
 * The stylesheet applies the entrance and exit delays to a single shared activity state.
 * @param {Document} doc Map viewer document, including native menus and modal editors.
 * @param {Element} app Workspace root whose data-panels-active attribute drives the fade.
 * @return {() => void} Detach all input listeners and restore the default panel presentation.
 */
function bindPanelActivity(doc, app) {
    const listeners = new AbortController();
    const options = {capture: true, signal: listeners.signal};
    /** @type {Set<number>} Hover-capable pointers currently over a panel. */
    const hovered = new Set();
    /** @type {Map<number, boolean>} Whether each held pointer started on a panel. */
    const pressed = new Map();
    let keyboard = true;
    let focused = false;
    let draggingPanel = false;

    /** @param {EventTarget|null} target Input target. @return {boolean} Whether it belongs to panel UI. */
    function inPanel(target) {
        return Boolean(target?.closest?.("[data-map-panel], [popover], .leaflet-control:not(.leaflet-control-attribution), dialog[open]"));
    }
    /** Apply the combined activity, keeping each held pointer with the surface where it started. @return {void} */
    function update() {
        const active = focused || draggingPanel || [...pressed.values()].includes(true) ||
            [...hovered].some(id => !pressed.has(id));
        if (app.getAttribute("data-panels-active") !== String(active)) {
            app.setAttribute("data-panels-active", String(active));
        }
    }
    /** @param {PointerEvent} event Pointer crossing, pressing or releasing a surface. @return {void} */
    function trackPointer(event) {
        const {type, pointerId} = event;
        if (type === "pointermove" && !keyboard && (!pressed.has(pointerId) || event.buttons)) return;
        let target = event.target;
        if (type === "pointerdown" || type === "pointermove") {
            keyboard = false;
            focused = false;
        }
        if (type === "pointerdown") pressed.set(pointerId, inPanel(target));
        if (type === "pointerout") target = event.relatedTarget;
        if (type === "pointerup" || type === "pointercancel") {
            pressed.delete(pointerId);
            target = type === "pointerup" ? doc.elementFromPoint(event.clientX, event.clientY) : null;
        } else if (type === "pointermove" && !event.buttons) {
            pressed.delete(pointerId);
        }
        if (event.pointerType !== "touch" && inPanel(target)) hovered.add(pointerId);
        else hovered.delete(pointerId);
        update();
    }
    for (const type of ["pointerover", "pointerout", "pointerdown", "pointerup", "pointercancel", "pointermove"]) {
        doc.addEventListener(type, trackPointer, options);
    }
    doc.addEventListener("keydown", event => {
        keyboard = true;
        focused = inPanel(event.target);
        update();
    }, options);
    for (const type of ["focusin", "focusout"]) {
        doc.addEventListener(type, event => {
            focused = keyboard && inPanel(type === "focusin" ? event.target : event.relatedTarget);
            update();
        }, options);
    }
    for (const type of ["dragstart", "dragend"]) {
        doc.addEventListener(type, event => {
            draggingPanel = type === "dragstart" && inPanel(event.target);
            update();
        }, options);
    }
    doc.defaultView.addEventListener("blur", () => {
        hovered.clear();
        pressed.clear();
        focused = false;
        draggingPanel = false;
        update();
    }, {signal: listeners.signal});
    update();
    return () => {
        listeners.abort();
        app.removeAttribute("data-panels-active");
    };
}

/**
 * @typedef {Object} WorkspacePanelOptions
 * @property {boolean} allowCatalog Expose the Catalog workspace.
 * @property {boolean} allowMapContents Expose the Map contents workspace.
 * @property {{catalog:boolean,mapContents:boolean}} [initialState] Initial disclosure
 * choices, independent of availability. Omission retains the current disclosures.
 */

/**
 * @typedef {Object} EomapLayoutDependencies
 * @property {() => void} invalidateMapSize Notifies the map after transitions.
 * @property {Document} [documentContext=globalThis.document] Layout document.
 * @property {(callback: () => void, delay: number) => *} [schedule]
 * Transition scheduler; defaults to the browser timer.
 * @property {boolean} [allowCatalog=true] Expose the catalog workspace.
 * @property {boolean} [allowMapContents=true] Expose the Map contents workspace.
 * @property {{catalog:boolean,mapContents:boolean}} [initialState] Published initial
 * disclosures. When supplied, these take precedence over remembered layout.
 * @property {boolean} [allowOperationalStatus=true] Expose operational diagnostics.
 * @property {{read: () => string|null, write: (value: string) => boolean}|null}
 * [workspaceStorage=null] Optional failure-tolerant storage for panel states.
 */

/** Own the EOMap workspace-sidebar disclosure presentation. */
export class EomapLayoutController {
    /** @type {Map<() => void, Element|null>} Each subscription holds its panel while active. */
    #panelActivitySources = new Map();

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
        allowCatalog = true,
        allowMapContents = true,
        initialState,
        allowOperationalStatus = true,
        workspaceStorage = null,
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
        this.allowCatalog = allowCatalog;
        this.allowMapContents = allowMapContents;
        this.allowOperationalStatus = allowOperationalStatus;
        this.workspaceStorage = workspaceStorage;
        this.appElement = requireLayoutElement(documentContext, "#app");
        this.mapElement = requireLayoutElement(documentContext, "#map");
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
        this.operationalStatusIsExpanded =
            this.operationalToggle.getAttribute("aria-expanded") !== "false";
        this.controlPanelIsCollapsed =
            this.controlPanelElement.classList.contains("is-collapsed");

        this.boundOperationalToggle =
            this.#handleOperationalToggle.bind(this);
        this.boundDocumentKeydown = this.#handleDocumentKeydown.bind(this);
        this.boundCollapsePanel = this.#handleCollapsePanel.bind(this);
        this.boundOpenPanel = this.#handleOpenPanel.bind(this);
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

        this.workspaceDisclosures = WORKSPACE_DISCLOSURES.map(
            (configuration, index) =>
                this.#createWorkspaceDisclosure(configuration, index)
        );
        if (initialState) {
            this.workspaceDisclosures[0].openWhenAvailable = initialState.catalog;
            this.workspaceDisclosures[1].openWhenAvailable = initialState.mapContents;
        } else {
            this.#restoreWorkspacePanels();
        }
        if (!allowOperationalStatus) this.operationalStatusIsExpanded = false;
        this.#synchronizeOperationalStatusPresentation();
        this.#synchronizeWorkspacePresentation();
        this.#synchronizeControlPanelPresentation();
        this.workspaceSizeObserver = new documentContext.defaultView.ResizeObserver(
            () => this.#measureWorkspaceHeight()
        );
        this.workspaceSizeObserver.observe(this.controlPanelElement);
        this.#measureWorkspaceHeight();
        this.stopPanelActivity = bindPanelActivity(documentContext, this.appElement);
    }

    /**
     * Apply one map's panel availability and optional initial disclosures before layer restoration.
     * Unavailable panels reject every opening request while retaining disclosure choices.
     * Focus leaves a disabled surface for an available disclosure, the sidebar opener or the map.
     * @param {WorkspacePanelOptions} options Resolved layout choices from browser composition.
     * @return {void}
     */
    setWorkspaceOptions({ allowCatalog, allowMapContents, initialState }) {
        this.allowCatalog = allowCatalog;
        this.allowMapContents = allowMapContents;
        for (const [index, available] of [allowCatalog, allowMapContents].entries()) {
            this.workspaceDisclosures[index].isAvailable = available;
        }
        if (initialState) {
            this.workspaceDisclosures[0].openWhenAvailable = initialState.catalog;
            this.workspaceDisclosures[1].openWhenAvailable = initialState.mapContents;
            this.controlPanelIsCollapsed = false;
        }
        this.#synchronizeWorkspacePresentation();
        this.#synchronizeControlPanelPresentation();
        this.#scheduleMapInvalidation();
    }

    /**
     * Publish the shell's measured height for map-control clearance in CSS.
     * CSS decides when the compact card overlaps the map; this measurement
     * does not inspect map controls or change any panel's visibility.
     * @return {void}
     */
    #measureWorkspaceHeight() {
        const height = `${this.controlPanelElement.getBoundingClientRect().height}px`;
        if (this.appElement.style.getPropertyValue("--workspace-card-height") !== height) {
            this.appElement.style.setProperty("--workspace-card-height", height);
        }
    }

    /**
     * Restore both panel states before displaying the sidebar.
     *
     * Missing or invalid saved values leave the markup defaults unchanged.
     * This runs only at startup; subsequent layer loading cannot reset panels.
     *
     * @return {void}
     */
    #restoreWorkspacePanels() {
        let saved;
        try {
            saved = JSON.parse(this.workspaceStorage?.read() ?? "null");
        } catch {
            return;
        }
        if (typeof saved?.catalogOpen !== "boolean" ||
            typeof saved?.mapLayersOpen !== "boolean") return;
        const changed = this.workspaceDisclosures[0].openWhenAvailable !== saved.catalogOpen ||
            this.workspaceDisclosures[1].openWhenAvailable !== saved.mapLayersOpen;
        this.workspaceDisclosures[0].openWhenAvailable = saved.catalogOpen;
        this.workspaceDisclosures[1].openWhenAvailable = saved.mapLayersOpen;
        if (changed) this.#scheduleMapInvalidation();
    }

    /**
     * Set whether the complete workspace sidebar is visually collapsed.
     *
     * Workspace and operational disclosure states are retained so reopening
     * restores the user's context. A changed state schedules one map
     * invalidation after the layout transition and moves focus to the
     * corresponding persistent disclosure control. With no available workspace,
     * the sidebar stays unavailable and this request has no effect.
     *
     * @param {boolean} isCollapsed Whether the sidebar should be collapsed.
     * @return {void}
     */
    setControlPanelCollapsed(isCollapsed) {
        if (!this.allowCatalog && !this.allowMapContents) return;
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
     * Expand one available semantic workspace by its layout-only name.
     *
     * This method lets the browser composition root respond to an explicit
     * feature presentation request without giving this controller feature
     * state or sibling implementation knowledge. Unavailable workspaces ignore
     * the request, including its focus and sidebar-opening effects.
     *
     * @param {"catalog"|"map-layers"} name Workspace name.
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
        if (!this.workspaceDisclosures[index].isAvailable) return;
        if (this.controlPanelIsCollapsed) {
            this.controlPanelIsCollapsed = false;
            this.#synchronizeControlPanelPresentation();
            this.#scheduleMapInvalidation();
        }
        const wasExpanded = this.workspaceDisclosures[index].openWhenAvailable;
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

    /** Reflect map-tool layout on the app shell without inspecting tool contents.
     * CSS retains responsibility for desktop/mobile dimensions. Unchanged values
     * do not rewrite attributes; the existing map ResizeObserver handles resizing.
     * @param {Object} layout Presentation supplied by the browser composition root.
     * @param {boolean} layout.open Whether the map-tool popover is open.
     * @param {boolean} layout.expanded Whether it occupies space for an active panel.
     * @param {boolean} layout.wide Whether its active panel uses the wider layout.
     * @param {number} layout.toolbarHeight Measured map-tool toolbar height in CSS pixels.
     * @return {void}
     */
    setInspectionLayout({ open, expanded, wide, toolbarHeight }) {
        for (const [name, value] of Object.entries({ open, expanded, wide })) {
            const attribute = `data-inspection-${name}`;
            const text = String(value);
            if (this.appElement.getAttribute(attribute) !== text) {
                this.appElement.setAttribute(attribute, text);
            }
        }
        const height = `${toolbarHeight}px`;
        if (this.appElement.style.getPropertyValue("--map-tools-height") !== height) {
            this.appElement.style.setProperty("--map-tools-height", height);
        }
    }

    /**
     * Keep a panel opaque while any registered interaction is using it.
     * Direct panel input still reveals the whole workspace using the configured timings.
     * @param {Element} panel Workspace surface whose opacity is controlled by the stylesheet.
     * @param {(publish:(active:boolean)=>void)=>()=>void} subscribe Publish current activity
     * immediately and on changes. Return a function that stops publication.
     * @return {()=>void} Disconnect this source and release its contribution to the panel.
     */
    registerPanelActivitySource(panel, subscribe) {
        const sources = this.#panelActivitySources;
        /** Apply this source's state alongside any others that hold the same panel.
         * @param {boolean} active Whether this interaction needs the panel to stay readable.
         * @return {void}
         */
        function publish(active) {
            if (!sources.has(disconnect)) return;
            sources.set(disconnect, active ? panel : null);
            panel.classList.toggle("is-panel-active", [...sources.values()].includes(panel));
        }
        /** Release this binding and ignore subsequent deliveries from its source. @return {void} */
        function disconnect() {
            if (!sources.has(disconnect)) return;
            publish(false);
            sources.delete(disconnect);
            unsubscribe();
        }
        sources.set(disconnect, null);
        const unsubscribe = subscribe(publish);
        return disconnect;
    }

    /**
     * Release panel activity subscriptions, DOM listeners and the shell-size observer.
     *
     * Already scheduled invalidations still complete, matching browser timer
     * behavior; subsequent layout-control events no longer change state.
     *
     * @return {void}
     */
    destroy() {
        for (const disconnect of this.#panelActivitySources.keys()) disconnect();
        this.stopPanelActivity();
        this.workspaceSizeObserver.disconnect();
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
            isAvailable: configuration.name === "catalog" ? this.allowCatalog : this.allowMapContents,
            openWhenAvailable: toggle.getAttribute("aria-expanded") !== "false",
            handleClick: () => this.#setWorkspaceExpanded(
                index,
                !this.workspaceDisclosures[index].openWhenAvailable,
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
     * saves both panel states and schedules map remeasurement because the
     * available sidebar allocation changed.
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
        if (!workspaceDisclosure.isAvailable) return;
        const stateChanged = workspaceDisclosure.openWhenAvailable !== isExpanded;
        workspaceDisclosure.openWhenAvailable = isExpanded;
        this.#synchronizeWorkspacePresentation();
        if (stateChanged) {
            this.#scheduleMapInvalidation();
            this.workspaceStorage?.write(JSON.stringify({
                catalogOpen: this.workspaceDisclosures[0].openWhenAvailable,
                mapLayersOpen: this.workspaceDisclosures[1].openWhenAvailable,
            }));
        }
        if (moveFocus) {
            workspaceDisclosure.toggle.focus();
        }
    }

    /**
     * Apply availability to stored disclosures and move focus out of hidden contents.
     *
     * @return {void}
     */
    #synchronizeWorkspacePresentation() {
        let needsFocus = false;
        for (const workspaceDisclosure of this.workspaceDisclosures) {
            const { isAvailable, toggle, panel } = workspaceDisclosure;
            const isExpanded = isAvailable && workspaceDisclosure.openWhenAvailable;
            const focused = this.documentContext.activeElement;
            needsFocus ||= (!isAvailable && toggle === focused) || (!isExpanded && panel.contains(focused));
            workspaceDisclosure.toggle.hidden = !isAvailable;
            workspaceDisclosure.toggle.disabled = !isAvailable;
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
        if (needsFocus) {
            const target = this.workspaceDisclosures.find(disclosure => disclosure.isAvailable)?.toggle;
            (target ? this.controlPanelIsCollapsed ? this.openPanelButton : target : this.mapElement).focus();
        }
    }

    /**
     * Apply the expanded/collapsed operational-status presentation.
     *
     * @return {void}
     */
    #synchronizeOperationalStatusPresentation() {
        this.operationalToggle.hidden = !this.allowOperationalStatus;
        this.operationalRegion.hidden = !this.allowOperationalStatus;
        this.operationalRegion.classList.toggle(
            "is-collapsed",
            !this.operationalStatusIsExpanded
        );
        this.operationalToggle.setAttribute(
            "aria-expanded",
            String(this.operationalStatusIsExpanded)
        );
        this.operationalToggle.setAttribute(
            "aria-label",
            this.operationalStatusIsExpanded
                ? "Hide status details"
                : "Show status details"
        );
        this.operationalBody.hidden = !this.operationalStatusIsExpanded;
        this.operationalBody.setAttribute(
            "aria-hidden",
            String(!this.operationalStatusIsExpanded)
        );
    }

    /** Hide an unavailable sidebar and maintain a visible focus/reopen destination. @return {void} */
    #synchronizeControlPanelPresentation() {
        const focused = this.documentContext.activeElement;
        const unavailable = !this.allowCatalog && !this.allowMapContents;
        const collapsed = this.controlPanelIsCollapsed || unavailable;
        const panelName = this.allowCatalog
            ? this.allowMapContents ? "Catalog & map contents" : "Catalog"
            : "Map contents";
        this.openPanelButton.textContent = panelName;
        for (const [button, action] of [
            [this.collapsePanelButton, "Collapse"], [this.openPanelButton, "Expand"],
        ]) {
            const label = `${action} ${panelName}`;
            button.setAttribute("aria-label", label);
            button.title = label;
        }
        this.controlPanelElement.hidden = unavailable;
        this.appElement.classList.toggle("is-workspace-unavailable", unavailable);
        this.controlPanelElement.classList.toggle(
            "is-collapsed",
            collapsed
        );
        this.appElement.classList.toggle(
            "is-control-panel-collapsed",
            collapsed
        );
        this.controlPanelElement.setAttribute(
            "aria-hidden",
            String(collapsed)
        );
        if (collapsed) {
            this.controlPanelElement.setAttribute("inert", "");
        } else {
            this.controlPanelElement.removeAttribute("inert");
        }
        this.controlPanelElement.inert = collapsed;
        this.collapsePanelButton.setAttribute(
            "aria-expanded",
            String(!collapsed)
        );
        this.openPanelButton.setAttribute(
            "aria-expanded",
            String(!collapsed)
        );
        this.openPanelButton.hidden = unavailable || !collapsed;
        this.openPanelButton.disabled = unavailable;
        if (collapsed && (this.controlPanelElement.contains(focused) ||
            (unavailable && focused === this.openPanelButton))) {
            (unavailable ? this.mapElement : this.openPanelButton).focus();
        } else if (!collapsed && focused === this.openPanelButton) {
            this.collapsePanelButton.focus();
        }
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
        if (!this.allowOperationalStatus) return;
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
            (this.operationalToggle === focusedElement ||
                this.operationalRegion.contains(focusedElement))
        ) {
            keyboardEvent.preventDefault();
            this.operationalStatusIsExpanded = false;
            this.#synchronizeOperationalStatusPresentation();
            this.#scheduleMapInvalidation();
            this.operationalToggle.focus();
            return;
        }
        const focusedWorkspaceIndex = this.workspaceDisclosures.findIndex(
            ({ isAvailable, openWhenAvailable, panel, toggle }) =>
                isAvailable && openWhenAvailable &&
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
