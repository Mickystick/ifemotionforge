/**
 * Sending a receipt to the customer over WhatsApp.
 *
 * Read this before changing anything here, because the shape of it is forced by
 * two limits that are not ours to move:
 *
 *  - A `wa.me` link CANNOT carry a file. Click-to-chat takes `?text=` and
 *    nothing else. So "open Ana's chat with the receipt already attached" is
 *    impossible from a link, on every device, forever.
 *  - `navigator.share` CAN carry a file, but cannot choose the recipient — the
 *    operating system's share sheet owns that — and it does not exist at all on
 *    desktop Linux or in Firefox.
 *
 * One of those two gives you the file, the other gives you the person, and no
 * browser gives you both. The only thing that does is the WhatsApp Cloud API,
 * where the SERVER sends the message and the device stops mattering; that needs
 * a dedicated phone number and an approved template, and is not built yet.
 *
 * So this tries three things in order, and NONE of them writes a file to disk:
 *
 *  1. Clipboard + open THE CUSTOMER'S chat. Preferred everywhere it works,
 *     phones included, and the reason is not convenience: `wa.me` takes the
 *     number from the customer's record, so the chat that opens is provably
 *     the right one. The share sheet cannot do that — it hands you a contact
 *     picker, and picking the wrong name sends one customer's balance and
 *     identidad to another. That is a privacy incident, not a typo.
 *  2. Share sheet, where the clipboard is unavailable but sharing is not. The
 *     image travels properly; the recipient is chosen by hand.
 *  3. Show the receipt in Lindero's own viewer — a browser with neither, which
 *     in practice means the app served over plain HTTP. Long-press or
 *     right-click the image to copy it into the chat.
 *
 * There is deliberately no "download it" step. Saving a 350 KB PNG per receipt
 * into somebody's Downloads folder, to be attached by hand and then swept up
 * later, is worse than any of the above — it is the manual screenshot workflow
 * with extra housekeeping.
 *
 * The third route used to be `window.open` on a `blob:` URL, which is nearly
 * the same thing and worse in two ways: several browsers SAVE an image opened
 * that way instead of showing it, and a popup blocker can eat the tab silently.
 * The image now stays inside the app, in the same viewer the comprobantes use.
 */

import type { Receipt } from "../../types";

/**
 * What the customer reads under the receipt.
 *
 * Deliberately a courtesy note and not a summary. It used to restate the code,
 * the amount and the new balance — which is every figure that is already on the
 * image, in a worse format, and it made the chat look like a machine had
 * written it. The picture is the document; this is the message a person would
 * type alongside it.
 */
export const THANK_YOU_MESSAGE =
  "Thank you for your recent payment. Please let me know if you have any questions.";

/**
 * The message to send with this particular receipt.
 *
 * A voided receipt does not get the thank-you. The image carries its own
 * ANULADO banner, but a caption reading "gracias por su abono" under a
 * cancelled payment contradicts the document it is attached to — and this
 * message can be forwarded on its own, without the image. Of everything on this
 * screen, that is the one that costs real money to get wrong.
 */
export function receiptCaption(receipt: Receipt): string {
  if (receipt.voidedAt !== null) {
    return `*VOIDED RECEIPT* — ${receipt.voidReason ?? "no reason recorded"}`;
  }

  return THANK_YOU_MESSAGE;
}

/** Where a receipt got to, so the screen can tell the user what to do next. */
export type ShareOutcome =
  /** Handed to the share sheet. Whether they then sent it is not ours to know. */
  | { status: "shared" }
  /** On the clipboard, and the chat is open. One paste away. */
  | { status: "copied"; chatUrl: string }
  /**
   * Neither route was available. The caller shows the receipt in the viewer to
   * be copied by hand, and offers `chatUrl` as a link.
   */
  | { status: "manual"; chatUrl: string; reason: "insecure" | "unsupported" }
  /** They backed out of the share sheet. A decision, not a failure. */
  | { status: "cancelled" };

/**
 * Whether the page is allowed to use the two APIs this feature is built on.
 *
 * BOTH the Web Share API and the Clipboard API are secure-context only. Not
 * "work better on HTTPS" — on a plain `http://` page `navigator.share` and
 * `navigator.clipboard` do not exist at all, and there is no error to catch,
 * only an absence.
 *
 * This is the single most confusing thing about this screen, and it deserves
 * its own name rather than an inline check. Lindero is opened on a phone as
 * `http://192.168.1.37:5173`, so an Android phone — which supports the share
 * sheet perfectly well — silently drops to the last-resort tab and looks
 * broken. The page is not broken; it is on HTTP. `localhost` counts as secure,
 * which is why the same browser on the same machine behaves differently
 * depending only on the address bar.
 */
function hasSecureApis(): boolean {
  return window.isSecureContext;
}

/** True on a phone or tablet, where "right-click" is not a thing anybody can do. */
function isTouchDevice(): boolean {
  return window.matchMedia("(pointer: coarse)").matches;
}

