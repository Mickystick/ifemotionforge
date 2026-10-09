import { useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DocumentThumb, DocumentViewer } from "../../components/DocumentViewer";
import type { ViewerFile } from "../../components/DocumentViewer";
import { readableSize } from "../../lib/documentFiles";
import { googleDriveConfigured, preloadGoogleDrive } from "../../lib/googleDrive";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import type { ContractDocument } from "../../types";
import {
  deleteContractDocument,
  fetchContractDocuments,
  storedDocument,
  uploadContractDocument,
} from "./api";
import {
  CONTRACT_DOCUMENT_ACCEPT,
  MAX_CONTRACT_DOCUMENTS,
  pickContractFilesFromDrive,
  screenContractFiles,
} from "./contractFiles";

interface ContractDocumentsProps {
  contractId: string;
  user: User;
  /**
   * Tell the list its count has moved.
   *
   * The Contratos screen marks which contracts have their paperwork on file,
   * and that marker comes from the list's own data — so filing one here has to
   * reach back up, or the row that prompted the upload keeps reading as empty.
   */
  onCountChanged: () => void;
}

/**
 * The signed paperwork for one contract: file it, read it, and nothing else.
 *
 * The gap this closes is that Lindero held everything ABOUT a contract — the
 * price, the term, the cuotas, who is behind — and nothing OF it. The one
 * artefact that settles a dispute lived in a filing cabinet, and in practice in
 * a folder on somebody's phone. Now it is beside the record it belongs to, and
 * reading it is a click rather than a drive to the office.
 *
 * Fetched when the panel opens rather than carried on the contracts list: the
 * list is every contract in the business, each can hold a dozen scans, and a
 * screen that only marks WHICH contracts have paperwork does not need to know
 * what the paperwork is called.
 */
