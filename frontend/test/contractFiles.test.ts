import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_CONTRACT_DOCUMENTS,
  screenContractFiles,
} from "../src/features/contracts/contractFiles";

/*
 * These rules are a mirror of the server's, and the reason to test the mirror
 * is what happens when it drifts: a file this lets through and the server
 * refuses is rejected AFTER the contract has been created, from a dialog whose
 * form is already spent.
 *
 * There are two callers now — the Nuevo contrato form and the contract panel —
 * which is exactly why the rules moved into one testable place.
 */

function file(name: string, type: string, size: number): File {
  const stub = new File([], name, { type });

  // `File` has no size setter and building a 31 MB blob to test a limit is
  // wasteful. The screening only reads the number.
  Object.defineProperty(stub, "size", { value: size });

  return stub;
}

const pdf = () => file("contrato-firmado.pdf", "application/pdf", 400 * 1024);

describe("screenContractFiles", () => {
  it("takes a scanned contract", () => {
    const { accepted, rejections } = screenContractFiles([pdf()], 0);

    assert.equal(accepted.length, 1);
    assert.deepEqual(rejections, []);
  });

  it("takes a photograph of the signed pages", () => {
    const { accepted } = screenContractFiles(
      [file("pagina-1.jpg", "image/jpeg", 2 * 1024 * 1024)],
      0,
    );

    assert.equal(accepted.length, 1);
  });

  /*
   * A .docx is the near miss worth naming: somebody drops the DRAFT they typed
   * instead of the scan of what was signed. Refused here rather than by the
   * server after the contract exists.
   */
  it("refuses anything that is not a PDF or an image, by name", () => {
    const { accepted, rejections } = screenContractFiles(
      [
        file(
          "borrador.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          9000,
        ),
      ],
      0,
    );

    assert.deepEqual(accepted, []);
    assert.match(rejections[0] ?? "", /borrador\.docx/);
  });

  /*
   * A HEIC straight off an iPhone sometimes arrives with no type at all. The
   * server takes it, so refusing it here would be this copy of the rules being
   * stricter than the rules.
   */
  it("takes a typeless HEIC on its extension", () => {
    const { accepted } = screenContractFiles([file("IMG_0421.HEIC", "", 3 * 1024 * 1024)], 0);

    assert.equal(accepted.length, 1);
  });

  it("does not extend that tolerance to any other typeless file", () => {
    const { accepted } = screenContractFiles([file("contrato.doc", "", 3 * 1024)], 0);

    assert.deepEqual(accepted, []);
  });

  it("refuses an empty file", () => {
    const { accepted, rejections } = screenContractFiles(
      [file("vacio.pdf", "application/pdf", 0)],
      0,
    );

    assert.deepEqual(accepted, []);
    assert.match(rejections[0] ?? "", /empty/);
  });

  /* 30 MB is the server's ceiling, and a phone photographing twelve pages
     reaches it without trying. */
  it("refuses a file over 30 MB and says how big it is", () => {
    const { accepted, rejections } = screenContractFiles(
      [file("escaneo.pdf", "application/pdf", 31 * 1024 * 1024)],
      0,
    );

    assert.deepEqual(accepted, []);
    assert.match(rejections[0] ?? "", /31\.0 MB/);
  });

  /* Counted against what is already held, not just against this batch — the
     form can be dropped on twice. */
  it("stops at the per-contract limit, counting what is already there", () => {
    const { accepted, rejections } = screenContractFiles(
      [pdf(), pdf()],
      MAX_CONTRACT_DOCUMENTS - 1,
    );

    assert.equal(accepted.length, 1);
    assert.match(rejections[0] ?? "", new RegExp(String(MAX_CONTRACT_DOCUMENTS)));
  });

  it("takes nothing at all once the limit is reached", () => {
    const { accepted, rejections } = screenContractFiles([pdf()], MAX_CONTRACT_DOCUMENTS);

    assert.deepEqual(accepted, []);
    assert.equal(rejections.length, 1);
  });

  /* One bad file in a multi-select must not cost the good ones. */
  it("keeps the good files out of a mixed drop and complains about the rest", () => {
    const { accepted, rejections } = screenContractFiles(
      [pdf(), file("notas.txt", "text/plain", 200), file("anexo.png", "image/png", 50 * 1024)],
      0,
    );

    assert.deepEqual(
      accepted.map((entry) => entry.name),
      ["contrato-firmado.pdf", "anexo.png"],
    );
    assert.equal(rejections.length, 1);
  });
});
