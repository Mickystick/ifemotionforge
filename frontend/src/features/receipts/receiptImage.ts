/**
 * The receipt, as a PNG somebody can send.
 *
 * A customer asks for their receipt on WhatsApp, and what they want is the
 * document — the letterhead, the lot, the cuota, the boxed balance and the
 * signature — not a paragraph describing it. So this rasterises the very same
 * `ReceiptPaper` the screen and the printer render. There is no second layout
 * and no template to keep in step: what is sent is what was printed, because it
 * is the same markup and the same stylesheet.
 *
 * `html-to-image` does the rendering, and it is the one runtime dependency this
 * app has taken beyond React. The reason it is not written here, when the Code
 * 128 encoder next door WAS: that encoder is a table and eighty lines of
 * arithmetic with a right answer that never changes. This is the opposite —
 * cloning a subtree with every computed style resolved, inlining images as data
 * URIs, and re-fetching cross-origin stylesheets that CSSOM refuses to read,
 * across browsers that each get it wrong differently. Getting it subtly wrong
 * produces a plausible-looking document with a figure missing, handed to a
 * customer. That is not a bounded problem, and it is not one worth owning.
 *
 * How it works, since the mechanism is not obvious: the node is cloned into an
 * SVG `<foreignObject>`, which the browser then renders with its own engine and
 * draws onto a canvas. The clone is a separate document — it inherits nothing
 * from the page — which is why every style has to be copied onto it inline and
 * every font and image embedded. Anything left referenced by URL is simply
 * absent from the picture.
 */

import { getFontEmbedCSS, toBlob } from "html-to-image";

/**
 * Twice the CSS pixels, so the image survives being opened and pinched.
 *
 * WhatsApp re-compresses what it sends, and a phone screen is 2–3× denser than
 * the pixels this is laid out in. At 1× the amounts are legible on a desktop
 * and mush on a handset, which is where every one of these will be read.
 * Beyond 2× the file grows faster than the legibility does.
 */
const PIXEL_RATIO = 2;

/**
 * The web fonts, base64'd, computed once for the life of the page.
 *
 * `getFontEmbedCSS` walks every stylesheet the document has — including the
 * Google Fonts one, which is cross-origin, so CSSOM refuses to read its rules
 * and it has to be fetched over the network and parsed — then downloads each
 * font file it finds and inlines it. That is several requests and a lot of
 * base64, and the answer is identical every time.
 *
 * Cached as the PROMISE rather than its result, so two receipts rendered at
 * once wait on one piece of work instead of starting it twice.
 *
 * Only one webfont actually shows up on the document — 'Dancing Script', the
 * signature above "Firma Autorizada"; the rest of the receipt is deliberately
 * Helvetica/Arial. It is worth the trouble because the alternative is a
 * signature rendered in whatever cursive face the reader's phone happens to
 * own, on the one part of the page that is meant to look like a person signed
 * it.
 */
let fontCssPromise: Promise<string> | null = null;

function embeddedFontCss(node: HTMLElement): Promise<string> {
  fontCssPromise ??= getFontEmbedCSS(node).catch(() => {
    /*
     * A receipt with a fallback signature beats no receipt.
     *
     * This reaches out to fonts.googleapis.com, so it is the one step here that
     * can fail for reasons that have nothing to do with the document: an office
     * with no internet, a blocked domain, a captive portal. Everything else on
     * the page is local and renders regardless.
     *
     * Not cached as a failure — `??=` has already stored the promise, and it
     * resolves to "" — which is deliberate: retrying the fetch on every receipt
     * would mean a slow timeout on every share for as long as the network is
     * out.
     */
    return "";
  });

  return fontCssPromise;
}

/**
 * Render a receipt to a PNG file, named after the receipt.
 *
 * Takes the offscreen STAGE — `.receipt-share-stage` — rather than the preview
 * in the sidebar. The preview is 320px in a column and its container queries
 * fold it into a narrow strip; the stage is laid out at A4, which is what a
 * receipt is supposed to look like.
 */
export async function receiptToPng(stage: HTMLElement, receiptCode: string): Promise<File> {
  /*
   * The paper INSIDE the stage, not the stage itself. This is not tidiness.
   *
   * The stage is parked offscreen with `position: fixed; left: -10000px`, and
   * the renderer copies the computed styles of whatever it is given onto the
   * clone it puts in the `<foreignObject>` — position and offset included.
   * Handed the stage, it faithfully reproduces a fixed box positioned ten
   * thousand pixels to the left of the picture, and returns a correctly sized,
   * perfectly blank sheet of A4. Handed the paper, whose own position is
   * `static`, it draws the document.
   */
  const node = stage.querySelector<HTMLElement>(".receipt-paper");

  if (node === null) {
    throw new Error("There is no receipt to convert to an image.");
  }

  const blob = await toBlob(node, {
    pixelRatio: PIXEL_RATIO,
    // The paper is white because the document says so, but `toBlob` renders a
    // TRANSPARENT background otherwise — and a transparent PNG on WhatsApp's
    // dark theme is black text on black.
    backgroundColor: "#FFFFFF",
    // Measured from the laid-out node rather than assumed: a receipt with eight
    // lots is taller than one with a single lot.
    width: node.offsetWidth,
    height: node.offsetHeight,
    skipFonts: true,
    fontEmbedCSS: await embeddedFontCss(node),
  });

  if (blob === null) {
    throw new Error("Could not generate the receipt image.");
  }

  // The filename is what the customer sees when they save it, and what somebody
  // in the office sees if it is forwarded back to them.
  return new File([blob], `Receipt ${receiptCode}.png`, { type: "image/png" });
}
