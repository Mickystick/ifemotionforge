import { useEffect, useRef, useState } from "react";

import { DocumentThumb, DocumentViewer } from "../../components/DocumentViewer";
import type { ViewerFile } from "../../components/DocumentViewer";
import { readableSize } from "../../lib/documentFiles";
import { googleDriveConfigured, preloadGoogleDrive } from "../../lib/googleDrive";
import { useFileDrop } from "../../lib/useFileDrop";
import {
  CONTRACT_DOCUMENT_ACCEPT,
  MAX_CONTRACT_DOCUMENTS,
  pickContractFilesFromDrive,
  screenContractFiles,
} from "./contractFiles";

/** A file waiting for the contract it belongs to to exist. */
export interface PendingDocument {
  /** Stable across re-renders, so React keys and the remove button behave. */
  id: string;
  file: File;
  /**
   * An object URL for this file, whatever its type. Revoked on removal.
   *
   * It feeds the thumbnail and the viewer, and the browser's PDF viewer reads a
   * `blob:` URL perfectly well — which is what makes the scan checkable BEFORE
   * the contract is created rather than only after. "Is that the right PDF?" is
   * a question with an expensive wrong answer: the file that settles a dispute
   * over a lot is not one to discover is somebody else's contract.
   */
  previewUrl: string;
}

/**
 * Turn accepted files into held ones, minting the preview URLs.
 *
 * Kept out of `screenContractFiles` so the rules stay pure and testable: this
 * is the half with a side effect, and whoever calls it owes each returned
 * `previewUrl` a `URL.revokeObjectURL`.
 */
export function holdContractFiles(files: File[], keyPrefix = ""): PendingDocument[] {
  return files.map((file, at) => ({
    id: `${keyPrefix}${file.name}-${file.size}-${file.lastModified}-${at}`,
    file,
    previewUrl: URL.createObjectURL(file),
  }));
}

interface ContractDocumentDropzoneProps {
  files: PendingDocument[];
  onFilesChange: (files: PendingDocument[]) => void;
  /** Refused before anything is uploaded — wrong type, too big, too many. */
  onReject: (message: string) => void;
  /**
   * What this zone is waiting on, or null when it is idle.
   *
   * Reported UP rather than kept here, because the consequence of being busy
   * belongs to the form: reading a file out of Google Drive takes seconds, and
   * for those seconds neither Guardar nor the X may be pressed. It used to be
   * private state, and the result was a silent data loss — saving mid-download
   * created the contract from the files held at that instant, unmounted this
   * component, and left Drive's callback writing into a form that no longer
   * existed. The PDF was never uploaded and nothing anywhere said so.
   */
  onBusyChange?: (busy: string | null) => void;
  disabled?: boolean;
}

/**
 * Attach the signed contract while the contract is still being written.
 *
 * The gap this closes is a sequence nobody would choose: until now the ONLY
 * way to file the paperwork was to save the contract, find it in the list, open
 * its panel and add the file there — three screens after the one where the
 * scanned PDF was already sitting open on the desk. The document and the terms
 * are typed from the same piece of paper, in the same minute, so they are asked
 * for in the same place.
 *
 * Nothing is uploaded here. The files are held until the contract is created,
 * because a document needs a contract to belong to and the contract does not
 * exist yet — see `ContractCreateDialog`. That also means abandoning the form
 * uploads nothing, which is what somebody who changed their mind expects.
 */
export function ContractDocumentDropzone({
  files,
  onFilesChange,
  onReject,
  onBusyChange,
  disabled = false,
}: ContractDocumentDropzoneProps) {
  const [viewing, setViewing] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** "Descargando contrato.pdf…" while Google Drive is being read, else null. */
  const [driveBusy, setDriveBusy] = useState<string | null>(null);

  /* Kept in step with the parent, which is what actually holds the doors shut
     while this is running. Announced from an effect rather than from each
     `setDriveBusy` call so the two can never drift apart. */
  useEffect(() => {
    onBusyChange?.(driveBusy);
  }, [driveBusy, onBusyChange]);

  /* Whatever happens, the form is not left locked by a zone that has gone away
     — an unmount in the middle of a download would otherwise strand it. */
  useEffect(() => () => onBusyChange?.(null), [onBusyChange]);

  /*
   * Google's scripts are fetched when this appears rather than when the button
   * is clicked, so the consent popup opens inside the click that asked for it.
   * See `preloadGoogleDrive`.
   */
  useEffect(preloadGoogleDrive, []);

  const accept = (incoming: FileList | File[] | null) => {
    if (incoming === null) {
      return;
    }

    const arriving = Array.from(incoming);

    if (arriving.length === 0) {
      return;
    }

    const { accepted, rejections } = screenContractFiles(arriving, files.length);

    for (const message of rejections) {
      onReject(message);
    }

    if (accepted.length > 0) {
      // The key prefix keeps ids apart when the same file is added twice in one
      // session — name, size and date are identical, and two rows sharing a
      // React key make the second one impossible to remove.
      onFilesChange([...files, ...holdContractFiles(accepted, `${files.length}-`)]);
    }
  };

  const remove = (id: string) => {
    const going = files.find((entry) => entry.id === id);

    // Object URLs are held by the document until revoked. Without this, every
    // scan added and removed stays in memory for the life of the page.
    if (going) {
      URL.revokeObjectURL(going.previewUrl);
    }

    onFilesChange(files.filter((entry) => entry.id !== id));
  };

  /**
   * The same act as choosing a file, with Google Drive as the drawer it comes
   * out of. Everything after the download is the ordinary path: the files go
   * through `accept`, so the type, size and count rules are the ones the
   * server will apply, and a scan from Drive is previewable before saving
   * exactly like a dropped one.
   */
  const pickFromDrive = async () => {
    setDriveBusy("Opening Google Drive…");

    try {
      const { files: picked, rejections } = await pickContractFilesFromDrive(setDriveBusy);

      for (const message of rejections) {
        onReject(message);
      }

      accept(picked);
    } catch (caught) {
      onReject(caught instanceof Error ? caught.message : "Unable to open Google Drive.");
    } finally {
      setDriveBusy(null);
    }
  };

  const { isDraggingOver, dropHandlers } = useFileDrop(accept, disabled);

  const viewerFiles: ViewerFile[] = files.map((entry) => ({
    id: entry.id,
    name: entry.file.name,
    contentType: entry.file.type,
    url: entry.previewUrl,
    caption: null,
    sizeBytes: entry.file.size,
  }));

  const isFull = files.length >= MAX_CONTRACT_DOCUMENTS;

  return (
    <div className="proof-field">
      <div
        className={`proof-dropzone${isDraggingOver ? " is-over" : ""}${
          disabled || isFull ? " is-disabled" : ""
        }`}
        {...dropHandlers}
      >
        <p className="proof-dropzone-title">Drop the signed contract here</p>
        <p className="proof-dropzone-hint">
          A PDF or scan of the signed document. Images are also accepted, up to 30 MB. It's saved
          with the contract as soon as the contract is created.
        </p>

        <div className="proof-dropzone-actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={disabled || isFull}
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
              disabled={disabled || isFull || driveBusy !== null}
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
          accept={CONTRACT_DOCUMENT_ACCEPT}
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
              {/* The thumbnail IS the way to look at it. A PDF has no picture
                  to show, so the badge stands in — and clicking either it or
                  the name opens the document itself. */}
              <button
                type="button"
                className="proof-open"
                onClick={() => setViewing(entry.id)}
                title="View this document"
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

              <button
                type="button"
                className="link-btn is-danger"
                disabled={disabled}
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
