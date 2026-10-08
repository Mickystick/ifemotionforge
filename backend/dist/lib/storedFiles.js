/**
 * Every file this app accepts from outside, and how it is kept safe.
 *
 * An uploaded file is the one thing in this app that arrives from outside and
 * is written to the filesystem, so everything here is about not trusting it:
 * not its name, not the content type the browser claims, and not its size.
 *
 * Two kinds of file live under these rules, and they are deliberately not the
 * same table:
 *
 *   - the COMPROBANTE a customer sends for a payment (`attachments`), and
 *   - the signed legal CONTRACT for a lot (`contract_documents`).
 *
 * What they share is exactly this module: what a file may be, what it is called
 * on disk, and how it is served back. What they do not share is meaning, which
 * is why one is not stored in the other's table with a nullable column deciding
 * which it is — a bug in that column would file a customer's legal contract
 * under somebody's receipt.
 */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { asc, inArray } from "drizzle-orm";
import { attachments } from "../db/schema.js";
/**
 * What may be attached, and what it is written to disk as.
 *
 * An allow-list rather than a block-list. The question is not "is this
 * dangerous" — it is "is this one of the handful of things a proof of payment
 * is ever going to be", and the answer is a photo, a screenshot, or a PDF from
 * the bank. Anything else is a mistake or an attack, and both deserve the same
 * refusal.
 *
 * The extension comes from THIS table, never from the uploaded filename, so a
 * file called "comprobante.pdf.html" cannot be written as anything but a PDF.
 */
const ALLOWED_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "application/pdf": ".pdf",
};
export const ALLOWED_CONTENT_TYPES = Object.keys(ALLOWED_TYPES);
/**
 * 12 MB.
 *
 * Comfortably above a phone photo of a deposit slip, which is what this is for,
 * and far below the size at which somebody could fill the disk one upload at a
 * time. A modern phone camera produces 3–6 MB; a WhatsApp-compressed screenshot
 * is well under 1 MB.
 */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
/** How many files one receipt may carry. Enough for a slip and a screenshot. */
export const MAX_ATTACHMENTS_PER_RECEIPT = 8;
/**
 * 30 MB, for a contract rather than a comprobante.
 *
 * A deposit slip is one phone photograph and fits in 12 MB with room to spare.
 * A signed contract is fifteen scanned pages, and an office scanner set to
 * 300dpi colour — which is what people leave them on — produces 1.5–2 MB per
 * page. Holding contracts to the comprobante's ceiling would mean the one
 * document this feature exists for is the one that will not upload.
 */
export const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024;
/**
 * How many files one contract may carry.
 *
 * Higher than a receipt's, because a contract accumulates: the signed contract
 * itself, an adenda or two, a copy of each party's identidad, the plano. Still
 * a ceiling rather than an invitation — a contract with twelve documents is
 * somebody using this as a filing cabinet, which it is not.
 */
export const MAX_DOCUMENTS_PER_CONTRACT = 12;
export function isAllowedContentType(contentType) {
    return Object.hasOwn(ALLOWED_TYPES, contentType);
}
/**
 * The name this file gets ON DISK.
 *
 * Entirely generated: a UUID plus the extension implied by the ALLOWED_TYPES
 * entry. The uploaded name never reaches the filesystem, which takes path
 * traversal ("../../etc/passwd"), null bytes, case-collisions and
 * absurdly-long-name failures all off the table at once rather than trying to
 * sanitise a string that has no obligation to be sane.
 */
export function storageKeyFor(contentType) {
    return `${randomUUID()}${ALLOWED_TYPES[contentType] ?? ".bin"}`;
}
/**
 * The uploaded name, made safe to store and show.
 *
 * Kept for the person reading the receipt later — "BAC-deposito-agosto.jpg"
 * means something where a UUID does not. It is display text only and is never
 * joined to a path, but it is still stripped of directory separators and
 * control characters so it cannot be used to fake one on screen.
 */
export function safeDisplayName(rawName) {
    const trimmed = rawName
        // Control characters: the null byte, and the newline that would let a
        // filename forge a second line of output in a log or on screen.
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/[/\\]/g, "-")
        .trim();
    const name = trimmed === "" ? "comprobante" : trimmed;
    return name.length > 120 ? `${name.slice(0, 110)}…${extname(name).slice(0, 9)}` : name;
}
/**
 * The display name, reduced to something a header can carry literally.
 *
 * `Content-Disposition` is an HTTP header, and a header is bytes: an "ñ" or an
 * emoji in a filename is either mangled or — worse, in a header assembled by
 * string concatenation — a way to smuggle a newline. The real name travels in
 * the `filename*` parameter beside this one, which is UTF-8 and percent-encoded;
 * this is the fallback for whatever does not read that, so it is allowed to be
 * lossy but not allowed to be dangerous.
 */
