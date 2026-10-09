import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeUndeliveredShare, readShareRequest } from "../src/lib/sharedIntake";

/*
 * `readShareRequest` is the part that decides whether a page load is an
 * ordinary one or a share arriving, and it runs on EVERY load. Getting it wrong
 * in the "ordinary" direction would pop the receipt form open on somebody who
 * just opened the app.
 *
 * `takeSharedPayload` needs a real IndexedDB and is exercised on the device.
 */
describe("readShareRequest", () => {
  it("says nothing for an ordinary page load", () => {
    assert.equal(readShareRequest(""), null);
    assert.equal(readShareRequest("?"), null);
  });

  it("ignores unrelated query parameters", () => {
    assert.equal(readShareRequest("?tab=recibos&foo=bar"), null);
  });

  it("finds the id the service worker redirected with", () => {
    assert.deepEqual(readShareRequest("?compartido=abc-123"), {
      kind: "payload",
      id: "abc-123",
      received: null,
    });
  });

  it("finds it alongside other parameters, in any position", () => {
    assert.deepEqual(readShareRequest("?a=1&compartido=xyz&b=2"), {
      kind: "payload",
      id: "xyz",
      received: null,
    });
  });

  it("decodes a percent-encoded id", () => {
    // The worker encodes the id into the redirect; URLSearchParams decodes it.
    assert.deepEqual(readShareRequest("?compartido=a%2Fb"), {
      kind: "payload",
      id: "a/b",
      received: null,
    });
  });

  it("recognises the worker's own failure signal", () => {
    assert.deepEqual(readShareRequest("?compartido=error"), { kind: "failed", received: null });
  });

  it("carries the worker's account of what arrived", () => {
    const received = "text: 0 caracteres; comprobante: image/jpeg, 43160 B";

    assert.deepEqual(
      readShareRequest(`?compartido=abc&recibido=${encodeURIComponent(received)}`),
      { kind: "payload", id: "abc", received },
    );
    assert.deepEqual(
      readShareRequest(`?compartido=error&recibido=${encodeURIComponent("TypeError: x")}`),
      { kind: "failed", received: "TypeError: x" },
    );
  });

  /*
   * An empty value is the shape a half-built URL takes — "?compartido=" with
   * nothing after it. Treating it as an id would send the app looking up a
   * record keyed by the empty string, find nothing, and open the form with an
   * unexplained "no image" notice on a load nobody shared anything into.
   */
  it("treats an empty value as no share at all", () => {
    assert.equal(readShareRequest("?compartido="), null);
  });
});

/*
 * The notice is the only diagnostic a phone gives back without a USB cable, so
 * each way a share can lose its file has to read differently — "no image" for
 * all of them is what made the last round of this impossible to pin down.
 */
describe("describeUndeliveredShare", () => {
  const received = "text: 0 caracteres; title: 0 caracteres";

  it("says the file never came when the record holds none", () => {
    const notice = describeUndeliveredShare(
      { status: "found", payload: { files: [], text: "", title: "" } },
      received,
    );

    assert.match(notice, /^The shared item reached Lindero without an image\./);
    assert.match(notice, /received: text: 0 caracteres; title: 0 caracteres/);
  });

  it("tells a missing record apart from an empty one", () => {
    assert.match(
      describeUndeliveredShare({ status: "missing" }, received),
      /no longer saved/,
    );
  });

  it("names the error when the record could not be read", () => {
    const notice = describeUndeliveredShare(
      { status: "unreadable", detail: "UnknownError: blob read failed" },
      received,
    );

    assert.match(notice, /could not read it/);
    assert.match(notice, /error: UnknownError: blob read failed/);
  });

  it("keeps the worker's own failure message", () => {
    assert.match(
      describeUndeliveredShare({ status: "failed" }, "TypeError: bad multipart"),
      /^Could not read the item you shared\..*TypeError: bad multipart/,
    );
  });

  it("stays a plain sentence when there is no detail to add", () => {
    assert.equal(
      describeUndeliveredShare({ status: "missing" }, null),
      "The shared item arrived, but it was no longer saved when Lindero opened. Attach the proof file below.",
    );
  });
});
