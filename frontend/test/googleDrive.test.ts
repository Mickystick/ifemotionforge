import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { triagePickedDocs } from "../src/lib/googleDrive";

/*
 * Only the triage is covered, and deliberately so: the rest of that module is
 * Google's popup, Google's picker and a download, none of which exist outside a
 * browser. This is the part with judgement in it — what gets downloaded and
 * what gets refused before a minute of somebody's phone data is spent on it.
 */

const LIMITS = {
  mimeTypes: ["image/jpeg", "image/png", "application/pdf"],
  maxBytes: 12 * 1024 * 1024,
};

describe("triagePickedDocs", () => {
  it("takes a picture and a PDF", () => {
    const { wanted, rejections } = triagePickedDocs(
      [
        { id: "1", name: "deposito.jpg", mimeType: "image/jpeg", sizeBytes: 240_000 },
        { id: "2", name: "transferencia.pdf", mimeType: "application/pdf", sizeBytes: 90_000 },
      ],
      LIMITS,
    );

    assert.deepEqual(
      wanted.map((doc) => doc.id),
      ["1", "2"],
    );
    assert.deepEqual(rejections, []);
  });

  it("refuses a type the server would refuse too", () => {
    const { wanted, rejections } = triagePickedDocs(
      [{ id: "1", name: "contrato.docx", mimeType: "application/vnd.openxmlformats", sizeBytes: 10 }],
      LIMITS,
    );

    assert.deepEqual(wanted, []);
    assert.deepEqual(rejections, ["“contrato.docx” is not an image or PDF."]);
  });

  it("says what a Google Doc actually needs, rather than blaming the download", () => {
    // A native Google file has no bytes to fetch — the Drive API answers "use
    // export". Picked through search, it would otherwise look like a failure.
    const { wanted, rejections } = triagePickedDocs(
      [{ id: "1", name: "Recibo", mimeType: "application/vnd.google-apps.document" }],
      LIMITS,
    );

    assert.deepEqual(wanted, []);
    assert.deepEqual(rejections, [
      "“Recibo” is a Google file. Download it as a PDF and attach it again.",
    ]);
  });

  it("refuses an oversized file before it is downloaded", () => {
    const { wanted, rejections } = triagePickedDocs(
      [{ id: "1", name: "video.pdf", mimeType: "application/pdf", sizeBytes: 20 * 1024 * 1024 }],
      LIMITS,
    );

    assert.deepEqual(wanted, []);
    assert.deepEqual(rejections, ["“video.pdf” is 20.0 MB; the maximum is 12 MB."]);
  });

  it("reads the size Google sends as a string", () => {
    const { wanted } = triagePickedDocs(
      [{ id: "1", name: "grande.pdf", mimeType: "application/pdf", sizeBytes: "99000000" }],
      LIMITS,
    );

    assert.deepEqual(wanted, []);
  });

  it("lets an unknown size through, for the real check downstream", () => {
    const { wanted, rejections } = triagePickedDocs(
      [{ id: "1", name: "sin-tamano.pdf", mimeType: "application/pdf" }],
      LIMITS,
    );

    assert.deepEqual(
      wanted.map((doc) => doc.id),
      ["1"],
    );
    assert.deepEqual(rejections, []);
  });

  it("keeps the good ones when only some are refused", () => {
    const { wanted, rejections } = triagePickedDocs(
      [
        { id: "1", name: "bueno.png", mimeType: "image/png", sizeBytes: 5_000 },
        { id: "2", name: "malo.zip", mimeType: "application/zip", sizeBytes: 5_000 },
      ],
      LIMITS,
    );

    assert.deepEqual(
      wanted.map((doc) => doc.id),
      ["1"],
    );
    assert.equal(rejections.length, 1);
  });

  it("has nothing to say about an empty pick", () => {
    assert.deepEqual(triagePickedDocs([], LIMITS), { wanted: [], rejections: [] });
  });
});