/** "⌘V" on Apple hardware, "Ctrl+V" everywhere else. */
export function pasteShortcut(): string {
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? "⌘V" : "Ctrl+V";
}

/**
 * How to paste the receipt into the chat that just opened.
 *
 * A phone has no Ctrl+V, and telling somebody to press it is the kind of small
 * wrongness that makes people distrust the rest of the instructions.
 */
export function pasteInstruction(): string {
  return isTouchDevice()
    ? "Press and hold the chat field, paste the image, and send."
    : `Paste it into the chat with ${pasteShortcut()} and send.`;
}

/** How to get the image off the screen by hand, in the words of this device. */
export function copyGesture(): string {
  return isTouchDevice()
    ? "press and hold the image to share it"
    : "right-click → Copy image, then paste it into the chat";
}

/**
 * The customer's chat, with the message already typed.
 *
 * `wa.me` wants bare digits with the country code and no plus, which is what
 * the stored E.164 form becomes once punctuation is dropped — see lib/phone.ts
 * for why it is stored that way. Deliberately `wa.me` rather than
 * `web.whatsapp.com`: it is the one URL that routes itself to the phone app,
 * the desktop app or the web client depending on where it is opened.
 */
function chatUrl(phone: string, caption: string): string {
  return `https://wa.me/${phone.replace(/\D/g, "")}?text=${encodeURIComponent(caption)}`;
}

/** Can this browser put a file into the OS share sheet? */
function canShareFile(file: File): boolean {
  return typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
}

/**
 * Put the image on the clipboard. `false` if this browser will not.
 *
 * The secure-context check is the one that actually bites here. `navigator.
 * clipboard` is undefined on plain HTTP, and Lindero is opened over the office
 * network as `http://<ip>:5173` — so this returns false there and the caller
 * falls through to the tab. It works on `localhost` (which counts as secure) and
 * over any HTTPS hostname, including the Tailscale and Cloudflare names
 * vite.config.ts already allows.
 */
async function copyToClipboard(file: File): Promise<boolean> {
  if (
    !hasSecureApis() ||
    typeof ClipboardItem === "undefined" ||
    typeof navigator.clipboard?.write !== "function"
  ) {
    return false;
  }

  try {
    // A File is a Blob. PNG is the one image type every clipboard
    // implementation agrees to take, which is why receiptImage.ts renders one.
    await navigator.clipboard.write([new ClipboardItem({ [file.type]: file })]);

    return true;
  } catch {
    // Permission refused, or an image type this browser will not hold.
    return false;
  }
}

/**
 * Send the receipt.
 *
 * MUST be called from a click handler with the file already in hand. Both
 * `navigator.share` and `window.open` need the browser to still believe it is
 * inside a user gesture, and rendering the PNG takes long enough to lose that
 * on Safari — which is why `ReceiptsPage` prepares the image when the receipt
 * is opened rather than when the button is pressed.
 */
export async function sendReceiptOnWhatsApp(
  file: File,
  caption: string,
  phone: string,
): Promise<ShareOutcome> {
  const url = chatUrl(phone, caption);

  /*
   * The clipboard route goes FIRST, on every device.
   *
   * It used to come second, behind the share sheet, which meant a phone always
   * got the contact picker. That works, but it puts choosing the recipient back
   * in human hands for a document that names a customer, states their identidad
   * and states what they owe. The number is already on file and already
   * verified; using it removes the only step in this flow that can go wrong
   * silently.
   */
  if (await copyToClipboard(file)) {
    window.open(url, "_blank", "noopener,noreferrer");

    return { status: "copied", chatUrl: url };
  }

  // No clipboard, but the OS can still take a file. The recipient is picked by
  // hand here — worse, but far better than nothing.
  if (canShareFile(file)) {
    try {
      await navigator.share({ files: [file], text: caption });

      return { status: "shared" };
    } catch (caught) {
      // Backing out of the share sheet arrives as an exception. It is a
      // decision, and must not be reported as a failure or retried another way.
      if (caught instanceof DOMException && caught.name === "AbortError") {
        return { status: "cancelled" };
      }

      // Anything else — a sheet that refused, a gesture that expired — falls
      // through to the tab rather than dead-ending.
    }
  }

  /*
   * Nothing opened, and nothing was written anywhere.
   *
   * The caller shows the receipt in Lindero's viewer and offers the chat as a
   * link. Deliberately no `window.open` on this path: a popup blocker would eat
   * it silently, and the branches above have already spent the one navigation a
   * click is allowed.
   */

  /*
   * WHY we ended up here matters more than the fact that we did.
   *
   * "insecure" means this device can almost certainly do better — an Android
   * phone reaching Lindero over HTTPS gets the share sheet, which is the best
   * version of this feature. Landing in a tab there is an address-bar problem
   * wearing the costume of a missing feature, and saying so is the difference
   * between a fix and a shrug.
   */
  return {
    status: "manual",
    chatUrl: url,
    reason: hasSecureApis() ? "unsupported" : "insecure",
  };
}
