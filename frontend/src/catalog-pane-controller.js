/**
 * Catalog pane disclosure behavior.
 *
 * The results and inspector panes own independent expanded states. Layout
 * classes live on their shared grid so CSS can give an open pane the space
 * released by its collapsed sibling.
 */

const CATALOG_PANES = [
    {
        key: "catalog-browser",
        paneSelector: "#catalog-results-pane",
        bodySelector: "#catalog-results-body",
        toggleSelector: "#toggle-catalog-results",
        name: "Catalog results"
    },
    {
        key: "catalog-inspector",
        paneSelector: "#catalog-item-inspector",
        bodySelector: "#catalog-inspector-body",
        toggleSelector: "#toggle-catalog-inspector",
        name: "Selected record"
    }
];

/**
 * Connects the independent Catalog pane disclosure controls.
 *
 * @param {Document} documentContext Document containing the Catalog workspace.
 * @return {void}
 */
export function initializeCatalogPaneControls(documentContext = document) {
    const layoutElement = documentContext.querySelector("#catalog-layout");
    if (layoutElement === null) {
        throw new Error("Catalog layout is required");
    }

    for (const configuration of CATALOG_PANES) {
        const paneElement = documentContext.querySelector(
            configuration.paneSelector
        );
        const bodyElement = documentContext.querySelector(
            configuration.bodySelector
        );
        const toggleElement = documentContext.querySelector(
            configuration.toggleSelector
        );
        if (
            paneElement === null ||
            bodyElement === null ||
            toggleElement === null
        ) {
            throw new Error(
                `${configuration.name} pane requires a body and toggle`
            );
        }

        /**
         * Applies one pane's expanded state without affecting its sibling.
         *
         * @param {boolean} isExpanded Whether the pane body is visible.
         * @return {void}
         */
        function setExpanded(isExpanded) {
            bodyElement.hidden = !isExpanded;
            paneElement.classList.toggle("is-collapsed", !isExpanded);
            layoutElement.classList.toggle(
                `is-${configuration.key}-collapsed`,
                !isExpanded
            );
            toggleElement.setAttribute(
                "aria-expanded",
                String(isExpanded)
            );
            toggleElement.textContent = `${
                isExpanded ? "Collapse" : "Expand"
            } ${configuration.name}`;
        }

        setExpanded(toggleElement.getAttribute("aria-expanded") !== "false");
        toggleElement.addEventListener("click", () => {
            setExpanded(
                toggleElement.getAttribute("aria-expanded") !== "true"
            );
        });
    }
}
