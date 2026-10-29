/**
 * Contextual help and token completion for the Catalog search input.
 *
 * This component owns only search-assistance presentation and interaction.
 * The Catalog parser remains authoritative for executing the resulting text.
 */

import { CATALOG_SEARCH_FILTERS } from "./catalog.js";

/**
 * @typedef {Object} CatalogSearchTokenRange
 * @property {number} start Inclusive token start.
 * @property {number} end Exclusive token end.
 * @property {string} text Token text around the caret.
 */

/**
 * Find the whitespace-delimited Catalog search token containing the caret.
 *
 * @param {string} value Complete Catalog search text.
 * @param {number} caretPosition Current input caret offset.
 * @return {CatalogSearchTokenRange} Current token boundaries and text.
 */
export function getCatalogSearchTokenRange(value, caretPosition) {
    const caret = Math.max(0, Math.min(value.length, caretPosition));
    let start = caret;
    let end = caret;
    while (start > 0 && !/\s/.test(value[start - 1])) {
        start -= 1;
    }
    while (end < value.length && !/\s/.test(value[end])) {
        end += 1;
    }
    return { start, end, text: value.slice(start, end) };
}

/**
 * Return relevant filters without repeating fields already present elsewhere.
 *
 * A recognized prefix narrows the list. Ordinary literal search text keeps
 * every remaining filter visible so users can discover field syntax while
 * typing filenames or hazards.
 *
 * @param {string} value Complete Catalog search text.
 * @param {number} caretPosition Current input caret offset.
 * @param {ReadonlyArray<Object>} [filters=CATALOG_SEARCH_FILTERS] Supported
 * parser-owned filter descriptions.
 * @return {ReadonlyArray<Object>} Filters relevant to the current token.
 */
export function getCatalogSearchSuggestions(
    value,
    caretPosition,
    filters = CATALOG_SEARCH_FILTERS
) {
    const range = getCatalogSearchTokenRange(value, caretPosition);
    const otherTokens = [
        value.slice(0, range.start),
        value.slice(range.end)
    ]
        .join(" ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    const usedFields = new Set(
        otherTokens
            .map((token) => {
                const separatorIndex = token.indexOf(":");
                return separatorIndex > 0
                    ? token.slice(0, separatorIndex)
                    : "";
            })
            .map((field) => field.toLowerCase())
            .filter(Boolean)
    );
    const availableFilters = filters.filter(
        (filter) => !usedFields.has(filter.field)
    );
    const normalizedToken = range.text.toLowerCase();
    if (normalizedToken === "") {
        return availableFilters;
    }
    const matches = availableFilters.filter((filter) =>
        [filter.field, filter.token, filter.value ?? "", ...filter.keywords]
            .filter(Boolean)
            .some((candidate) => candidate.startsWith(normalizedToken)) ||
        normalizedToken.startsWith(filter.token)
    );
    return matches.length > 0 ? matches : availableFilters;
}

/**
 * Replace only the token at the caret with one supported filter token.
 *
 * @param {string} value Complete Catalog search text.
 * @param {number} caretPosition Current input caret offset.
 * @param {{token:string}} filter Selected parser-owned filter description.
 * @return {{value:string,caretPosition:number}} Updated query and caret.
 */
export function applyCatalogSearchSuggestion(value, caretPosition, filter) {
    const range = getCatalogSearchTokenRange(value, caretPosition);
    const updatedValue =
        value.slice(0, range.start) + filter.token + value.slice(range.end);
    return {
        value: updatedValue,
        caretPosition: range.start + filter.token.length
    };
}

/**
 * Build a stable, unique DOM identifier from an executable filter token.
 *
 * @param {{token:string}} filter Parser-owned filter description.
 * @return {string} Identifier suitable for an ARIA active descendant.
 */
function getCatalogSearchSuggestionOptionId(filter) {
    const tokenIdentifier = filter.token
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    return `catalog-search-suggestion-${tokenIdentifier}`;
}

/**
 * Accessible combobox/listbox presentation for Catalog search filters.
 */
