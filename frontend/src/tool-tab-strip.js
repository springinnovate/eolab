/**
 * Position an open tool menu beside its button, flipping above when needed.
 * @param {HTMLElement} menu Open popover with its final contents.
 * @param {HTMLButtonElement} button Button that opened the menu.
 * @return {void}
 */
export function positionToolMenu(menu, button) {
    const { innerWidth, innerHeight } = button.ownerDocument.defaultView;
    const anchor = button.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    const below = anchor.bottom + 6;
    const top = below + bounds.height <= innerHeight - 8 ? below : anchor.top - bounds.height - 6;
    menu.style.top = `${Math.max(8, Math.min(top, innerHeight - bounds.height - 8))}px`;
    menu.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 8))}px`;
}

/** Keep the active and recent views visible in a tab row and expose overflow through All tabs. */
export class ToolTabStrip {
    /**
     * Pair each tab with menu actions that activate it or use its existing close button.
     * @param {Document} documentContext Document containing this row's controls.
     * @param {string} idPrefix Shared ID prefix for the -tabs list, -all-tabs button,
     * -tab-count label and -tab-menu popover. Each list child is a tab button or a
     * group containing the tab and its owner's close button.
     */
    constructor(documentContext, idPrefix) {
        this.document = documentContext;
        this.list = documentContext.querySelector(`#${idPrefix}-tabs`);
        this.trigger = documentContext.querySelector(`#${idPrefix}-all-tabs`);
        this.count = documentContext.querySelector(`#${idPrefix}-tab-count`);
        this.menu = documentContext.querySelector(`#${idPrefix}-tab-menu`);
        this.activeTab = null;
        this.previousTab = null;
        this.visibleTabs = [];
        this.events = new AbortController();
        const options = { signal: this.events.signal };
        this.items = Array.from(this.list.children, container => {
            const tab = container.querySelector(".tool-tab") ?? container;
            const close = container.querySelector(".tool-tab-close");
            const choice = documentContext.createElement("button");
            choice.type = "button";
            choice.tabIndex = -1;
            choice.setAttribute("role", "menuitemradio");
            const label = documentContext.createElement("span");
            const detail = documentContext.createElement("small");
            choice.append(label, detail);
            this.menu.append(choice);
            choice.addEventListener("click", () => {
                this.menu.hidePopover();
                this.#activateTab(tab);
            }, options);
            const menuClose = close && documentContext.createElement("button");
            if (menuClose) {
                menuClose.type = "button";
                menuClose.tabIndex = -1;
                menuClose.className = "tool-tab-menu-close";
                menuClose.setAttribute("role", "menuitem");
                menuClose.setAttribute("aria-label", close.getAttribute("aria-label"));
                menuClose.textContent = "×";
                menuClose.addEventListener("click", () => {
                    this.menu.hidePopover();
                    close.click();
                }, options);
                this.menu.append(menuClose);
            }
            tab.addEventListener("keydown", event => this.#handleNavigationKey(event, false), options);
            close?.addEventListener("keydown", event => this.#handleNavigationKey(event, false), options);
            return { container, tab, close, choice, menuClose, label, detail };
        });
        this.menu.addEventListener("keydown", event => this.#handleNavigationKey(event, true), options);
        this.menu.addEventListener("toggle", event => {
            if (event.newState === "open") {
                positionToolMenu(this.menu, this.trigger);
                this.#focusMenuChoice();
            }
        }, options);
        this.trigger.addEventListener("keydown", event => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                this.trigger.click();
            }
        }, options);
        const ResizeObserverClass = documentContext.defaultView.ResizeObserver;
        this.observer = ResizeObserverClass && new ResizeObserverClass(() => this.#fitTabs());
        this.observer?.observe(this.list);
        for (const { container } of this.items) this.observer?.observe(container);
    }

    /**
     * Update destinations and their descriptions without replacing focused controls.
     * @param {HTMLButtonElement|null} active Tab for the visible panel, or null when none is open.
     * @param {Object} [options] Presentation state supplied by the owning view.
     * @param {HTMLButtonElement|null} [options.previous] Most recent available peer.
     * When omitted, use the previously selected tab.
     * @param {Map<HTMLButtonElement,string>} [options.contexts] Descriptions for menu entries.
     * @param {boolean} [options.hidden=false] Dismiss the overflow menu while the row is inactive.
     * @return {void}
     */
    render(active, { previous, contexts, hidden = false } = {}) {
        const focusedControl = this.document.activeElement;
        if (previous !== undefined) this.previousTab = previous;
        else if (active !== this.activeTab) this.previousTab = this.activeTab;
        this.activeTab = active;
        this.list.hidden = hidden;
        const first = this.items.find(({ tab }) => !tab.hidden && !tab.disabled);
        for (const { container, tab, close, choice, menuClose, label, detail } of this.items) {
            container.hidden = tab.hidden;
            tab.setAttribute("aria-selected", String(tab === active));
            tab.tabIndex = tab === (active ?? first?.tab) ? 0 : -1;
            if (close) close.tabIndex = tab === active ? 0 : -1;
            choice.hidden = tab.hidden;
            choice.disabled = tab.disabled;
            if (menuClose) {
                menuClose.hidden = tab.hidden || tab.getAttribute("data-open") !== "true";
                menuClose.disabled = close.disabled;
            }
            choice.setAttribute("aria-checked", String(tab === active));
            label.textContent = tab.textContent;
            const context = contexts?.get(tab);
            const unread = tab.getAttribute("data-unread") === "true";
            detail.textContent = [context, unread && "New results"].filter(Boolean).join(" · ");
            detail.hidden = !detail.textContent;
        }
        if (hidden) {
            this.trigger.hidden = true;
            this.menu.hidePopover();
            return;
        }
        this.#fitTabs(focusedControl);
    }

    /**
     * Fit each tab and its close button together, keeping the active tab in the row.
     * Overflowed tabs remain measurable so resizing and font changes can bring them back.
     * @param {Element|null} [focusedControl] Focus before render changed the availability of any controls.
     * @return {void}
     */
    #fitTabs(focusedControl = this.document.activeElement) {
        if (this.list.hidden) return;
        const width = this.list.getBoundingClientRect().width +
            (this.trigger.hidden ? 0 : this.trigger.getBoundingClientRect().width);
        if (!width) return;
        const available = this.items.filter(({ tab }) => !tab.hidden);
        const widths = new Map(available.map(({ tab, container }) => [
            tab, Math.max(container.scrollWidth, container.getBoundingClientRect().width),
        ]));
        const totalWidth = Array.from(widths.values()).reduce((sum, value) => sum + value, 0);
        const overflow = totalWidth > width;
        const menuHadFocus = this.menu.contains(focusedControl);
        const focusedItem = this.list.contains(focusedControl) &&
            this.items.find(({ tab, close }) => focusedControl === tab || focusedControl === close);
        this.count.textContent = String(available.length);
        this.trigger.hidden = !overflow;
        let space = width - (overflow ? this.trigger.getBoundingClientRect().width : 0);
        const priority = new Set([this.activeTab, this.previousTab, ...this.visibleTabs, ...widths.keys()]);
        const visible = new Set();
        for (const tab of priority) {
            if (!widths.has(tab)) continue;
            const tabWidth = widths.get(tab);
            if (!overflow || tab === this.activeTab || tabWidth <= space) {
                visible.add(tab);
                space -= tabWidth;
            }
        }
        this.visibleTabs = Array.from(widths.keys()).filter(tab => visible.has(tab));
        const keyboardTab = visible.has(this.activeTab) ? this.activeTab : this.visibleTabs.find(tab => !tab.disabled);
        const unread = [];
        for (const { tab, container } of available) {
            const outside = !visible.has(tab);
            tab.tabIndex = tab === keyboardTab ? 0 : -1;
            container.setAttribute("data-overflow", String(outside));
            if (outside && tab.getAttribute("data-unread") === "true") unread.push(tab.textContent);
        }
        const notice = unread.length ? `, new results in ${unread.join(", ")}` : "";
        this.trigger.setAttribute("data-unread", String(Boolean(notice)));
        this.trigger.setAttribute("aria-label", `All tabs (${available.length})${notice}`);
        this.trigger.title = notice ? `New results in ${unread.join(", ")}` : "";
        if (!overflow) {
            this.menu.hidePopover();
            if (menuHadFocus || focusedControl === this.trigger) keyboardTab?.focus();
        } else if (this.menu.matches(":popover-open")) {
            positionToolMenu(this.menu, this.trigger);
            if (menuHadFocus && (focusedControl.hidden || focusedControl.disabled)) this.#focusMenuChoice();
        }
        if (focusedItem && (!visible.has(focusedItem.tab) || focusedControl.disabled ||
            (focusedControl === focusedItem.close && focusedItem.tab.getAttribute("data-open") !== "true"))) {
            keyboardTab?.focus();
        }
    }

    /** Focus the selected menu row or the first available destination. @return {void} */
    #focusMenuChoice() {
        const enabled = this.items.filter(({ tab }) => !tab.hidden && !tab.disabled);
        (enabled.find(({ tab }) => tab === this.activeTab) ?? enabled[0])?.choice.focus();
    }

    /**
     * Open a destination through its existing action and focus its revealed tab.
     * @param {HTMLButtonElement} tab Available result or retained tool button.
     * @return {void}
     */
    #activateTab(tab) {
        tab.click();
        tab.focus();
    }

    /**
     * Switch tabs or move between their close buttons along the strip. In All tabs,
     * move vertically within the current column and horizontally between a tool and its close action.
     * @param {KeyboardEvent} event Key pressed on a tab or a menu item.
     * @param {boolean} inMenu Whether the key came from the open menu.
     * @return {void}
     */
    #handleNavigationKey(event, inMenu) {
        if (inMenu && (event.key === "Escape" || event.key === "Tab")) {
            this.menu.hidePopover();
            this.trigger.focus();
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
            }
            return;
        }
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (inMenu && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
            const row = this.items.find(({ choice, menuClose }) => event.target === choice || event.target === menuClose);
            const button = event.key === "ArrowLeft" ? row?.choice : row?.menuClose;
            if (button && !button.hidden && !button.disabled) {
                event.preventDefault();
                button.focus();
            }
            return;
        }
        const previousKey = inMenu ? "ArrowUp" : "ArrowLeft";
        const nextKey = inMenu ? "ArrowDown" : "ArrowRight";
        if (!["Home", "End", previousKey, nextKey].includes(event.key)) return;
        const enabled = this.items.filter(({ tab }) => !tab.hidden && !tab.disabled);
        const onClose = !inMenu && event.target.classList.contains("tool-tab-close");
        let controls;
        if (inMenu) {
            const closeColumn = event.target.getAttribute("role") === "menuitem";
            controls = closeColumn
                ? enabled.map(item => item.menuClose).filter(button => button && !button.hidden && !button.disabled)
                : enabled.map(item => item.choice);
        } else if (onClose) {
            controls = enabled.filter(({ tab, close }) => close && this.visibleTabs.includes(tab) && tab.getAttribute("data-open") === "true")
                .map(item => item.close);
        } else {
            controls = enabled.map(item => item.tab);
        }
        const current = controls.indexOf(event.target);
        if (current === -1) return;
        let next;
        if (event.key === "Home") next = 0;
        else if (event.key === "End") next = controls.length - 1;
        else if (event.key === nextKey) next = (current + 1) % controls.length;
        else next = (current - 1 + controls.length) % controls.length;
        event.preventDefault();
        if (inMenu || onClose) controls[next].focus();
        else this.#activateTab(controls[next]);
    }

    /** Release tab listeners, menu entries and size observation. @return {void} */
    destroy() {
        this.events.abort();
        this.observer?.disconnect();
        this.menu.hidePopover();
        this.menu.replaceChildren();
    }
}
