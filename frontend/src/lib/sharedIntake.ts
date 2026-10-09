/**
 * Collecting a comprobante shared into Lindero from another app.
 *
 * The other half of this lives in public/sw.js, and the split is forced by a
 * limitation rather than chosen: a share arrives as a POST that the service
 * worker must answer on the device (a `SameSite=Lax` session cookie is not
 * reliably attached to a cross-app POST, so sending it to the server would
 * arrive unauthenticated), and the redirect that follows cannot carry a file.
 * So the worker parks the payload in IndexedDB under a one-time id, redirects
 * with only that id in the query string, and this module picks it up.
 *
 * Reading is destructive on purpose. See `takeSharedPayload`.
 */

const DB_NAME = "lindero-share";
const DB_VERSION = 1;
const STORE = "incoming";

/** The query parameter the service worker's redirect carries. */
export const SHARE_PARAM = "compartido";

/** The worker's own signal that it could not read what was shared. */
export const SHARE_FAILED = "error";

/** The worker's one-line description of what the browser handed it. */
export const RECEIVED_PARAM = "recibido";

export interface SharedPayload {
  /** Images or PDFs. Possibly empty — text-only shares are legitimate. */
  files: File[];
  /**
   * The shared message text.
   *
   * Often where the figures actually are: plenty of confirmations arrive as a
   * forwarded bank notification rather than a screenshot. Nothing reads it yet;
   * it is carried so that when something does, the share does not have to be
   * repeated to get it back.
   */
  text: string;
  title: string;
}

/**
 * A share the URL says is waiting.
 *
 * `received` is the worker's own account of what the browser handed it — see
 * `describeForm` in public/sw.js. It is read from the URL rather than from the
 * stored record so that it survives the one failure the record cannot report
 * on: the record itself not being there.
 */
export type ShareRequest =
  | { kind: "payload"; id: string; received: string | null }
  | { kind: "failed"; received: string | null };

/**
 * What the URL is asking us to do, if anything.
 *
 * Returns `null` for an ordinary page load — which is almost every load, so
 * this stays cheap and never touches IndexedDB to find that out.
 */
export function readShareRequest(search: string): ShareRequest | null {
  const params = new URLSearchParams(search);
  const value = params.get(SHARE_PARAM);

  if (!value) {
    return null;
  }

  const received = params.get(RECEIVED_PARAM) || null;

  return value === SHARE_FAILED
    ? { kind: "failed", received }
    : { kind: "payload", id: value, received };
}

/**
 * How reading the parked share back out went.
 *
 * Three outcomes that used to collapse into one `null`, and the collapse is
 * why a failed share could only ever say "no image": a record that holds no
 * file (the browser never delivered one), a record that is not there at all,
 * and a record the browser refused to read are three different faults with
 * three different fixes.
 */
export type TakenShare =
  | { status: "found"; payload: SharedPayload }
  | { status: "missing" }
  | { status: "unreadable"; detail: string };

/**
 * The notice for a share that opened the form without a comprobante.
 *
 * Each case names where the file went missing, and every one ends with what
 * the worker saw arrive. That last part reads as noise to most people and is
 * exactly what is needed the one time somebody has to work out why sharing
 * stopped working on a particular phone.
 */
export function describeUndeliveredShare(
  outcome: TakenShare | { status: "failed" },
  received: string | null,
): string {
  const headline =
    outcome.status === "failed"
      ? "Could not read the item you shared."
      : outcome.status === "missing"
        ? "The shared item arrived, but it was no longer saved when Lindero opened."
        : outcome.status === "unreadable"
          ? "The shared item arrived, but this phone could not read it."
          : "The shared item reached Lindero without an image.";

  const details = [
    received ? `received: ${received}` : null,
    outcome.status === "unreadable" ? `error: ${outcome.detail}` : null,
  ].filter((part): part is string => part !== null);

  return (
    `${headline} Attach the proof file below.` +
    (details.length > 0 ? ` (Details: ${details.join(" — ")})` : "")
  );
}

/**
 * Take the URL's share marker out of the address bar.
 *
 * Without this, reloading the page — or restoring the tab tomorrow — asks for
 * the same share again. The second attempt finds nothing (the record is
 * deleted on the first) and the form would open empty for no visible reason.
 * `replaceState` rather than `pushState` so the Back button is not left
 * pointing at a URL that no longer means anything.
 */
export function clearShareFromUrl(): void {
  try {
    window.history.replaceState({}, "", window.location.pathname);
  } catch {
    // Some embedded browsers refuse replaceState. A stale query parameter is
    // harmless next to a thrown error during startup.
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    // The worker normally creates the store first, but the page can win the
    // race on a cold start, so both sides have to be able to create it.
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Read the shared payload and delete it, in one transaction.
 *
 * DESTRUCTIVE, and that is the point. This runs on a page load whose URL says
 * a share is waiting; if the read left the record behind, the same photo would
 * be offered again on the next load, and a second receipt for a payment that
 * was already recorded is a genuinely expensive mistake. Read-and-delete
 * together means the payload is handed over exactly once.
 *
 * Never throws — no record, private browsing with IndexedDB disabled, a quota
 * error all come back as an outcome. The caller's fallback is to open the form
 * empty, which is the app working normally, so none of these are worth
 * interrupting anybody over; but they are worth telling apart. See
 * `TakenShare`.
 */
export async function takeSharedPayload(id: string): Promise<TakenShare> {
  if (typeof indexedDB === "undefined") {
    return { status: "unreadable", detail: "IndexedDB unavailable" };
  }

  let database: IDBDatabase | null = null;

  try {
    database = await openDatabase();
    const db = database;

    const payload = await new Promise<SharedPayload | null>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const request = store.get(id);
      let found: SharedPayload | null = null;

      request.onsuccess = () => {
        const record = request.result as
          | { files?: unknown; text?: unknown; title?: unknown }
          | undefined;

        if (!record) {
          return;
        }

        found = {
          /* A Blob is taken too, and given a name. The worker stores Files and
             IndexedDB is supposed to hand Files back, but a comprobante that
             came back as a bare Blob is still the comprobante — dropping it on
             a type check is how a share arrives "without an image" that was
             sitting right there. */
          files: Array.isArray(record.files)
            ? record.files
                .filter((entry): entry is Blob => entry instanceof Blob && entry.size > 0)
                .map((entry) =>
                  entry instanceof File
                    ? entry
                    : new File([entry], "comprobante", { type: entry.type }),
                )
            : [],
          text: typeof record.text === "string" ? record.text : "",
          title: typeof record.title === "string" ? record.title : "",
        };

        // Inside the same transaction as the read, so there is no window in
        // which the payload has been handed over but still exists on disk.
        store.delete(id);
      };

      transaction.oncomplete = () => resolve(found);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    return payload ? { status: "found", payload } : { status: "missing" };
  } catch (error) {
    return {
      status: "unreadable",
      // An aborted transaction can reject with `transaction.error` still null.
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "no details"),
    };
  } finally {
    database?.close();
  }
}