export class CatalogSearchSuggestions {
    /**
     * Bind filter suggestions to the search input and its viewport.
     *
     * @param {Document} [documentContext=document] Catalog document.
     * @param {ReadonlyArray<Object>} [filters=CATALOG_SEARCH_FILTERS]
     * Parser-owned supported filter descriptions.
     * @throws {Error} When required Catalog search markup is absent.
     */
    constructor(
        documentContext = document,
        filters = CATALOG_SEARCH_FILTERS
    ) {
        this.document = documentContext;
        this.filters = filters;
        this.root = documentContext.querySelector(
            "#catalog-search-combobox"
        );
        this.input = documentContext.querySelector("#catalog-search");
        this.panel = documentContext.querySelector(
            "#catalog-search-suggestions"
        );
        this.list = documentContext.querySelector(
            "#catalog-search-suggestion-list"
        );
        if ([this.root, this.input, this.panel, this.list].includes(null)) {
            throw new Error("Catalog search suggestions require their markup");
        }
        this.activeIndex = -1;
        this.visibleFilters = [];
        this.isApplyingSuggestion = false;

        this.input.setAttribute("aria-expanded", "false");
        this.input.addEventListener("focus", () => this.open());
        this.input.addEventListener("input", () => {
            if (!this.isApplyingSuggestion) {
                this.open();
            }
        });
        this.input.addEventListener("keydown", (event) => {
            this.handleKeydown(event);
        });
        this.root.addEventListener("focusout", (event) => {
            if (!this.root.contains(event.relatedTarget)) {
                this.close();
            }
        });
        this.document.defaultView.addEventListener("resize", () => this.#positionSuggestions());
        this.document.addEventListener("scroll", () => this.#positionSuggestions(), true);
    }

    /** Open suggestions above the input for the token at its caret. @return {void} */
    open() {
        this.visibleFilters = getCatalogSearchSuggestions(
            this.input.value,
            this.input.selectionStart ?? this.input.value.length,
            this.filters
        );
        if (this.visibleFilters.length === 0) {
            this.close();
            return;
        }
        this.activeIndex = -1;
        this.render();
        this.panel.hidden = false;
        this.panel.showPopover();
        this.input.setAttribute("aria-expanded", "true");
        this.#positionSuggestions();
    }

    /** Close suggestions and remove the active-descendant relationship. @return {void} */
    close() {
        this.panel.hidePopover();
        this.panel.hidden = true;
        this.activeIndex = -1;
        this.input.setAttribute("aria-expanded", "false");
        this.input.removeAttribute("aria-activedescendant");
    }

    /**
     * Keep the open helper above the input and within the viewport.
     * When there is less than two rows of space above, use a short list below.
     * Close it when the input scrolls offscreen. The native popover escapes
     * the Catalog pane's clipping containers.
     * @return {void}
     */
    #positionSuggestions() {
        if (this.panel.hidden) return;
        const { innerWidth, innerHeight } = this.document.defaultView;
        const anchor = this.input.getBoundingClientRect();
        if (anchor.bottom <= 0 || anchor.top >= innerHeight) {
            this.close();
            return;
        }
        const above = anchor.top - 12;
        const below = innerHeight - anchor.bottom - 12;
        const placeAbove = above >= 80 || above >= below;
        const width = Math.min(anchor.width, innerWidth - 16);
        this.panel.style.width = `${width}px`;
        this.panel.style.maxHeight = `${Math.max(0, Math.min(160, placeAbove ? above : below))}px`;
        this.panel.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - width - 8))}px`;
        const height = this.panel.getBoundingClientRect().height;
        this.panel.style.top = `${placeAbove ? anchor.top - height - 4 : anchor.bottom + 4}px`;
    }

    /**
     * Render the current filter choices without moving focus from the input.
     *
     * @return {void}
     */
    render() {
        const optionElements = this.visibleFilters.map((filter, index) => {
            const option = this.document.createElement("button");
            const token = this.document.createElement("code");
            const label = this.document.createElement("strong");
            option.type = "button";
            option.id = getCatalogSearchSuggestionOptionId(filter);
            option.className = "catalog-search-suggestion";
            option.setAttribute("role", "option");
            option.setAttribute(
                "aria-selected",
                String(index === this.activeIndex)
            );
            option.tabIndex = -1;
            token.textContent = filter.token;
            label.textContent = filter.label;
            option.title = filter.description;
            option.append(token, label);
            option.addEventListener("pointerdown", (event) => {
                event.preventDefault();
            });
            option.addEventListener("click", () => {
                this.apply(filter);
            });
            return option;
        });
        this.list.replaceChildren(...optionElements);
        const activeOption = optionElements[this.activeIndex] ?? null;
        if (activeOption === null) {
            this.input.removeAttribute("aria-activedescendant");
        } else {
            this.input.setAttribute(
                "aria-activedescendant",
                activeOption.id
            );
            activeOption.scrollIntoView({ block: "nearest" });
        }
    }

    /**
     * Apply one filter token and notify the existing search input path when
     * the inserted syntax is immediately executable.
     *
     * @param {Object} filter Parser-owned filter description.
     * @return {void}
     */
    apply(filter) {
        const update = applyCatalogSearchSuggestion(
            this.input.value,
            this.input.selectionStart ?? this.input.value.length,
            filter
        );
        this.input.value = update.value;
        this.input.setSelectionRange(
            update.caretPosition,
            update.caretPosition
        );
        this.input.focus();
        this.close();
        if (filter.searchImmediately) {
            this.isApplyingSuggestion = true;
            this.input.dispatchEvent(new Event("input", { bubbles: true }));
            this.isApplyingSuggestion = false;
        }
    }

    /**
     * Navigate, select, or dismiss the list from the Catalog search input.
     *
     * @param {KeyboardEvent} event Input keyboard event.
     * @return {void}
     */
    handleKeydown(event) {
        if (event.key === "Escape" && !this.panel.hidden) {
            event.preventDefault();
            event.stopPropagation();
            this.close();
            return;
        }
        if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
            return;
        }
        if (this.panel.hidden) {
            if (event.key === "Enter") {
                return;
            }
            this.open();
        }
        if (this.visibleFilters.length === 0) {
            return;
        }
        if (event.key === "Enter") {
            const selectedFilter = this.visibleFilters[this.activeIndex];
            if (selectedFilter === undefined) {
                return;
            }
            event.preventDefault();
            this.apply(selectedFilter);
            return;
        }
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        this.activeIndex = this.activeIndex === -1
            ? direction === 1
                ? 0
                : this.visibleFilters.length - 1
            : (this.activeIndex + direction + this.visibleFilters.length) %
                this.visibleFilters.length;
        this.render();
    }
}
