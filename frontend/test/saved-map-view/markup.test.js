import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const markupUrl = new URL("../../index.html", import.meta.url);

test("saved map controls expose one accessible link action and open dialog", async () => {
  const markup = await readFile(markupUrl, "utf8");

  assert.match(markup, /id="copy-map-link"[^>]*title="Copy a link to this map view"/s);
  assert.match(markup, /id="copy-map-link-label">Copy map link</);
  assert.doesNotMatch(markup, /id="(?:save|open)-map-view"/);
  assert.doesNotMatch(markup, /id="open-map-view-file"/);
  assert.match(markup, /<dialog[^>]*id="saved-map-view-dialog"/s);
  assert.match(markup, /id="saved-map-view-dialog-url"[^>]*readonly[^>]*hidden/s);
  assert.match(markup, /id="confirm-open-map-view"[^>]*value="open"/s);
});
