import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const MARKUP = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const STYLESHEET = readFileSync(
  new URL("../../src/style.css", import.meta.url),
  "utf8",
);
const MAIN_MODULE = readFileSync(
  new URL("../../src/main.js", import.meta.url),
  "utf8",
);

/**
 * Return one balanced markup element identified by a stable ID.
 *
 * @param {string} identifier Stable DOM identifier.
 * @return {string} Complete element source including its closing tag.
 * @throws {Error} If the element or matching closing tag is missing.
 */
function requireElementSource(identifier) {
  const openingPattern = new RegExp(
    `<([a-z][\\w-]*)\\b[^>]*\\bid="${identifier}"[^>]*>`,
    "i",
  );
  const openingMatch = openingPattern.exec(MARKUP);
  if (openingMatch === null) {
    throw new Error(`Required markup element is missing: ${identifier}`);
  }
  const tagPattern = new RegExp(`<\\/?${openingMatch[1]}\\b[^>]*>`, "gi");
  tagPattern.lastIndex = openingMatch.index;
  let depth = 0;
  for (const tagMatch of MARKUP.matchAll(tagPattern)) {
    depth += tagMatch[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      return MARKUP.slice(
        openingMatch.index,
        tagMatch.index + tagMatch[0].length,
      );
    }
  }
  throw new Error(`Required markup element is not closed: ${identifier}`);
}

test("temporary AOI is a labeled Raster analysis sampling section", () => {
  const analysisRegion = requireElementSource("eomap-raster-interpretation-region");
  const temporaryAoi = requireElementSource("temporary-aoi");

  assert.match(
    analysisRegion,
    /<details class="analysis-aoi-disclosure" id="analysis-aoi-disclosure">/,
  );
  assert.match(
    analysisRegion,
    /<summary\s+id="toggle-analysis-aoi"\s+aria-controls="temporary-aoi"\s+aria-expanded="false"/,
  );
  assert.match(analysisRegion, /Upload or manage a sampling AOI/);
  assert.match(analysisRegion, /id="temporary-aoi"/);
  assert.match(
    temporaryAoi,
    /data-eomap-region="raster-interpretation"[^>]*aria-labelledby="temporary-aoi-heading"[^>]*aria-busy="false"/s,
  );
  assert.doesNotMatch(temporaryAoi, /role="tabpanel"/);
  assert.doesNotMatch(MARKUP, /id="show-temporary-aoi-workspace"/);
  assert.match(temporaryAoi, /<h3 id="temporary-aoi-heading">Temporary AOI<\/h3>/);
  assert.match(temporaryAoi, /<label for="temporary-aoi-file">/);
  assert.match(
    temporaryAoi,
    /id="temporary-aoi-file"[^>]*type="file"[^>]*accept="\.gpkg,\.zip,[^"]+"[^>]*required/s,
  );
  assert.match(temporaryAoi, /id="upload-temporary-aoi"[^>]*type="submit"/s);
  assert.match(temporaryAoi, /Not added to the Catalog/);
  assert.match(temporaryAoi, /removed automatically after expiration/);
});

test("multi-dataset selection and all AOI actions remain keyboard-native", () => {
  const temporaryAoi = requireElementSource("temporary-aoi");

  assert.match(temporaryAoi, /<form[^>]*id="temporary-aoi-selection-form"[^>]*hidden/s);
  assert.match(temporaryAoi, /<label for="temporary-aoi-dataset">/);
  assert.match(temporaryAoi, /<select[^>]*id="temporary-aoi-dataset"/s);
  assert.match(temporaryAoi, /Nothing will be displayed\s+until you choose one/);
  for (const identifier of [
    "cancel-temporary-aoi-selection",
    "toggle-temporary-aoi",
    "zoom-temporary-aoi",
    "remove-temporary-aoi",
  ]) {
    assert.match(
      temporaryAoi,
      new RegExp(`<button[^>]*id="${identifier}"[^>]*type="button"`, "s"),
    );
  }
  assert.match(temporaryAoi, /id="toggle-temporary-aoi"[^>]*aria-pressed="true"/s);
  assert.match(temporaryAoi, /role="group"[^>]*aria-label="Temporary AOI map actions"/s);
});

