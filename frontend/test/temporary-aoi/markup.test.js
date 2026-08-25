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

test("temporary AOI upload uses labeled bounded native file and submit controls", () => {
  assert.match(
    MARKUP,
    /<section[^>]*id="temporary-aoi"[^>]*role="tabpanel"[^>]*aria-labelledby="show-temporary-aoi-workspace temporary-aoi-heading"/s,
  );
  assert.match(MARKUP, /<label for="temporary-aoi-file">/);
  assert.match(
    MARKUP,
    /id="temporary-aoi-file"[^>]*type="file"[^>]*accept="\.gpkg,\.zip,[^"]+"[^>]*required/s,
  );
  assert.match(MARKUP, /id="upload-temporary-aoi"[^>]*type="submit"/s);
  assert.match(MARKUP, /Not added to the Catalog/);
  assert.match(MARKUP, /removed automatically after expiration/);
});

test("multi-dataset selection and all AOI actions remain keyboard-native", () => {
  assert.match(MARKUP, /<form[^>]*id="temporary-aoi-selection-form"[^>]*hidden/s);
  assert.match(MARKUP, /<label for="temporary-aoi-dataset">/);
  assert.match(MARKUP, /<select[^>]*id="temporary-aoi-dataset"/s);
  assert.match(MARKUP, /Nothing will be displayed\s+until you choose one/);
  for (const identifier of [
    "cancel-temporary-aoi-selection",
    "toggle-temporary-aoi",
    "zoom-temporary-aoi",
    "remove-temporary-aoi",
  ]) {
    assert.match(
      MARKUP,
      new RegExp(`<button[^>]*id="${identifier}"[^>]*type="button"`, "s"),
    );
  }
  assert.match(MARKUP, /id="toggle-temporary-aoi"[^>]*aria-pressed="true"/s);
  assert.match(MARKUP, /role="group"[^>]*aria-label="Temporary AOI map actions"/s);
});

test("temporary AOI status and actionable errors are adjacent live regions", () => {
  const statusIndex = MARKUP.indexOf('id="temporary-aoi-status"');
  const errorIndex = MARKUP.indexOf('id="temporary-aoi-error"');
  assert.equal(statusIndex > 0, true);
  assert.equal(errorIndex > statusIndex, true);
  assert.match(
    MARKUP,
    /id="temporary-aoi-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/s,
  );
  assert.match(
    MARKUP,
    /id="temporary-aoi-error"[^>]*role="alert"[^>]*aria-atomic="true"/s,
  );
  assert.match(
    MARKUP,
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

test("temporary AOI layout remains bounded and responsive without taking Catalog scrolling", () => {
  assert.match(
    STYLESHEET,
    /\.panel-content\s*\{[^}]*display:\s*contents/s,
  );
  assert.match(
    STYLESHEET,
    /\.catalog-panel\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*3[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s,
  );
  assert.match(
    STYLESHEET,
    /\.temporary-aoi-card\s*\{[^}]*grid-column:\s*3[^}]*grid-row:\s*2 \/ 5[^}]*overflow-y:\s*auto/s,
  );
  assert.match(
    STYLESHEET,
    /\.temporary-aoi-upload\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s,
  );
  assert.match(
    STYLESHEET,
    /@media \(max-width:\s*820px\)[\s\S]*\.temporary-aoi-upload,[\s\S]*\.temporary-aoi-details\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s,
  );
  assert.match(
    STYLESHEET,
    /\.temporary-aoi-selection-actions,[\s\S]*\.temporary-aoi-actions\s*\{[^}]*flex-wrap:\s*wrap/s,
  );
  assert.match(STYLESHEET, /\.temporary-aoi-overlay\s*\{[^}]*vector-effect:\s*non-scaling-stroke/s);
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
