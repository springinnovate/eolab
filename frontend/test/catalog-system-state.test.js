import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  applyCatalogSystemState,
  renderScanLocations,
  synchronizeScanDisclosureState,
} from "../src/catalog-system-state.js";

test("Catalog state replaces visual classes and announces only changes", () => {
  const classNames = new Set(["is-warning"]);
  const announcementClasses = new Set(["visually-hidden"]);
  const elements = {
    disclosure: {
      classList: {
        add(...names) {
          for (const name of names) classNames.add(name);
        },
        remove(...names) {
          for (const name of names) classNames.delete(name);
        },
      },
    },
    stateText: { textContent: "Catalog: searching" },
    stateAnnouncement: {
      textContent: "",
      classList: {
        toggle(name, force) {
          if (force) announcementClasses.add(name);
          else announcementClasses.delete(name);
        },
      },
    },
  };

  applyCatalogSystemState(
    elements,
    "Catalog: connected · 42 Items",
    "is-connected",
  );

  assert.equal(classNames.has("is-warning"), false);
  assert.equal(classNames.has("is-connected"), true);
  assert.equal(announcementClasses.has("visually-hidden"), true);
  assert.equal(elements.stateText.textContent, "Catalog: connected · 42 Items");
  assert.equal(
    elements.stateAnnouncement.textContent,
    "Catalog: connected · 42 Items",
  );

  elements.stateAnnouncement.textContent = "announcement unchanged";
  applyCatalogSystemState(
    elements,
    "Catalog: connected · 42 Items",
    "is-connected",
  );
  assert.equal(elements.stateAnnouncement.textContent, "announcement unchanged");

  applyCatalogSystemState(
    elements,
    "Catalog: unavailable",
    "is-warning",
  );
  assert.equal(classNames.has("is-connected"), false);
  assert.equal(classNames.has("is-warning"), true);
  assert.equal(announcementClasses.has("visually-hidden"), false);
  assert.equal(elements.stateAnnouncement.textContent, "Catalog: unavailable");

  applyCatalogSystemState(elements, "Catalog: connecting");
  assert.equal(announcementClasses.has("visually-hidden"), true);
  assert.equal(elements.stateAnnouncement.textContent, "Catalog: connecting");
});

test("Catalog scan controls use a native system-state disclosure", () => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const catalogStart = markup.indexOf(
    '<details class="system-state catalog-system-state" id="system-state">',
  );
  const scanStart = markup.indexOf('<section class="scan-card"');
  const renderingStart = markup.indexOf(
    '<details class="system-state rendering-diagnostics"',
  );
  const panelContentStart = markup.indexOf('id="eomap-tools-workbench"');
  const catalogDisclosureMarkup = markup.slice(catalogStart, renderingStart);

  assert.ok(catalogStart >= 0);
  assert.ok(catalogStart < scanStart);
  assert.ok(scanStart < renderingStart);
  assert.ok(renderingStart < panelContentStart);
  assert.match(
    catalogDisclosureMarkup,
    /<summary>\s*<span class="status-dot" aria-hidden="true"><\/span>\s*<span id="system-state-text">Catalog:/,
  );
  assert.match(
    catalogDisclosureMarkup,
    /class="system-state-details-body catalog-system-state-body"\s*role="region"\s*aria-label="Catalog scanning controls"\s*tabindex="0"/,
  );
  assert.match(catalogDisclosureMarkup, /id="start-scan"/);
  assert.match(catalogDisclosureMarkup, />Scan locations<\/strong>/);
  assert.match(catalogDisclosureMarkup, /id="scan-locations"/);
  assert.match(catalogDisclosureMarkup, /id="scan-status-disclosure"/);
  assert.match(catalogDisclosureMarkup, /id="scan-errors-disclosure"/);
  assert.doesNotMatch(
    markup.slice(panelContentStart),
    /<section class="scan-card"/,
  );
});

test("Catalog and Rendering disclosures share bounded responsive details styling", () => {
  const styles = readFileSync(
    new URL("../src/style.css", import.meta.url),
    "utf8",
  );

  assert.match(
    styles,
    /\.system-state-details-body \{[\s\S]*?max-height: min\(55vh, 520px\);[\s\S]*?overflow-y: auto;/,
  );
  assert.match(
    styles,
    /@media \(max-width: 820px\) \{[\s\S]*?\.system-state > summary,\s*\.system-state-details-body \{\s*padding-right: 12px;\s*padding-left: 12px;/,
  );
  assert.match(styles, /\.system-state-details-body:focus-visible/);
});

test("A running scan reveals the outer Catalog menu only on state transition", () => {
  const elements = {
    catalogState: { open: false },
    scanStatus: { open: false },
  };

  synchronizeScanDisclosureState(elements, true, false);
  assert.equal(elements.catalogState.open, true);
  assert.equal(elements.scanStatus.open, true);

  elements.catalogState.open = false;
  elements.scanStatus.open = false;
  synchronizeScanDisclosureState(elements, true, true);
  assert.equal(elements.catalogState.open, false);
  assert.equal(elements.scanStatus.open, false);

  elements.catalogState.open = true;
  elements.scanStatus.open = true;
  synchronizeScanDisclosureState(elements, false, true);
  assert.equal(elements.catalogState.open, true);
  assert.equal(elements.scanStatus.open, false);
});

test("Scan locations replace the loading state with configured paths", () => {
  const children = [];
  const listElement = {
    ownerDocument: {
      createElement(tagName) {
        return { tagName, textContent: "" };
      },
    },
    replaceChildren(...newChildren) {
      children.splice(0, children.length, ...newChildren);
    },
  };

  renderScanLocations(listElement, [
    "bigboi -- Z:\\bigbucket\\incoming",
    "bigboi -- Z:\\bigbucket\\archive\\2025",
  ]);

  assert.deepEqual(children, [
    { tagName: "li", textContent: "bigboi -- Z:\\bigbucket\\incoming" },
    {
      tagName: "li",
      textContent: "bigboi -- Z:\\bigbucket\\archive\\2025",
    },
  ]);
});
