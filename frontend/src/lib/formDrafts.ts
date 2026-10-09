import { useEffect, useRef, useState } from "react";

/**
 * Work in progress, kept across a refresh.
 *
 * The failure this exists for: somebody is twelve fields into a contract, the
 * page reloads — a stray Ctrl+R, a phone that slept, a deploy — and every one
 * of those fields is gone. Nothing was wrong, nothing was saved, and the only
 * way forward is to type it all again off the same piece of paper.
 *
 * What is stored is deliberately narrow, and the narrowness is the design:
 *
 *   - Only what was TYPED OR CHOSEN. Text, numbers, dates, ids. Never files —
 *     a `File` cannot survive a reload, and pretending otherwise would restore
 *     a form that looks complete and is missing its scan.
 *   - Only for the account that wrote it. The office machine is shared, and
 *     one person's half-written receipt must never appear under somebody
 *     else's name — see `setDraftOwner`.
 *   - Only for a day. A draft from last Tuesday is not work in progress, it is
 *     a forgotten fragment, and offering to restore one is worse than offering
 *     nothing: the prices, the rate and the lot may all have moved since.
 *
 * It lives in `localStorage`, which means it never leaves this browser and the
 * server never sees it. That is the right trade for a scratch copy of a form:
 * the alternative is a real draft record, which raises the question of who may
 * read whose unfinished work, and answering that badly is worse than a lost
 * afternoon of typing.
 */

const PREFIX = "lindero.draft.";

/** A draft older than this is a leftover, not work in progress. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How long the typing has to stop before a draft is written. */
const QUIET_MS = 800;

/**
 * Who is signed in, for as long as they are.
 *
 * Module state rather than a prop threaded through every form, because the
 * answer is the same for all of them and the forms have no other reason to
 * know it. `App` sets it when the session resolves and clears it on sign-out.
 *
 * Null means no draft is read or written at all. That is the correct
 * behaviour rather than a fallback key: a draft with nobody's name on it is
 * exactly the draft that would be offered to the next person at the counter.
 */
let ownerId: string | null = null;

export function setDraftOwner(id: string | null): void {
  ownerId = id;
}

interface StoredDraft<T> {
  savedAt: string;
  values: T;
}

function keyFor(formKey: string): string | null {
  return ownerId === null ? null : `${PREFIX}${ownerId}.${formKey}`;
}

/**
 * Throw away every draft that has aged out, whoever wrote it.
 *
 * Housekeeping, run once when a form opens. Without it the browser
 * accumulates one dead entry per abandoned form forever — small, but it is
 * somebody's half-typed customer data sitting in a shared machine long after
 * it stopped being useful to anyone.
 */
function pruneExpired(): void {
  try {
    const now = Date.now();
    const doomed: string[] = [];

    for (let at = 0; at < window.localStorage.length; at += 1) {
      const key = window.localStorage.key(at);

      if (key === null || !key.startsWith(PREFIX)) {
        continue;
      }

      const raw = window.localStorage.getItem(key);

      if (raw === null) {
        continue;
      }

      try {
        const parsed = JSON.parse(raw) as StoredDraft<unknown>;

        if (now - new Date(parsed.savedAt).getTime() > MAX_AGE_MS) {
          doomed.push(key);
        }
      } catch {
        // Unreadable: written by an older shape of this code, or corrupted.
        // Either way it can never be restored, so it goes.
        doomed.push(key);
      }
    }

    for (const key of doomed) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Storage is unavailable — a private window, or site data blocked. Drafts
    // are a convenience; the forms work exactly as they always did without one.
  }
}

/** What a form got back, and the three things it can do about it. */
export interface FormDraft<T> {
  /**
   * A draft worth offering, or null.
   *
   * Read ONCE, when the form mounts. It does not change underneath the form as
   * the user types — it is the answer to "was there something here when I
   * arrived", which is asked exactly once.
   */
  found: { values: T; savedAt: string } | null;
  /** The offer was taken; stop showing it and resume saving. */
  dismiss: () => void;
  /** The offer was refused; erase it and start fresh. */
  discard: () => void;
  /** The form was saved for real. Nothing is left to recover. */
  clear: () => void;
}

