import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRasterDetailPreviewRgba,
  buildRasterDetailPreviewStyle,
  encodeRasterDetailPreviewPng,
} from "../../src/raster/detail-preview-image.js";
import {
  CENTER_SAMPLE_DETAIL_PREVIEW,
  NODATA_DETAIL_PREVIEW,
} from "../../test-support/raster/fixtures.js";

test("sampled raster style uses sample-grid range with the normal color ramp", () => {
  assert.deepEqual(buildRasterDetailPreviewStyle(CENTER_SAMPLE_DETAIL_PREVIEW), {
    minimum: 0,
    midpoint: 50,
    maximum: 100,
    minimumColor: "#2b83ba",
    midpointColor: "#ffffbf",
    maximumColor: "#d7191c",
  });
});

test("numeric sample grid colors remain row-major and nodata stays transparent", () => {
  const rgba = buildRasterDetailPreviewRgba(
    CENTER_SAMPLE_DETAIL_PREVIEW,
    buildRasterDetailPreviewStyle(CENTER_SAMPLE_DETAIL_PREVIEW),
  );

  assert.deepEqual(Array.from(rgba).slice(0, 24), [
    43, 131, 186, 255,
    255, 255, 191, 255,
    215, 25, 28, 255,
    0, 0, 0, 0,
    149, 193, 189, 255,
    235, 140, 110, 255,
  ]);
  assert.equal(rgba.length, 127 * 127 * 4);
  assert.deepEqual(
    Array.from(buildRasterDetailPreviewRgba(
      NODATA_DETAIL_PREVIEW,
      buildRasterDetailPreviewStyle(NODATA_DETAIL_PREVIEW),
    )),
    new Array(NODATA_DETAIL_PREVIEW.pixelValues.length * 4).fill(0),
  );
});

test("numeric sample-grid encoder preserves dimensions and RGBA bytes", () => {
  const calls = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext(kind) {
      assert.equal(kind, "2d");
      return {
        createImageData(width, height) {
          calls.push(["create", width, height]);
          return {
            data: new Uint8ClampedArray(width * height * 4),
          };
        },
        putImageData(image, x, y) {
          calls.push(["put", Array.from(image.data), x, y]);
        },
      };
    },
    toDataURL(mediaType) {
      calls.push(["encode", mediaType]);
      return "data:image/png;base64,sampled";
    },
  };
  const documentContext = {
    createElement(name) {
      assert.equal(name, "canvas");
      return canvas;
    },
  };

  const encoded = encodeRasterDetailPreviewPng(
    CENTER_SAMPLE_DETAIL_PREVIEW,
    buildRasterDetailPreviewStyle(CENTER_SAMPLE_DETAIL_PREVIEW),
    documentContext,
  );

  assert.equal(encoded, "data:image/png;base64,sampled");
  assert.equal(canvas.width, CENTER_SAMPLE_DETAIL_PREVIEW.imageWidth);
  assert.equal(canvas.height, CENTER_SAMPLE_DETAIL_PREVIEW.imageHeight);
  assert.deepEqual(calls[0], ["create", 127, 127]);
  assert.equal(calls[1][0], "put");
  assert.deepEqual(calls[1][1].slice(12, 16), [0, 0, 0, 0]);
  assert.deepEqual(calls[2], ["encode", "image/png"]);
});

test("numeric sample-grid encoder reports an unavailable canvas context", () => {
  assert.throws(
    () => encodeRasterDetailPreviewPng(
      CENTER_SAMPLE_DETAIL_PREVIEW,
      buildRasterDetailPreviewStyle(CENTER_SAMPLE_DETAIL_PREVIEW),
      { createElement: () => ({ getContext: () => null }) },
    ),
    /canvas is unavailable/,
  );
});
