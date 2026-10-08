/*
 * Lindero's service worker.
 *
 * ============================================================================
 * IT CACHES NOTHING. Read this whole comment before adding anything that does.
 * ============================================================================
 *
 * A service worker sits between the app and the network and can answer requests
 * from its own storage. That is how offline support works, and it is also how a
 * web app gets permanently broken: ship a worker that caches a bad build, and
 * every phone that installed it keeps serving that bad build — from its own
 * disk, without asking the server. Deploying the fix does not dislodge it,
 * because the broken worker is the thing deciding whether to ask for the fix.
 * The usual reaction is to deploy again, which changes nothing, on a device you
 * are not holding.
 *
 * This worker exists for exactly two reasons, neither of them offline support:
 *
 *   1. Chrome will not offer "Install app" without a service worker that has a
 *      `fetch` handler. Installation is what the share target in the next phase
 *      depends on — the OS share sheet only lists installed apps.
 *   2. That `fetch` handler is where the shared comprobante will be caught,
 *      once Phase 2 lands. A share arrives as a POST from another app, and
 *      handling it here keeps it on the device, where the session cookie still
 *      applies. See docs/receipt-intake.md.
 *
 * So the handler below is deliberately empty. Not calling `respondWith` means
 * every request goes to the network exactly as it would with no service worker
 * installed at all, which is the entire point: all of the installability, none
 * of the risk.
 *
 * ---------------------------------------------------------------------------
 * THE KILL SWITCH
 *
 * If a worker ever does get stuck on a device, replace the whole body of this
 * file with these two lines and deploy:
 *
 *     self.addEventListener("install", () => self.skipWaiting());
 *     self.addEventListener("activate", () => self.registration.unregister());
 *
 * Every browser picks that up on its next navigation, unregisters itself, and
 * goes back to being an ordinary web page. Knowing this exists is what makes a
 * service worker a safe thing to ship.
 * ---------------------------------------------------------------------------
 */

/*
 * Take over immediately instead of waiting for every tab to close.
 *
 * The default is cautious for a caching worker — two versions serving different
 * assets to different tabs is a real hazard. This one serves no assets, so
 * there is nothing to be inconsistent about, and the caution would only mean a
 * fix sitting unused behind a tab somebody left open last week.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/* ==========================================================================
 * The share target.
 *
 * Sharing a comprobante from WhatsApp arrives here as a POST to /compartir,
 * made by the BROWSER on another app's behalf. Two things about that shape the
 * code below.
 *
 * First, it must not go to the server. A share POST is a cross-app navigation,
 * and a `SameSite=Lax` session cookie is not reliably attached to it — so the
 * upload would arrive unauthenticated and be refused. Handling it here keeps
 * the request on the device entirely; the 303 that follows is an ordinary
 * same-origin GET, which carries the session normally.
 *
 * Second, a redirect cannot carry a file. So the file is parked in IndexedDB
 * under a one-time id and the redirect carries only that id, plus a one-line
 * description of what arrived (see `describeForm`). The page picks it up and
 * deletes it — see src/lib/sharedIntake.ts.
 * ========================================================================== */

const SHARE_PATH = "/compartir";
const DB_NAME = "lindero-share";
const DB_VERSION = 1;
const STORE = "incoming";

/* A share left unclaimed — the redirect never followed, the app force-closed —
 * would otherwise sit in IndexedDB holding a photo forever. Anything older than
 * this is swept on the next share. Generous, because the only cost of keeping
 * one too long is a few megabytes, while sweeping one too early loses a
 * customer's proof of payment. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storePayload(db, payload) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);

    store.put(payload);

    // Sweep stale entries inside the SAME transaction, so a share is never
    // half-written next to a half-deleted one.
    const cursorRequest = store.openCursor();

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;

      if (!cursor) {
        return;
      }

      if (payload.receivedAt - (cursor.value.receivedAt ?? 0) > STALE_AFTER_MS) {
        cursor.delete();
      }

      cursor.continue();
    };

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/*
 * What the browser actually handed over, as one line a person can read off a
 * phone screen: every field, and for each file its type and size.
 *
 * "No image arrived" has several causes that look identical from inside the
 * app — Chrome dropping the file before it ever reaches this worker, Chrome
 * sending it with zero bytes, the file arriving under a field name nobody
 * looked at, or the page failing to read back what was stored here. This line
 * travels with the share (in the redirect as well as in IndexedDB, so it
 * survives even the last of those) and is what tells them apart without a USB
 * cable and a remote debugger.
 *
 * File names are left out: they can carry a customer's name, and the type and
 * size are what the diagnosis needs.
 */
function describeForm(form) {
  const parts = [];

  for (const [field, value] of form.entries()) {
    parts.push(
      value instanceof File
        ? `${field}: ${value.type || "sin tipo"}, ${value.size} B`
        : `${field}: ${String(value).length} caracteres`,
    );
  }

  return parts.length > 0 ? parts.join("; ") : "formulario vacío";
}

async function receiveShare(request) {
  const id =
    self.crypto && typeof self.crypto.randomUUID === "function"
      ? self.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const form = await request.formData();
    const received = describeForm(form);

    /* Every file in the form, not just the "comprobante" field. The manifest
     * names that field and Chrome is supposed to use it, but a file under any
     * other name is still the comprobante somebody meant to share — there is
     * nothing else it could be — and ignoring it would be one more way for a
     * share to arrive empty.
     *
     * Empty entries are filtered because some Android builds include a
     * zero-byte placeholder when the user shares text with no attachment.
     * They still show up in `received`, which is where a zero-byte IMAGE
     * would be noticed. */
    const files = [...form.values()].filter((entry) => entry instanceof File && entry.size > 0);

    /* Text matters as much as the files. Plenty of confirmations arrive as a
     * forwarded message rather than a screenshot — the BAC notification, for
     * one — and the reference number is in that text. It is carried through
     * even though nothing reads it yet, because dropping it here would mean
     * the share had to be repeated later to get it back. */
    const text = String(form.get("text") ?? "");
    const title = String(form.get("title") ?? "");

    const database = await openDatabase();

    await storePayload(database, { id, files, text, title, received, receivedAt: Date.now() });
    database.close();

    return Response.redirect(
      `/?compartido=${encodeURIComponent(id)}&recibido=${encodeURIComponent(received)}`,
      303,
    );
  } catch (error) {
    /* Land in the app regardless, with a flag rather than a payload.
     *
     * The alternative is an error page owned by nobody, reached from inside
     * WhatsApp, on a phone. Better to open Lindero and say the share did not
     * arrive — from there the file is still in the chat, and the dropzone is
     * two taps away. The error rides along so the app can say which step
     * failed instead of only that one did. */
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

    return Response.redirect(`/?compartido=error&recibido=${encodeURIComponent(detail)}`, 303);
  }
}

/*
 * One branch, and everything else falls through to the network.
 *
 * The listener must exist even for requests it ignores — Chrome checks for a
 * registered `fetch` handler when deciding whether the app is installable.
 * Returning without calling `event.respondWith()` hands the request straight to
 * the network, which is the behaviour of a page with no worker at all.
 */
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "POST") {
    return;
  }

  const url = new URL(event.request.url);

  if (url.origin === self.location.origin && url.pathname === SHARE_PATH) {
    event.respondWith(receiveShare(event.request));
  }
});