/**
 * Keep this form's typed values recoverable across a reload.
 *
 * `values` is re-read on every render and written out once the typing pauses,
 * so a caller passes a fresh object literal and does not have to memoise it.
 *
 * Saving is SUSPENDED while a recovered draft is still on offer. Without that,
 * the empty form behind the banner would overwrite the very draft the banner
 * is offering, within a second of it appearing — the user would press
 * "Continuar" and get back nothing.
 */
export function useFormDraft<T>(formKey: string, values: T, enabled: boolean): FormDraft<T> {
  const [found, setFound] = useState<{ values: T; savedAt: string } | null>(() => {
    pruneExpired();

    const key = keyFor(formKey);

    if (key === null) {
      return null;
    }

    try {
      const raw = window.localStorage.getItem(key);

      if (raw === null) {
        return null;
      }

      const parsed = JSON.parse(raw) as StoredDraft<T>;

      if (Date.now() - new Date(parsed.savedAt).getTime() > MAX_AGE_MS) {
        window.localStorage.removeItem(key);
        return null;
      }

      return { values: parsed.values, savedAt: parsed.savedAt };
    } catch {
      return null;
    }
  });

  const remove = () => {
    const key = keyFor(formKey);

    if (key === null) {
      return;
    }

    try {
      window.localStorage.removeItem(key);
    } catch {
      // See `pruneExpired`.
    }
  };

  /*
   * `values` changes identity on every render by design, so the effect below
   * cannot depend on it without re-running constantly. The ref carries the
   * latest one into a timer that depends only on the things that actually
   * decide WHETHER to save.
   */
  const latest = useRef(values);
  latest.current = values;

  /* One tick per keystroke would write the whole form to disk sixty times a
     sentence. A draft only has to be no older than the last pause. */
  const [tick, setTick] = useState(0);
  const isOffering = found !== null;

  useEffect(() => {
    if (!enabled || isOffering) {
      return;
    }

    const timer = window.setTimeout(() => {
      const key = keyFor(formKey);

      if (key === null) {
        return;
      }

      try {
        const draft: StoredDraft<T> = {
          savedAt: new Date().toISOString(),
          values: latest.current,
        };

        window.localStorage.setItem(key, JSON.stringify(draft));
      } catch {
        // Full, blocked, or private. Nothing to tell the user: they did not
        // ask for this and the form is unaffected.
      }
    }, QUIET_MS);

    return () => window.clearTimeout(timer);
    // `tick` is what makes this re-run as the user types; see below.
  }, [formKey, enabled, isOffering, tick]);

  /*
   * What restarts the timer above as the typing continues.
   *
   * The effect that writes the draft cannot depend on `values` — a fresh
   * object literal every render would restart its timer every render, and the
   * draft would never be written at all. So the change is detected here, by
   * value, and turned into a counter the effect CAN depend on.
   *
   * Stringifying the form on each render is cheap next to what it guards: a
   * form is at most a few dozen short fields, and the alternative is writing
   * all of it to disk on every keystroke.
   */
  const previous = useRef<string>("");
  const serialised = enabled && !isOffering ? JSON.stringify(values) : "";

  useEffect(() => {
    if (serialised !== previous.current) {
      previous.current = serialised;
      setTick((count) => count + 1);
    }
  }, [serialised]);

  return {
    found,
    dismiss: () => setFound(null),
    discard: () => {
      remove();
      setFound(null);
    },
    clear: () => {
      remove();
      setFound(null);
    },
  };
}

/** "hace 5 minutos", "hace 3 horas" — how stale the offer is, in the offer. */
export function draftAge(savedAt: string): string {
  const minutes = Math.max(1, Math.round((Date.now() - new Date(savedAt).getTime()) / 60000));

  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }

  const hours = Math.round(minutes / 60);

  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}
