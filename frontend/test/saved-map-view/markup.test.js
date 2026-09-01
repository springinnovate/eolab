import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const markupUrl = new URL("../../index.html", import.meta.url);

test("saved map controls expose buttons, local picker, and confirmation dialog", async () => {
  const markup = await readFile(markupUrl, "utf8");

  assert.match(markup, /id="save-map-view"[^>]*>\s*Save view/s);
  assert.match(markup, /id="open-map-view"[^>]*aria-haspopup="dialog"/s);
  assert.match(markup, /id="open-map-view-file"[^>]*type="file"[^>]*hidden/s);
  assert.match(markup, /<dialog[^>]*id="saved-map-view-dialog"/s);
  assert.match(markup, /id="confirm-open-map-view"[^>]*value="open"/s);
});
