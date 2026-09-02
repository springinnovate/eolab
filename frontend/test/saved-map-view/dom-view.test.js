import assert from "node:assert/strict";
import test from "node:test";

import { createSavedMapViewUrl } from "../../src/saved-map-view/dom-view.js";

test("saved map URL keeps the viewer location and replaces its fragment", () => {
  assert.equal(
    createSavedMapViewUrl(
      "https://viewer.example/map?preview=1#old-anchor",
      "#view=abc_123",
    ),
    "https://viewer.example/map?preview=1#view=abc_123",
  );
});

test("saved map URL requires the owned fragment prefix", () => {
  assert.throws(
    () => createSavedMapViewUrl("https://viewer.example/", "#other=value"),
    /complete saved-map fragment/,
  );
});
