import assert from "node:assert/strict";

import { SavedMapApiClient } from "../src/saved-map-view/api-client.js";

/**
 * Use the named-map API client with an in-memory HTTP record for restore and save tests.
 * @param {Object|null} [initialView=null] Published map document returned on the first read.
 * @return {Object} Viewer, editor and author configurations, stored record and save actions.
 */
export function createNamedMapFixture(initialView = null) {
  const fields = { slug: "survey", title: "Survey", subtitle: "" };
  const record = { ...fields, view: initialView, revision: 1 };
  const publicationApi = new SavedMapApiClient(async (_url, request) => {
    if (request.method !== "GET") {
      Object.assign(record, JSON.parse(request.body));
      record.revision++;
    }
    return Response.json(request.method === "POST" ? { ...record, editToken: "f".repeat(64) } : record);
  });
  return {
    record,
    viewer: { namedMapSlug: fields.slug, restoreSharedMap: true, publicationApi },
    editor: { namedMapSlug: fields.slug, editPublishedMap: true, publicationApi },
    author: { allowPublishing: true, publicationApi },
    /**
     * Save through the administrator action and read the newly stored revision.
     * @param {import("../src/saved-map-view/controller.js").SavedMapViewController} controller Open editor.
     * @return {Promise<Object>} The document accepted by the named-map client.
     */
    async saveEdits(controller) {
      const revision = record.revision;
      await controller.savePublishedMapChanges(fields);
      assert.equal(record.revision, revision + 1, "the editor must write a new revision");
      return record.view;
    },
    /**
     * Capture the authoring map and submit the publication form.
     * @param {import("../src/saved-map-view/controller.js").SavedMapViewController} controller Authoring map.
     * @return {Promise<Object>} The document posted to the named-map service.
     */
    async publish(controller) {
      await controller.openPublicationDialog();
      await controller.publishMap(fields);
      assert.ok(record.view, "the author must publish the captured view");
      return record.view;
    },
  };
}