export function asciiFileName(name) {
    const stripped = name
        // Anything outside printable ASCII becomes an underscore rather than
        // disappearing, so "depósito.pdf" reads as "dep_sito.pdf" and not "depsito".
        .replace(/[^\x20-\x7e]/g, "_")
        // The quote would close the quoted-string this sits inside; the backslash
        // would escape whatever follows it.
        .replace(/["\\]/g, "_");
    return stripped.trim() === "" ? "comprobante" : stripped;
}
/**
 * Is this storage key one this application generated?
 *
 * Checked again on the way OUT, before a file is read back and served. The keys
 * come from our own database, so in principle this can never fail — which is
 * exactly why it is cheap to assert: a path read from a row and handed to the
 * filesystem is the shape of bug that turns one SQL injection into arbitrary
 * file disclosure, and one regex removes that whole possibility.
 */
export function isValidStorageKey(key) {
    return /^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/.test(key);
}
/**
 * Send one stored file back, for VIEWING rather than for saving.
 *
 * The single implementation of these headers, shared by the comprobante route
 * and the contract-document route. It is one function rather than two copies
 * because every line of it is a security decision, and a security decision
 * written twice is a security decision that will eventually only be updated
 * once.
 *
 * This used to send `Content-Disposition: attachment`, which meant every look
 * at a file put a copy of it in the Downloads folder of whatever machine was
 * being used — including the shared one in the office — and left it there. The
 * files are kept on the server precisely so they stop living on phones and
 * laptops; a viewer that downloads them undoes the whole point. That matters
 * more for a legal contract than it ever did for a deposit slip.
 *
 * Returns the reply, or sends an error on it: a malformed key is refused rather
 * than handed to the filesystem.
 */
export function sendStoredFile(reply, row, uploadsPath) {
    // Asserted on the way out as well as on the way in. The key comes from our
    // own row, so this can only fail if something has already gone very wrong —
    // which is exactly when a path handed to the filesystem must not be trusted.
    if (!isValidStorageKey(row.storageKey)) {
        reply.log.error({ fileId: row.id }, "Refusing to serve a malformed storage key");
        return reply.code(500).send({ error: "bad_storage_key", message: "Archivo no disponible." });
    }
    reply
        .header("Content-Type", row.contentType)
        .header("Content-Length", String(row.byteSize))
        /*
         * Shown in place, not saved to disk.
         *
         * `filename*` is the RFC 5987 form and takes UTF-8 directly, so an
         * acentuated name survives; the plain `filename` beside it is an ASCII
         * fallback for anything that does not read the starred one. The name still
         * matters under `inline` — it is what a browser labels the tab with, and
         * what it would use if the user deliberately saves the file.
         */
        .header("Content-Disposition", `inline; filename="${asciiFileName(row.fileName)}"; filename*=UTF-8''${encodeURIComponent(row.fileName)}`)
        /*
         * The answer to "but a PDF runs scripts".
         *
         * `sandbox` drops this response into an OPAQUE ORIGIN. Whatever the file
         * turns out to be, it is then not this app: it cannot read the session
         * cookie, cannot call an endpoint as the signed-in user, cannot touch
         * localStorage, cannot submit a form, cannot navigate the page that framed
         * it. That is a stronger guarantee than `Content-Disposition: attachment`
         * ever gave, which only relocated the file to a folder where somebody would
         * later open it in a viewer with no sandbox at all.
         *
         * `allow-scripts` for a PDF, and only for a PDF. The browser's built-in PDF
         * viewer is itself script, so a bare `sandbox` risks rendering a blank frame
         * instead of the signed contract — and the escape that matters is
         * `allow-same-origin`, which is NOT granted here and must never be: scripts
         * plus same-origin together would undo the sandbox entirely. An image needs
         * no script, so it does not get any.
         */
        .header("Content-Security-Policy", row.contentType === "application/pdf" ? "sandbox allow-scripts" : "sandbox")
        // Belt and braces with the allow-list on the way in: whatever the row
        // claims, the browser must not go looking for a better idea. A file stored
        // as a PNG that is really HTML has to stay a broken image.
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, max-age=3600");
    return reply.send(createReadStream(join(uploadsPath, row.storageKey)));
}
/**
 * Delete the bytes behind a row that has already gone.
 *
 * Called AFTER the row, and deliberately forgiving: a file already missing from
 * disk must not stop the row being removed, or the record becomes undeletable
 * and the only way out is the database console. The row is what makes a file
 * findable, so a row without bytes is a broken thumbnail and bytes without a
 * row are invisible rubbish — of the two, the second is the one to prefer when
 * something has to give.
 */
export async function removeStoredFile(uploadsPath, storageKey) {
    if (isValidStorageKey(storageKey)) {
        await unlink(join(uploadsPath, storageKey)).catch(() => undefined);
    }
}
/**
 * Every attachment on a batch of receipts, grouped by receipt.
 *
 * One query for the whole batch rather than one per receipt: both the receipt
 * detail and the transactions list need this, and the transactions list asks
 * about every receipt in the office at once. Shared between the two so they
 * cannot disagree about what is attached to what — a thumbnail on a row that
 * opens a receipt showing different files is the bug this prevents.
 */
export function attachmentsForReceipts(db, receiptIds) {
    const byReceipt = new Map();
    if (receiptIds.length === 0) {
        return byReceipt;
    }
    const rows = db
        .select({
        id: attachments.id,
        receiptId: attachments.receiptId,
        paymentId: attachments.paymentId,
        fileName: attachments.fileName,
        contentType: attachments.contentType,
        byteSize: attachments.byteSize,
        createdAt: attachments.createdAt,
    })
        .from(attachments)
        .where(inArray(attachments.receiptId, receiptIds))
        // Oldest first, so "the first comprobante" means the one that arrived
        // first — which is the one a thumbnail on a transaction row shows.
        .orderBy(asc(attachments.createdAt), asc(attachments.id))
        .all();
    for (const { receiptId, ...file } of rows) {
        const list = byReceipt.get(receiptId);
        if (list) {
            list.push(file);
        }
        else {
            byReceipt.set(receiptId, [file]);
        }
    }
    return byReceipt;
}
/**
 * The files a single transaction row should offer.
 *
 * A file tagged with this payment, plus every untagged file on the receipt.
 * The untagged ones are included on purpose: before the tagging existed — and
 * whenever nobody bothers with it, which is most of the time — one slip is the
 * proof of the whole receipt, and hiding it from every row would mean the
 * common case showed nothing at all.
 */
export function attachmentsForPayment(onReceipt, paymentId) {
    return (onReceipt ?? []).filter((file) => file.paymentId === null || file.paymentId === paymentId);
}
//# sourceMappingURL=storedFiles.js.map