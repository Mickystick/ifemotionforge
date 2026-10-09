import { useState } from "react";

import { useFileDrop } from "../../lib/useFileDrop";
import type { ReceiptAttachment } from "../../types";
import { uploadAttachment } from "./api";
import { MAX_PROOFS, acceptProofFiles, pickProofsFromDrive } from "./ProofDropzone";

interface ProofAttachOptions {
  /**
   * The receipt the slip is filed against, or null where there is none.
   *
   * A comprobante belongs to a receipt, so money recorded before receipts
   * existed cannot take one. Null here disables the whole thing rather than
   * failing at the server.
   */
  receiptId: string | null;
  /**
   * Which lot's payment this is evidence for, on a receipt covering several.
   * Omitted for a slip filed against the paper as a whole.
   */
  paymentId?: string | null;
  /** How many are already on file here, for the count rule. */
  heldCount: number;
  /** Called once per batch, with what actually landed on the server. */
  onStored: (stored: ReceiptAttachment[]) => void;
}

export interface ProofAttach {
  /** Take these files. Safe to call with a null or empty list. */
  addProofs: (incoming: FileList | File[] | null) => Promise<void>;
  /**
   * Choose them from Google Drive instead. MUST run inside a click — the
   * consent popup opens during this call. Offer it only where
   * `googleDriveConfigured()` says there is a Google project to ask.
   */
  pickFromDrive: () => Promise<void>;
  /** "Subiendo foto.jpg…" while one is in flight, else null. */
  busy: string | null;
  /** The first complaint from the last batch, if any. */
  error: string | null;
  clearError: () => void;
  /** A file is over this particular target right now. */
  isDraggingOver: boolean;
  /** Spread onto whatever element should receive the drop. */
  dropHandlers: ReturnType<typeof useFileDrop>["dropHandlers"];
}

/**
 * Attach a comprobante to a receipt that already exists.
 *
 * The gesture this serves is always the same one — the customer's slip arrives
 * hours after the money did, and it goes onto the payment it belongs to — but
 * the app offers it from four places now: the receipt form, the receipt panel,
 * the correction dialog, and the empty square on a transaction row. The rules
 * are the server's and identical in all four: `acceptProofFiles` decides what
 * may go, the files upload one at a time so a failure halfway leaves the rest
 * alone, and the caller re-reads afterwards because the list on screen was
 * fetched before any of this happened.
 *
 * What differs per screen is only what to do once files have landed, which is
 * why that is the one thing passed in.
 *
 * Written as a hook rather than a function because the drop target's highlight
 * and the "Subiendo…" line are part of the same job: a screen that uploads on
 * drop but cannot say it is uploading looks broken for exactly as long as the
 * network takes.
 */
export function useProofAttach({
  receiptId,
  paymentId = null,
  heldCount,
  onStored,
}: ProofAttachOptions): ProofAttach {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const addProofs = async (incoming: FileList | File[] | null) => {
    if (receiptId === null || incoming === null) {
      return;
    }

    const files = Array.from(incoming);

    if (files.length === 0) {
      return;
    }

    setError(null);

    /*
     * Counted against what THIS target holds, which is a floor rather than the
     * server's actual limit: the cap is per receipt, and a receipt covering
     * three lots can already hold files this caller never sees. So the
     * obviously-too-many is refused instantly and the server stays the
     * authority on the rest — its 409 arrives below in the words it wrote.
     */
    const { accepted, rejections } = acceptProofFiles(files, heldCount, MAX_PROOFS);

    if (rejections.length > 0) {
      setError(rejections[0]!);
    }

    const stored: ReceiptAttachment[] = [];

    for (const proof of accepted) {
      setBusy(`Uploading ${proof.file.name}…`);

      try {
        stored.push(await uploadAttachment(receiptId, proof.file, paymentId));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not upload the proof file.");
      }

      // The object URL is held only to validate the file and to name it;
      // nothing here previews it, so it would otherwise leak one image per
      // upload for as long as the tab stays open.
      URL.revokeObjectURL(proof.previewUrl);
    }

    setBusy(null);

    if (stored.length > 0) {
      onStored(stored);
    }
  };

  /*
   * The same act again, with Drive as the drawer. Everything after the
   * download is `addProofs`, so the rules, the one-at-a-time upload and the
   * re-read are the ones a dropped file gets.
   *
   * Drive's own complaints — too big to fetch, a Google Doc — are shown only
   * when the upload had none of its own. `addProofs` clears the error when it
   * starts, so setting Drive's first would have it wiped before anybody read it.
   */
  const pickFromDrive = async () => {
    if (receiptId === null) {
      return;
    }

    setError(null);
    setBusy("Abriendo Google Drive…");

    try {
      const { files, rejections } = await pickProofsFromDrive(setBusy);

      await addProofs(files);

      if (rejections.length > 0) {
        setError((shown) => shown ?? rejections[0]!);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open Google Drive.");
    } finally {
      setBusy(null);
    }
  };

  /*
   * Dropping is the same act as choosing, so it goes through the same
   * function — the type, size and count rules, the sequential upload and the
   * failure that leaves the payment untouched all live in `addProofs`.
   */
  const { isDraggingOver, dropHandlers } = useFileDrop(
    (dropped) => void addProofs(dropped),
    busy !== null,
  );

  return {
    addProofs,
    pickFromDrive,
    busy,
    error,
    clearError: () => setError(null),
    isDraggingOver,
    dropHandlers,
  };
}
