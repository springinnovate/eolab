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
        this.panels = documentContext.querySelector("#map-inspection-panels");
        this.minimizeButton = documentContext.querySelector(
            "#toggle-map-inspection-dock"
        );
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
        this.tools = [
            {
                name: "feature",
                panel: this.feature,
                tab: documentContext.querySelector("#map-inspection-tab-feature"),
            },
            {
                name: "time-series",
                panel: this.vectorTimeSeries,
                tab: documentContext.querySelector("#map-inspection-tab-time-series"),
            },
            {
                name: "feature-profile",
                panel: this.vectorFeatureProfile,
                tab: documentContext.querySelector("#map-inspection-tab-feature-profile"),
            },
            {
                name: "histogram",
                panel: this.histogram,
                tab: documentContext.querySelector("#map-inspection-tab-histogram"),
            },
            {
                name: "style",
                panel: this.style,
                tab: documentContext.querySelector("#map-inspection-tab-style"),
            },
        ];
        this.isOpen = false;
        this.activeTool = null;
        this.activationOrder = [];
        this.minimized = false;
        this.onClose = () => this.closeHistogram();
        this.onMinimize = () => {
            this.minimized = !this.minimized;
            this.#renderDock();
        };
        this.onTabClick = (event) => {
            const tool = this.tools.find(({ tab }) => tab === event.currentTarget);
            if (tool !== undefined) this.#activateTool(tool.name);
        };
        this.onTabKeydown = (event) => this.#moveTabFocus(event);
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
        this.minimizeButton.addEventListener("click", this.onMinimize);
        for (const { tab } of this.tools) {
            tab.addEventListener("click", this.onTabClick);
            tab.addEventListener("keydown", this.onTabKeydown);
        }
        this.featureDetailsToggle.addEventListener(
            "click", this.onToggleFeatureDetails
        );
        this.document.addEventListener("keydown", this.onKeydown);
        this.#renderDock();
    }

    /** Reveal histogram results without changing analysis. @return {void} */
    showHistogram() {
        this.#showTool("histogram");
    }

    /** Hide histogram results and return focus to the map. @return {void} */
    closeHistogram() {
        if (this.histogram.hidden) return;
        this.#hideTool("histogram");
        this.map.focus();
    }

    /** Reveal styling alongside any open histogram without stealing its state. @return {void} */
    showStyle() {
        this.#showTool("style");
    }

    /** Hide styling without closing an open histogram or changing its sample. @return {void} */
    hideStyle() {
        this.#hideTool("style");
    }

    /**
     * Reveal vector feature results without changing retained map layers.
     *
     * @return {void}
     */
    showFeatureInspector() {
        this.#showTool("feature");
    }

    /**
     * Hide vector feature results without changing any other map-side tool.
     *
     * @return {void}
     */
    hideFeatureInspector() {
        this.#hideTool("feature");
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
        this.#closeToolState("feature-profile");
        this.#showTool("time-series");
    }

    /**
     * Hide vector time-series analysis without clearing its retained settings.
     *
     * @param {boolean} [moveFocus=false] Restore focus to the map.
     * @return {void}
     */
    hideVectorTimeSeries(moveFocus = false) {
        this.#hideTool("time-series");
        if (moveFocus) this.map.focus();
    }

    /** Reveal feature-field analysis as the active series presentation. @return {void} */
    showVectorFeatureProfile() {
        this.#closeToolState("time-series");
        this.#showTool("feature-profile");
    }

    /**
     * Hide feature-field analysis without clearing its per-source settings.
     *
     * @param {boolean} [moveFocus=false] Restore focus to the map.
     * @return {void}
     */
    hideVectorFeatureProfile(moveFocus = false) {
        this.#hideTool("feature-profile");
        if (moveFocus) this.map.focus();
    }

    /**
     * Reveal and activate one retained map tool.
     *
     * @param {string} name Stable presentation name from this controller's tool set.
     * @return {void}
     */
    #showTool(name) {
        const tool = this.#tool(name);
        tool.panel.hidden = false;
        this.#activateTool(name);
    }

    /**
     * Close one retained map tool and activate the most recently used survivor.
     *
     * @param {string} name Stable presentation name from this controller's tool set.
     * @return {void}
     */
    #hideTool(name) {
        this.#closeToolState(name);
        this.#synchronize();
    }

    /**
     * Update closed-tool state without synchronizing the native surface.
     *
     * This permits the two mutually exclusive series presentations to exchange
     * one dock position without briefly closing the shared popover.
     *
     * @param {string} name Stable presentation name from this controller's tool set.
     * @return {void}
     */
    #closeToolState(name) {
        const tool = this.#tool(name);
        tool.panel.hidden = true;
        this.activationOrder = this.activationOrder.filter(
            (candidate) => candidate !== name
        );
        if (this.activeTool !== name) return;
        this.activeTool = this.#fallbackToolName();
    }

    /**
     * Activate one open tool and expand the dock without changing peer state.
     *
     * @param {string} name Stable presentation name from this controller's tool set.
     * @return {void}
     */
    #activateTool(name) {
        const tool = this.#tool(name);
        if (tool.panel.hidden) return;
        this.activeTool = name;
        this.activationOrder = this.activationOrder.filter(
            (candidate) => candidate !== name
        );
        this.activationOrder.push(name);
        this.minimized = false;
        this.#synchronize();
    }

    /**
     * Resolve one controller-owned presentation descriptor.
     *
     * @param {string} name Stable presentation name.
     * @return {{name:string,panel:HTMLElement,tab:HTMLButtonElement}} Tool descriptor.
     * @throws {RangeError} When the controller receives an unknown tool name.
     */
    #tool(name) {
        const tool = this.tools.find((candidate) => candidate.name === name);
        if (tool === undefined) {
            throw new RangeError(`Unknown map inspection tool: ${name}`);
        }
        return tool;
    }

    /**
     * Return all tools whose retained presentation is open.
     *
     * @return {Array<{name:string,panel:HTMLElement,tab:HTMLButtonElement}>}
     * Open tool descriptors in stable dock order.
     */
    #openTools() {
        return this.tools.filter(({ panel }) => !panel.hidden);
    }

    /**
     * Choose the most recently activated tool that remains open.
     *
     * @return {string|null} Stable tool name, or null when the dock is empty.
     */
    #fallbackToolName() {
        const openNames = new Set(this.#openTools().map(({ name }) => name));
        return this.activationOrder.findLast((name) => openNames.has(name)) ??
            this.#openTools()[0]?.name ?? null;
    }

    /**
     * Apply horizontal tab-list keyboard navigation to currently open tools.
     *
     * @param {KeyboardEvent} event Keyboard event dispatched by one dock tab.
     * @return {void}
     */
    #moveTabFocus(event) {
        const openTools = this.#openTools();
        const currentIndex = openTools.findIndex(
            ({ tab }) => tab === event.currentTarget
        );
        if (currentIndex < 0) return;
        let targetIndex;
        if (event.key === "Home") targetIndex = 0;
        else if (event.key === "End") targetIndex = openTools.length - 1;
        else if (event.key === "ArrowRight") {
            targetIndex = (currentIndex + 1) % openTools.length;
        } else if (event.key === "ArrowLeft") {
            targetIndex = (currentIndex - 1 + openTools.length) % openTools.length;
        } else return;
        event.preventDefault();
        const target = openTools[targetIndex];
        this.#activateTool(target.name);
        target.tab.focus();
    }

    /**
     * Synchronize the bounded dock and its one native top-layer surface.
     *
     * @return {void}
     */
    #synchronize() {
        const shouldOpen = this.#openTools().length > 0;
        if (shouldOpen && (this.activeTool === null ||
            this.#tool(this.activeTool).panel.hidden)) {
            this.activeTool = this.#fallbackToolName();
        }
        if (!shouldOpen) {
            this.activeTool = null;
            this.activationOrder = [];
            this.minimized = false;
        }
        this.#renderDock();
        this.analysisToolsButton.hidden = shouldOpen;
        if (shouldOpen === this.isOpen) return;
        this.isOpen = shouldOpen;
        if (shouldOpen) this.root.showPopover();
        else this.root.hidePopover();
    }

    /**
     * Render tabs, active-panel visibility, and minimized presentation state.
     *
     * @return {void}
     */
    #renderDock() {
        this.panels.hidden = this.minimized;
        this.root.setAttribute("data-minimized", String(this.minimized));
        this.root.setAttribute("data-active-tool", this.activeTool ?? "");
        this.minimizeButton.textContent = this.minimized ? "Expand" : "Minimize";
        this.minimizeButton.setAttribute(
            "aria-expanded", String(!this.minimized)
        );
        this.minimizeButton.setAttribute(
            "aria-label", this.minimized ? "Expand map tools" : "Minimize map tools"
        );
        for (const { name, panel, tab } of this.tools) {
            const open = !panel.hidden;
            const active = open && this.activeTool === name;
            tab.hidden = !open;
            tab.setAttribute("aria-selected", String(active));
            tab.tabIndex = active ? 0 : -1;
            panel.setAttribute("data-map-inspection-active", String(active));
            panel.setAttribute(
                "aria-hidden", String(!active || this.minimized)
            );
        }
    }

    /** Release presentation listeners without changing retained analysis state. @return {void} */
    destroy() {
        this.closeButton.removeEventListener("click", this.onClose);
        this.minimizeButton.removeEventListener("click", this.onMinimize);
        for (const { tab } of this.tools) {
            tab.removeEventListener("click", this.onTabClick);
            tab.removeEventListener("keydown", this.onTabKeydown);
        }
        this.featureDetailsToggle.removeEventListener(
            "click", this.onToggleFeatureDetails
        );
        this.document.removeEventListener("keydown", this.onKeydown);
        this.histogram.hidden = true;
        this.style.hidden = true;
        this.feature.hidden = true;
        this.vectorTimeSeries.hidden = true;
        this.vectorFeatureProfile.hidden = true;
        this.activeTool = null;
        this.activationOrder = [];
        this.minimized = false;
        this.setFeatureInspectorExpanded(true);
        this.#synchronize();
    }
}