test("temporary AOI status and actionable errors are adjacent live regions", () => {
  const temporaryAoi = requireElementSource("temporary-aoi");
  const statusIndex = temporaryAoi.indexOf('id="temporary-aoi-status"');
  const errorIndex = temporaryAoi.indexOf('id="temporary-aoi-error"');

  assert.equal(statusIndex > 0, true);
  assert.equal(errorIndex > statusIndex, true);
  assert.match(
    temporaryAoi,
    /id="temporary-aoi-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/s,
  );
  assert.match(
    temporaryAoi,
    /id="temporary-aoi-error"[^>]*role="alert"[^>]*aria-atomic="true"/s,
  );
  assert.match(
    temporaryAoi,
    /aria-describedby="temporary-aoi-help temporary-aoi-status temporary-aoi-error"/,
  );
});

test("temporary AOI upload progress is native, labeled, and described", () => {
  assert.match(
    MARKUP,
    /<label for="temporary-aoi-upload-progress">\s*Approximate upload progress\s*<\/label>/s,
  );
  assert.match(
    MARKUP,
    /<progress[^>]*id="temporary-aoi-upload-progress"[^>]*max="100"[^>]*value="0"[^>]*aria-describedby="temporary-aoi-upload-progress-detail temporary-aoi-status"/s,
  );
  assert.match(
    STYLESHEET,
    /\.temporary-aoi-upload-progress progress\s*\{[^}]*width:\s*100%[^}]*accent-color:/s,
  );
  assert.match(
    STYLESHEET,
    /\.temporary-aoi-upload-progress\[hidden\][^{]*\{[^}]*display:\s*none/s,
  );
});

test("temporary AOI is bounded inside analysis without taking Catalog scroll", () => {
  assert.match(
    STYLESHEET,
    /\.analysis-aoi-disclosure\s*\{[^}]*margin-bottom:\s*14px[^}]*border:/s,
  );
  assert.match(
    STYLESHEET,
    /\.analysis-aoi-disclosure \.temporary-aoi-card\s*\{[^}]*display:\s*block[^}]*margin:\s*0[^}]*border:\s*0[^}]*padding:\s*12px[^}]*box-shadow:\s*none/s,
  );
  assert.match(
    STYLESHEET,
    /\.catalog-results-scroll\s*\{[^}]*overflow:\s*auto[^}]*overscroll-behavior:\s*contain/s,
  );
  assert.match(
    STYLESHEET,
    /\.temporary-aoi-upload\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s,
  );
  assert.match(
    STYLESHEET,
    /@media \(max-width: 699px\)\s*\{[\s\S]*?\.control-panel\s*\{[^}]*inset:\s*auto 8px 8px[^}]*height:\s*min\(76dvh, 680px\)/s,
  );
  assert.match(
    STYLESHEET,
    /\.temporary-aoi-selection-actions,[\s\S]*?\.temporary-aoi-actions\s*\{[^}]*flex-wrap:\s*wrap/s,
  );
  assert.match(
    STYLESHEET,
    /\.temporary-aoi-overlay\s*\{[^}]*vector-effect:\s*non-scaling-stroke/s,
  );
});

test("application initializes temporary AOI directly against the shared map", () => {
  assert.match(
    MAIN_MODULE,
    /import \{ initializeTemporaryAoi \} from "\.\/temporary-aoi\/temporary-aoi\.js"/,
  );
  assert.match(
    MAIN_MODULE,
    /const leafletMap = initializeMap\(appGlobalConfiguration\);[\s\S]*initializeTemporaryAoi\(leafletMap, L\);[\s\S]*initializeCatalog\(/,
  );
});
