/**
 * What a contract document is allowed to be, and who says so.
 *
 * Extracted from `ContractDocuments` the day a SECOND screen needed the same
 * answers: the signed contract can now be attached while the contract is being
 * written, not only afterwards from the panel. Two copies of these rules would
 * drift, and the screen with the stale copy is the one that offers a file the
 * server then refuses — after the contract has already been created.
 *
 * Mirrors the server's allow-list in backend/src/lib/storedFiles.ts, which is
 * the one that counts. This copy only exists so a wrong file is refused
 * instantly instead of after an upload of a fifteen-page scan.
 */

import { readableSize } from "../../lib/documentFiles";
import { openGoogleDrivePicker } from "../../lib/googleDrive";

const ACCEPTED = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

/**
 * What to put in a file input's `accept`, so the picker offers the same things
 * a drop would be allowed to carry. The `.heic`/`.heif` extensions are appended
 * for the same reason the screening below tolerates an empty type.
 */
export const CONTRACT_DOCUMENT_ACCEPT = `${ACCEPTED.join(",")},.heic,.heif`;

/** 30 MB, the same ceiling the server enforces — see MAX_DOCUMENT_BYTES. */
const MAX_BYTES = 30 * 1024 * 1024;

/** Matches MAX_DOCUMENTS_PER_CONTRACT on the server. */
export const MAX_CONTRACT_DOCUMENTS = 12;

/**
 * Which of these files may be filed, and what to say about the rest.
 *
 * Pure, and it returns its complaints instead of reporting them, so the caller
 * decides whether they become an inline error or a line in a form. It creates
 * nothing either — no object URLs — because one of its two callers uploads
 * immediately and would have nothing to revoke them with.
 */
export function screenContractFiles(
  incoming: File[],
  alreadyHeld: number,
): { accepted: File[]; rejections: string[] } {
  const accepted: File[] = [];
  const rejections: string[] = [];

  for (const file of incoming) {
    if (alreadyHeld + accepted.length >= MAX_CONTRACT_DOCUMENTS) {
      rejections.push(`A contract can have up to ${MAX_CONTRACT_DOCUMENTS} documents.`);
      break;
    }

    // A HEIC straight off an iPhone sometimes arrives with an empty type, so
    // the extension is accepted as a fallback rather than refusing a file the
    // server would have taken.
    const isHeicByName = /\.hei[cf]$/i.test(file.name);

    if (!ACCEPTED.includes(file.type) && !(file.type === "" && isHeicByName)) {
      rejections.push(`“${file.name}” is not a PDF or scanned image.`);
      continue;
    }

    if (file.size === 0) {
      rejections.push(`“${file.name}” is empty.`);
      continue;
    }

    if (file.size > MAX_BYTES) {
      rejections.push(`“${file.name}” is ${readableSize(file.size)}; the maximum is 30 MB.`);
      continue;
    }

    accepted.push(file);
  }

  return { accepted, rejections };
}

/**
 * Open Google Drive's picker for contract documents.
 *
 * Beside `screenContractFiles` for the reason that is here: three screens
 * attach a contract document (creation, the retry panel, and the panel of an
 * existing contract), and each asking Drive with its own idea of the allowed
 * types and the size ceiling is how one of them would start offering a file
 * the server refuses. What comes back still goes through `screenContractFiles`
 * at the caller — this only stops Google offering, or downloading, what that
 * will refuse.
 */
export function pickContractFilesFromDrive(onProgress: (message: string) => void) {
  return openGoogleDrivePicker({ mimeTypes: ACCEPTED, maxBytes: MAX_BYTES, onProgress });
}