export function ContractDocuments({ contractId, user, onCountChanged }: ContractDocumentsProps) {
  const [documents, setDocuments] = useState<ContractDocument[] | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  /*
   * The document somebody has asked to remove, waiting on a second press.
   *
   * Held here rather than inside the viewer because BOTH ways of removing —
   * the row in the list and the button in the viewer — have to go through the
   * same confirmation. One piece of state, so a route that skips the prompt
   * cannot be added by accident.
   */
  const [pendingRemoval, setPendingRemoval] = useState<ContractDocument | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** "Descargando contrato.pdf…" while Google Drive is being read, else null. */
  const [driveBusy, setDriveBusy] = useState<string | null>(null);

  /*
   * Google's scripts are fetched when this appears rather than when the button
   * is clicked, so the consent popup opens inside the click that asked for it.
   * See `preloadGoogleDrive`.
   */
  useEffect(preloadGoogleDrive, []);

  /*
   * Filing the signed copy is the last step of writing a contract, so it rides
   * on the capability that writes one. DESTROYING it does not: this is the
   * legal instrument for a lot, and unlike a mis-attached photo of a deposit
   * slip there is no second copy of it in a chat somewhere. The server checks
   * both again — hiding a button is convenience, not security.
   */
  const canFile = can(user, "contract:create");
  const canRemove = can(user, "contract:edit");

  useEffect(() => {
    let cancelled = false;

    fetchContractDocuments(contractId)
      .then((found) => {
        if (!cancelled) {
          setDocuments(found);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDocuments([]);
          setError("Could not load the documents.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [contractId]);

  const reload = async () => {
    try {
      setDocuments(await fetchContractDocuments(contractId));
    } catch {
      // The write landed; only the re-read did not. What is on screen is stale
      // rather than wrong, and the next open corrects it.
    }

    onCountChanged();
  };

  const add = async (incoming: FileList | File[] | null) => {
    if (incoming === null || incoming.length === 0) {
      return;
    }

    setError(null);

    /* Screened in one pass before anything is sent, by the same rules the
       Nuevo contrato form applies to a file dropped on it — see
       contractFiles.ts for why they live in one place now. */
    const { accepted, rejections } = screenContractFiles(
      Array.from(incoming),
      documents?.length ?? 0,
    );

    if (rejections[0] !== undefined) {
      setError(rejections[0]);
    }

    let filed = 0;

    for (const file of accepted) {
      setBusy(`Uploading ${file.name}…`);

      try {
        await uploadContractDocument(contractId, file);
        filed += 1;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not upload the document.");
      }
    }

    setBusy(null);

    if (filed > 0) {
      await reload();
    }
  };

  /**
   * The same act as choosing a file, with Google Drive as the drawer it comes
   * out of. Everything after the download goes through `add`, so the type,
   * size and count rules — and the upload itself — are exactly what a chosen
   * file gets.
   */
  const pickFromDrive = async () => {
    setDriveBusy("Opening Google Drive…");

    try {
      const { files: picked, rejections } = await pickContractFilesFromDrive(setDriveBusy);

      for (const message of rejections) {
        setError(message);
      }

      await add(picked);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open Google Drive.");
    } finally {
      setDriveBusy(null);
    }
  };

  /**
   * Actually remove it. Only ever reached from the confirmation dialog.
   *
   * Throws rather than swallowing, so `ConfirmDialog` can keep itself open and
   * show what went wrong — a prompt that closes on a failed delete looks
   * exactly like a prompt that closed on a successful one.
   */
  const remove = async (documentId: string) => {
    setError(null);
    setBusy("Removing document…");

    try {
      await deleteContractDocument(documentId);
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const files: ViewerFile[] = (documents ?? []).map(storedDocument);

  /*
   * The viewer reads this list on every render rather than a copy taken when it
   * opened, so removing a document from inside it makes the neighbour take its
   * place instead of leaving a URL that now 404s. It closes itself once the
   * last one is gone.
   */
  const open = viewing === null ? null : files.find((file) => file.id === viewing) ?? null;

  useEffect(() => {
    if (viewing !== null && open === null) {
      setViewing(null);
    }
  }, [viewing, open]);

  return (
    <section className="cp-section">
      <div className="cp-docs-head">
        <h3 className="cp-section-title">Contract documents</h3>

        {canFile && (documents?.length ?? 0) < MAX_CONTRACT_DOCUMENTS && (
          <span className="cp-docs-actions">
            <button
              type="button"
              className="btn-secondary is-small"
              disabled={busy !== null || driveBusy !== null || documents === null}
              onClick={() => inputRef.current?.click()}
            >
              Add
            </button>

            {/* Left out entirely where no Google credentials were configured —
                see `googleDriveConfigured`. */}
            {googleDriveConfigured() && (
              <button
                type="button"
                className="btn-secondary is-small"
                disabled={busy !== null || driveBusy !== null || documents === null}
                onClick={() => void pickFromDrive()}
              >
                From Google Drive
              </button>
            )}
          </span>
        )}
      </div>

      {driveBusy !== null && <p className="state-message">{driveBusy}</p>}

      {documents === null && <p className="state-message">Loading…</p>}

      {documents !== null && documents.length === 0 && (
        <p className="state-message">
          The signed contract hasn't been uploaded yet
          {canFile ? ". Upload the PDF or scan to keep it handy." : "."}
        </p>
      )}

      {documents !== null && documents.length > 0 && (
        <ul className="cp-docs">
          {documents.map((document, at) => (
            <li key={document.id} className="cp-doc">
              {/* The tile IS the way to read it. A PDF has no picture to show,
                  so the badge stands in — and clicking either it or the name
                  opens the document itself. */}
              <button
                type="button"
                className="proof-open"
                onClick={() => setViewing(document.id)}
                aria-label={`View ${document.fileName}`}
              >
                <DocumentThumb file={files[at]!} />
              </button>

              <span className="cp-doc-meta">
                <button
                  type="button"
                  className="cp-doc-name link-btn"
                  onClick={() => setViewing(document.id)}
                >
                  {document.fileName}
                </button>
                <span className="cp-doc-sub">
                  {readableSize(document.byteSize)} · {document.uploadedBy}
                </span>
              </span>

              {canRemove && (
                <button
                  type="button"
                  className="link-btn is-danger"
                  disabled={busy !== null}
                  onClick={() => setPendingRemoval(document)}
                  aria-label={`Remove ${document.fileName}`}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {busy && <p className="state-message">{busy}</p>}
      {error && <p className="form-error">{error}</p>}

      {/* Off-screen, opened by the Agregar button. The server's allow-list is
          the one that counts; this only spares somebody the upload. */}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="proof-input"
        accept={CONTRACT_DOCUMENT_ACCEPT}
        onChange={(event) => {
          void add(event.target.files);
          // Cleared so choosing the SAME file twice in a row still fires a
          // change event — otherwise re-adding one you just removed does
          // nothing at all.
          event.target.value = "";
        }}
      />

      {open !== null && (
        <DocumentViewer
          files={files}
          startId={open.id}
          onClose={() => setViewing(null)}
          onRemove={
            canRemove
              ? (file) =>
                  setPendingRemoval(
                    (documents ?? []).find((entry) => entry.id === file.id) ?? null,
                  )
              : undefined
          }
        />
      )}

      {pendingRemoval !== null && (
        /*
         * The one prompt both routes pass through.
         *
         * Worth the extra press because of what this file IS. A comprobante is
         * a customer's copy of something the bank also has; this is the signed
         * instrument for a lot, and once the scan is gone the only copy left is
         * whatever is in a filing cabinet. The audit line naming it survives,
         * and that is the whole of what survives.
         */
        <ConfirmDialog
          eyebrow="Remove document"
          title={pendingRemoval.fileName}
          description={`${readableSize(pendingRemoval.byteSize)} · uploaded by ${pendingRemoval.uploadedBy}`}
          confirmLabel="Remove document"
          busyLabel="Removing…"
          onCancel={() => setPendingRemoval(null)}
          onConfirm={async () => {
            await remove(pendingRemoval.id);
            setPendingRemoval(null);
          }}
        >
          This permanently deletes the file from the server and can't be undone. If this is the
          signed contract, make sure you have another copy before continuing. The history will
          only show that you removed it.
        </ConfirmDialog>
      )}
    </section>
  );
}
