import { useEffect, useRef, useState } from "react";

import { DocumentViewer, DocumentThumb } from "../../components/DocumentViewer";
import type { ViewerFile } from "../../components/DocumentViewer";
import { readableSize } from "../../lib/documentFiles";
import {
  googleDriveConfigured,
  openGoogleDrivePicker,
  preloadGoogleDrive,
} from "../../lib/googleDrive";
import { useFileDrop } from "../../lib/useFileDrop";

/**
 * What a proof of payment is allowed to be. Mirrors the server's allow-list in
 * backend/src/lib/attachments.ts, which is the one that counts — this copy only
 * exists so a wrong file is refused instantly instead of after an upload.
 */
const ACCEPTED = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
];

/** 12 MB, the same ceiling the server enforces. */
const MAX_BYTES = 12 * 1024 * 1024;

/**
 * What to put in a file input's `accept`, so the picker offers the same things
 * a drop would be allowed to carry.
 *
 * Exported because the correction dialog opens its own picker: written out
 * again there, the two lists drifted the first time this one changed, and the
 * screen with the stale copy is the one that offers a file the server refuses.
 * The `.heic`/`.heif` extensions are appended for the same reason `ACCEPTED`
 * tolerates an empty type below.
 */
export const PROOF_ACCEPT = `${ACCEPTED.join(",")},.heic,.heif`;

/**
 * How many comprobantes one receipt holds. Matches MAX_ATTACHMENTS_PER_RECEIPT
 * in backend/src/lib/storedFiles.ts, which is the number that counts.
 *
 * Exported from here rather than declared per screen. It was written out in
 * `NewReceiptDialog` and again in `ReceiptsPage`, and a third screen that can
 * attach a proof — the edit dialog — is a third chance for the copies to drift
 * apart from the server and from each other.
 */
export const MAX_PROOFS = 8;

export interface PendingProof {
  /** Stable across re-renders, so React keys and the remove button behave. */
  id: string;
  file: File;
  /**
   * An object URL for this file, whatever its type. Revoked on removal.
   *
   * It used to be null for a PDF, because the only thing it fed was a
   * thumbnail and a PDF has no thumbnail. It now also feeds the VIEWER, and the
   * browser's PDF viewer reads a `blob:` URL perfectly well — which is what
   * makes a bank's PDF checkable before it is uploaded rather than only after.
   */
  previewUrl: string;
  /**
   * The lot this slip is evidence for, or null for the receipt as a whole.
   *
   * A contract id rather than a payment id, because at this point the payments
   * do not exist yet — the receipt has not been written. `NewReceiptDialog`
   * translates it once the server answers with the lines it created.
   */
  contractId: string | null;
}

/** One lot a pending proof may be filed against. */
export interface ProofLot {
  contractId: string;
  lotCode: string;
}

interface ProofDropzoneProps {
  files: PendingProof[];
  onFilesChange: (files: PendingProof[]) => void;
  /** Refused before anything is uploaded — wrong type, too big, too many. */
  onReject: (message: string) => void;
  maxFiles: number;
  /**
   * The lots this receipt covers. A picker appears per file only when there is
   * more than one — with a single lot there is nothing to choose, and a select
   * with one option in it is furniture.
   */
  lots?: ProofLot[];
  /**
   * What this zone is waiting on, or null when it is idle.
   *
   * Reported UP for the same reason `ContractDocumentDropzone` does it: reading
   * a file out of Google Drive takes seconds, and the form around this has to
   * refuse to close across them. Kept private, the failure is silent — the
   * receipt saves without the comprobante and nothing says a file was lost.
   */
  onBusyChange?: (busy: string | null) => void;
  disabled?: boolean;
}

/**
 * Which of these files may be attached, and what to say about the rest.
 *
 * Extracted from the dropzone rather than left inside it because a comprobante
 * no longer arrives only by drag or file picker: one shared from WhatsApp goes
 * straight into the form without this component ever rendering (see
 * lib/sharedIntake.ts). Both paths have to refuse the same files for the same
 * reasons, and two copies of these rules would drift — the shared path would
 * quietly start accepting a 40 MB video that the server then rejects, AFTER
 * the payment has already been recorded.
 *
 * Pure, and returns its complaints instead of reporting them, so the caller
 * decides whether they become a toast, an inline error, or nothing at all.
 */
export function acceptProofFiles(
  incoming: File[],
  alreadyHeld: number,
  maxFiles: number,
): { accepted: PendingProof[]; rejections: string[] } {
  const accepted: PendingProof[] = [];
  const rejections: string[] = [];

  for (const file of incoming) {
    if (alreadyHeld + accepted.length >= maxFiles) {
      rejections.push(`You can attach up to ${maxFiles} proof files per receipt.`);
      break;
    }

    // A HEIC straight off an iPhone sometimes arrives with an empty type, so
    // the extension is accepted as a fallback rather than refusing a file the
    // server would have taken.
    const isHeicByName = /\.hei[cf]$/i.test(file.name);

    if (!ACCEPTED.includes(file.type) && !(file.type === "" && isHeicByName)) {
      rejections.push(`“${file.name}” is not an image or PDF.`);
      continue;
    }

    if (file.size === 0) {
      rejections.push(`“${file.name}” is empty.`);
      continue;
    }

    if (file.size > MAX_BYTES) {
      rejections.push(`“${file.name}” is ${readableSize(file.size)}; the maximum is 12 MB.`);
      continue;
    }

    accepted.push({
      id: `${file.name}-${file.size}-${file.lastModified}-${accepted.length}`,
      file,
      previewUrl: URL.createObjectURL(file),
      contractId: null,
    });
  }

  return { accepted, rejections };
}

/**
 * Open Google Drive's picker for comprobantes.
 *
 * Beside `acceptProofFiles` for the reason that is here: four screens attach a
 * comprobante, and each asking Drive with its own idea of the allowed types
 * and the size ceiling is how one of them would start offering a file the
 * server refuses. What comes back still goes through `acceptProofFiles` at the
 * caller — this only stops Google offering, or downloading, what that will
 * refuse.
 */
export function pickProofsFromDrive(onProgress: (message: string) => void) {
  return openGoogleDrivePicker({ mimeTypes: ACCEPTED, maxBytes: MAX_BYTES, onProgress });
}

/**
 * Drag a screenshot in, or pick one.
 *
 * Built for exactly one gesture: the customer sends the deposit slip on
 * WhatsApp, and it goes straight from that window onto the receipt. Dropping an
 * image dragged out of another browser tab or a chat client is the fast path;
 * the file picker is there for the times the image was downloaded first.
 *
 * Nothing is uploaded here. The files are held until the receipt is saved,
 * because an attachment needs a receipt to belong to and the receipt does not
 * exist yet — see `NewReceiptDialog`. That also means abandoning the form
 * uploads nothing, which is the behaviour somebody who changed their mind
 * expects.
 */
export function ProofDropzone({
  files,
  onFilesChange,
  onReject,
  maxFiles,
  lots = [],
  onBusyChange,
  disabled = false,
}: ProofDropzoneProps) {
  /*
   * Which file is open in the viewer, if any.
   *
   * The reason this exists at all: a comprobante arrives as a screenshot among
   * a dozen others in a chat, and "did I attach the right one?" is a question
   * with a wrong answer that only surfaces months later, when the payment is
   * disputed and the slip on file turns out to be somebody else's. Checking it
   * has to be possible BEFORE the receipt is written, not only after — which
   * used to mean uploading it, then downloading it again to look.
   */
  const [viewing, setViewing] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** "Descargando comprobante.jpg…" while Google Drive is being read, else null. */
  const [driveBusy, setDriveBusy] = useState<string | null>(null);

  /* Announced from an effect rather than from each `setDriveBusy` call, so the
     parent's copy can never drift out of step with this one. The unmount clear
     stops a form being left locked by a zone that has gone away mid-download. */
  useEffect(() => {
    onBusyChange?.(driveBusy);
  }, [driveBusy, onBusyChange]);

  useEffect(() => () => onBusyChange?.(null), [onBusyChange]);

  /*
   * Google's scripts are fetched when this appears rather than when the button
   * is clicked, so the consent popup opens inside the click that asked for it.
   * See `preloadGoogleDrive`.
   */
  useEffect(preloadGoogleDrive, []);

  const alreadyHeld = files.length;

  const accept = (incoming: FileList | File[] | null) => {
    if (!incoming || incoming.length === 0) {
      return;
    }

    const { accepted, rejections } = acceptProofFiles(Array.from(incoming), alreadyHeld, maxFiles);

    for (const message of rejections) {
      onReject(message);
    }

    if (accepted.length > 0) {
      onFilesChange([...files, ...accepted]);
    }
  };

  const remove = (id: string) => {
    const going = files.find((entry) => entry.id === id);

    // Object URLs are held by the document until revoked. Without this, every
    // image the user adds and removes stays in memory for the life of the page.
    if (going?.previewUrl) {
      URL.revokeObjectURL(going.previewUrl);
    }

    onFilesChange(files.filter((entry) => entry.id !== id));
  };

  /**
   * The same act as choosing a file, with Google Drive as the drawer it comes
   * out of. Everything after the download is the ordinary path: the files go
   * through `accept`, so the type, size and count rules are the ones the server
   * will apply, and a slip from Drive is previewable before saving exactly like
   * a dropped one.
   */
  const pickFromDrive = async () => {
    setDriveBusy("Abriendo Google Drive…");

    try {
      const { files: picked, rejections } = await pickProofsFromDrive(setDriveBusy);

      for (const message of rejections) {
        onReject(message);
      }

      accept(picked);
    } catch (caught) {
      onReject(caught instanceof Error ? caught.message : "Could not open Google Drive.");
    } finally {
      setDriveBusy(null);
    }
  };

  const assignLot = (id: string, contractId: string | null) =>
    onFilesChange(
      files.map((entry) => (entry.id === id ? { ...entry, contractId } : entry)),
    );

  const { isDraggingOver, dropHandlers } = useFileDrop(accept, disabled);

  /** The pending files, as the viewer understands them. */
  const viewerFiles: ViewerFile[] = files.map((entry) => ({
    id: entry.id,
    name: entry.file.name,
    contentType: entry.file.type,
    url: entry.previewUrl,
    caption: lots.find((lot) => lot.contractId === entry.contractId)?.lotCode ?? null,
    sizeBytes: entry.file.size,
  }));

  return (
    <div className="proof-field">
      <div
        className={`proof-dropzone${isDraggingOver ? " is-over" : ""}${
          disabled ? " is-disabled" : ""
        }`}
        {...dropHandlers}
      >
        <p className="proof-dropzone-title">Drop the proof file here</p>
        <p className="proof-dropzone-hint">
          Drop a deposit or transfer screenshot directly from WhatsApp. JPG, PNG, HEIC, or PDF, up
          to 12 MB.
        </p>

        <div className="proof-dropzone-actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={disabled || driveBusy !== null}
            onClick={() => inputRef.current?.click()}
          >
            Choose file
          </button>

          {/* Left out entirely where no Google credentials were configured —
              see `googleDriveConfigured`. */}
          {googleDriveConfigured() && (
            <button
              type="button"
              className="btn-secondary"
              disabled={disabled || driveBusy !== null}
              onClick={() => void pickFromDrive()}
            >
              From Google Drive
            </button>
          )}
        </div>

        {driveBusy !== null && <p className="proof-dropzone-hint">{driveBusy}</p>}

        <input
          ref={inputRef}
          type="file"
          multiple
          className="proof-input"
          accept={PROOF_ACCEPT}
          onChange={(event) => {
            accept(event.target.files);
            // Cleared so choosing the SAME file twice in a row still fires a
            // change event — otherwise re-adding a file you just removed does
            // nothing at all.
            event.target.value = "";
          }}
        />
      </div>

      {files.length > 0 && (
        <ul className="proof-list">
          {files.map((entry, at) => (
            <li key={entry.id} className="proof-item">
              {/* The thumbnail IS the way to look at it. A picture too small to
                  read is an invitation to click, and clicking one used to do
                  nothing at all — so the check that mattered never happened. */}
              <button
                type="button"
                className="proof-open"
                onClick={() => setViewing(entry.id)}
                title="View this proof file"
                aria-label={`View ${entry.file.name}`}
              >
                <DocumentThumb file={viewerFiles[at]!} />
              </button>

              <span className="proof-meta">
                <button
                  type="button"
                  className="proof-name link-btn"
                  onClick={() => setViewing(entry.id)}
                >
                  {entry.file.name}
                </button>
                <span className="proof-size">{readableSize(entry.file.size)}</span>
              </span>

              {/* Only where there is a choice to make. One lot, no picker. */}
              {lots.length > 1 && (
                <select
                  className="proof-lot"
                  value={entry.contractId ?? ""}
                  aria-label={`Lot for ${entry.file.name}`}
                  onChange={(event) => assignLot(entry.id, event.target.value || null)}
                >
                  <option value="">Entire receipt</option>
                  {lots.map((lot) => (
                    <option key={lot.contractId} value={lot.contractId}>
                      {lot.lotCode}
                    </option>
                  ))}
                </select>
              )}

              <button
                type="button"
                className="link-btn is-danger"
                onClick={() => remove(entry.id)}
                aria-label={`Remove ${entry.file.name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {viewing !== null && (
        <DocumentViewer
          files={viewerFiles}
          startId={viewing}
          onClose={() => setViewing(null)}
          onRemove={(file) => remove(file.id)}
        />
      )}
    </div>
  );
}
