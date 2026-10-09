import { useEffect, useMemo, useRef, useState } from "react";

import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Dialog } from "../../components/Dialog";
import { DocumentThumb, DocumentViewer } from "../../components/DocumentViewer";
import type { ViewerFile } from "../../components/DocumentViewer";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import { ApiError } from "../../lib/api";
import { readableSize } from "../../lib/documentFiles";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney, parseMoneyInput, toMoneyInput } from "../../lib/money";
import type { ReceiptAttachment, Transaction } from "../../types";
import type { TransactionEdit } from "./api";
import {
  deleteAttachment,
  storedProof,
  updateReceiptNote,
  updateTransaction,
  uploadAttachment,
} from "./api";
import { useFileDrop } from "../../lib/useFileDrop";
import { googleDriveConfigured, preloadGoogleDrive } from "../../lib/googleDrive";
import type { PaymentType } from "./paymentType";
import { PAYMENT_TYPE_OPTIONS } from "./paymentType";
import { MAX_PROOFS, PROOF_ACCEPT, acceptProofFiles, pickProofsFromDrive } from "./ProofDropzone";
import { compareLedgerOrder } from "./transactionSort";

interface TransactionEditDialogProps {
  transaction: Transaction;
  /** Every transaction of the SAME customer, so the edit is seen in context. */
  customerTransactions: Transaction[];
  money: MoneyView;
  onClose: () => void;
  onSaved: () => void;
  /**
   * Whether this user may attach and remove comprobantes.
   *
   * `payment:record` rather than `payment:edit`, deliberately, and they are not
   * the same permission: filing the slip the customer sent is part of recording
   * the money, while editing is rewriting a figure that was already posted.
   * Somebody allowed to correct an amount is not thereby allowed to add
   * evidence, and somebody who records payments all day is not thereby allowed
   * to correct them.
   */
  canAttachProof: boolean;
  /** The comprobantes changed on the server; the list behind has to re-read. */
  onProofsChanged: () => void;
}

type Method = "cash" | "transfer" | "card";

const METHODS: Array<{ value: Method; label: string }> = [
  { value: "cash", label: "Cash" },
  { value: "transfer", label: "Bank transfer" },
  { value: "card", label: "Card" },
];

const MINIMUM_REASON = 10;

/** "15 mar 2026" — compact, for a list rather than a document. */
function shortDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);

  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year!, month! - 1, day!)));
}

/**
 * Correct a posted transaction.
 *
 * This is the one place in Lindero where a financial fact is rewritten rather
 * than reversed, so the screen is built to make that visible rather than easy:
 * the customer's whole history sits beside the form, the row being changed is
 * marked in it, and a reason is required before the button will do anything.
 *
 * The history is there because an amount has no meaning on its own. "L 5,000 →
 * L 10,000" is a number changing; the same edit seen against the eleven
 * payments around it is a story that either makes sense or obviously does not,
 * and that is the check no validation rule can perform.
 *
 * Every balance after this transaction re-derives on its own once it is saved.
 * Nothing has to be unlocked, and nothing downstream has to be corrected by
 * hand — see backend/src/lib/ledger.ts.
 */
export function TransactionEditDialog({
  transaction,
  customerTransactions,
  money,
  onClose,
  onSaved,
  canAttachProof,
  onProofsChanged,
}: TransactionEditDialogProps) {
  const [amountText, setAmountText] = useState(() => toMoneyInput(transaction.amount));
  const [paidOn, setPaidOn] = useState(transaction.paidOn);
  const [method, setMethod] = useState<Method>(transaction.method as Method);
  const [type, setType] = useState<PaymentType>(transaction.type as PaymentType);
  const [reference, setReference] = useState(transaction.reference ?? "");

  /*
   * Which note the Nota field is editing.
   *
   * On a line with a receipt it is the RECEIPT's note — the Nota del equipo, the
   * one the panel shows and every line of the receipt shares. It used to be the
   * payment's own note, which nothing else on screen displayed: typing in it
   * saved something, and the box meant for exactly that message stayed empty.
   * Money recorded before there were receipts has no receipt to hold a note, so
   * for those the field keeps meaning the payment's own.
   */
  const receiptBacked = transaction.receiptId !== null;
  const savedNote = receiptBacked ? transaction.receiptNote : transaction.notes;
  // Locked rather than hidden, like the price on a contract: somebody who may
  // correct a payment but not record one still reads what the note says.
  const noteLocked = receiptBacked && !canAttachProof;

  const [notes, setNotes] = useState(savedNote ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [overpaymentPrompt, setOverpaymentPrompt] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  /*
   * Has anything moved off what the transaction says?
   *
   * Pre-filled, so "is there text in it" is always yes — see the same note in
   * `ContractEditDialog`. `reason` counts on its own: it starts empty and the
   * only way it has anything in it is that somebody was writing an explanation.
   */
  const isDirtyEdit =
    amountText !== toMoneyInput(transaction.amount) ||
    paidOn !== transaction.paidOn ||
    method !== (transaction.method as Method) ||
    type !== (transaction.type as PaymentType) ||
    reference !== (transaction.reference ?? "") ||
    notes !== (savedNote ?? "") ||
    reason.trim() !== "";

  /*
   * The other lines of the same receipt.
   *
   * A receipt covering three lots is three payment rows sharing one
   * `receiptId`. A wrong date or a wrong method on one of them was almost
   * certainly typed wrong on all three — they came off one piece of paper — so
   * the correction is offered across them rather than made three times.
   *
   * Reversed lines are left out: their money is already out of the accounts and
   * rewriting the date of something that does not count is meaningless.
   */
  const siblings = useMemo(
    () =>
      transaction.receiptId === null
        ? []
        : customerTransactions.filter(
            (row) =>
              row.receiptId === transaction.receiptId &&
              row.id !== transaction.id &&
              row.reversedAt === null,
          ),
    [customerTransactions, transaction],
  );

  /** Which sibling lines this correction also covers. None, until asked. */
  const [applyToIds, setApplyToIds] = useState<ReadonlySet<string>>(new Set());

  /*
   * The four fields that describe the ACT of paying rather than one lot's
   * share: the date, how it was paid, what kind of payment it was, and the
   * bank's confirmation number. These are the only ones that can be copied
   * across lines — see `applyToPaymentIds` in routes/transactions.ts for why
   * the amount emphatically cannot.
   */
  const sharedFieldsChanged =
    paidOn !== transaction.paidOn ||
    method !== (transaction.method as Method) ||
    type !== (transaction.type as PaymentType) ||
    reference !== (transaction.reference ?? "");

  const amountChanged = amountText !== toMoneyInput(transaction.amount);

  const toggleApplyTo = (id: string) => {
    setApplyToIds((current) => {
      const next = new Set(current);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  };

  /*
   * The comprobantes on this row, held here rather than read off the prop.
   *
   * `transaction` is a snapshot App took when the pencil was pressed and it
   * does not change while the dialog is open, so a file uploaded here would not
   * appear until the dialog was closed and reopened — i.e. it would look like
   * the upload had failed. The list behind is refreshed too, through
   * `onProofsChanged`; this is what the dialog itself shows meanwhile.
   */
  const [attachments, setAttachments] = useState<ReceiptAttachment[]>(transaction.attachments);
  /*
   * Whether a comprobante was filed or removed while this dialog was open.
   *
   * Not part of the correction — those writes already went to the server — but
   * it changes what the two buttons at the bottom should SAY. Somebody who
   * opened the pencil only to attach the slip the customer sent has finished
   * their work, and telling them so is the difference between a screen that
   * saved their file and a screen that appears to have swallowed it.
   */
  const [proofsFiled, setProofsFiled] = useState(false);
  const [proofBusy, setProofBusy] = useState<string | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const [viewingProof, setViewingProof] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<ViewerFile | null>(null);
  const proofInputRef = useRef<HTMLInputElement>(null);

  /*
   * Google's scripts are fetched when the dialog opens rather than on the
   * click, so the consent popup opens inside the click that asked for it. See
   * `preloadGoogleDrive`.
   */
  useEffect(preloadGoogleDrive, []);

  const typedAmount = parseMoneyInput(amountText);
  const amountCents = Number.isNaN(typedAmount) ? 0 : Math.round(typedAmount * 100);
  const trimmedReason = reason.trim();

  const targetRef = useRef<HTMLLIElement>(null);

  /*
   * Scroll the row being corrected into view.
   *
   * A customer with three lots and two years of payments has upwards of sixty
   * rows here, and the one being changed is very often the most recent — i.e.
   * off the bottom. A history you have to hunt through is not context.
   */
  useEffect(() => {
    targetRef.current?.scrollIntoView({ block: "center" });
  }, []);

  /**
   * Ordered oldest-first here, because this is a history rather than a feed.
   *
   * `compareLedgerOrder` rather than a sort spelled out again: this is the
   * order `backend/src/lib/ledger.ts` replays a contract in, so the sequence
   * read here is the sequence the balances either side of this edit were
   * derived from — and it is the same function the Recibos list sorts by, which
   * is what makes that list's "más recientes primero" the exact reverse of this
   * panel. Written out twice, the two drifted: rows tied on both the date and
   * the entry time came out in the same order in a list that claimed to be
   * newest-first, so the last row of a customer's payments opened here as their
   * third rather than their first.
   */
  const history = useMemo(
    () => [...customerTransactions].sort(compareLedgerOrder),
    [customerTransactions],
  );

  /*
   * Voided rows stay in the list, struck through, because they are part of the
   * story — but they are left out of the count, the way their money is left
   * out of the balances.
   */
  const voidedCount = history.filter((entry) => entry.reversedAt !== null).length;
  const activeCount = history.length - voidedCount;

  const noteChanged = (notes.trim() || null) !== (savedNote ?? null);

  /*
   * A correction, and the team note, are different acts.
   *
   * Moving an amount or a date rewrites something the ledger stands on, and
   * that is what the written motive is for. The note is a message: it says
   * nothing the ledger depends on, never appears on the receipt, and the box in
   * the panel changes it with no motive at all. Asking for ten characters of
   * justification here for the same words would make this dialog the one place
   * a note costs something — so a change to the note ALONE needs none. The old
   * per-payment note, on money with no receipt, is still part of the payment
   * and still counts as a correction.
   */
  const teamNoteChanged = receiptBacked && noteChanged;
  const correctionChanged =
    amountCents !== transaction.amount ||
    paidOn !== transaction.paidOn ||
    method !== transaction.method ||
    type !== transaction.type ||
    (reference.trim() || null) !== (transaction.reference ?? null) ||
    (!receiptBacked && noteChanged);
  const hasChanges = correctionChanged || teamNoteChanged;
  const isNoteOnly = teamNoteChanged && !correctionChanged;

  const canSubmit =
    amountCents > 0 &&
    hasChanges &&
    (isNoteOnly || trimmedReason.length >= MINIMUM_REASON) &&
    !isSaving;

  /**
   * The comprobante was the whole errand.
   *
   * Nothing on the form changed and a file was filed, so there is no correction
   * to save and the work is already on the server. The primary button becomes
   * "Listo" and simply closes — pressing the main button and having the screen
   * go away is what "done" looks like, and leaving a permanently dead "Guardar
   * corrección" there instead is what made attaching a slip feel like it had
   * failed.
   */
  const proofWasTheWork = !hasChanges && proofsFiled;

  /**
   * Why the button will not move, in the words of whoever is pressing it.
   *
   * A disabled primary button is now visibly disabled (see `.btn-primary` in
   * styles.css), but "greyed out" only says that it is refusing — not what it
   * is waiting for. Both of the things it waits for are invisible: a motive
   * that is long enough, and a figure that actually differs from the one
   * already posted. Neither is guessable from a grey rectangle.
   *
   * Silent on a form nobody has touched yet, though. A dialog that opens
   * already complaining is telling somebody off for not having done anything
   * in the half-second it has been on screen; the note is for the moment they
   * have started and something is missing, not for the moment they arrive.
   */
  const blockedReason = (() => {
    if (isSaving || canSubmit || proofWasTheWork) {
      return null;
    }

    if (amountCents <= 0) {
      return "Enter the corrected amount.";
    }

    if (!hasChanges) {
      // Reached only with a motive typed against an untouched form — i.e.
      // somebody clearly intending to save. With a comprobante filed instead,
      // `proofWasTheWork` answered above and the button already says "Listo".
      return trimmedReason.length === 0
        ? null
        : "No amount has changed yet, so there is nothing to correct.";
    }

    return `Enter a reason for the change (at least ${MINIMUM_REASON} characters).`;
  })();

  const submit = async (allowOverpayment: boolean) => {
    setError(null);
    setSaving(true);

    const noteValue = notes.trim() === "" ? null : notes.trim();

    const edit: TransactionEdit = {
      amountCents,
      paidOn,
      method,
      type,
      reference: reference.trim() === "" ? null : reference.trim(),
      /*
       * Which note travels, and only when it moved.
       *
       * Left out otherwise, which the server reads as "leave it": sending the
       * old value back would be harmless for the team note but would wipe, on a
       * line with a receipt, whatever the payment's own note still holds from
       * before this field changed meaning.
       */
      ...(receiptBacked
        ? teamNoteChanged
          ? { receiptNote: noteValue }
          : {}
        : { notes: noteValue }),
      reason: trimmedReason,
      allowOverpayment,
      /*
       * Only when one of the four shared fields actually moved.
       *
       * Checking a lot and then changing nothing but the amount would otherwise
       * write an audit entry on every sibling saying that its date changed from
       * a value to the same value — noise in the one history that has to stay
       * readable.
       */
      applyToPaymentIds: sharedFieldsChanged ? [...applyToIds] : [],
    };

    try {
      if (isNoteOnly && transaction.receiptId !== null) {
        // Nothing here was corrected, so this is the same write the box in the
        // receipt panel makes — no motive, nothing for the ledger to re-derive.
        await updateReceiptNote(transaction.receiptId, noteValue);
      } else {
        await updateTransaction(transaction.id, edit);
      }

      onSaved();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "overpayment") {
        setOverpaymentPrompt(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : "Could not save the change.");
      }
      setSaving(false);
    }
  };

  /** This row's evidence, as the viewer and the thumbnails want it. */
  const proofs: ViewerFile[] = attachments.map((file) =>
    storedProof(file, file.paymentId === null ? null : transaction.lotCode),
  );

  /**
   * Attach a comprobante to the payment on screen.
   *
   * Uploaded the moment it is chosen, NOT when "Guardar corrección" is pressed,
   * and the two are deliberately unrelated. Saving requires a real change plus
   * a typed motive, because it rewrites a posted figure. Filing the slip the
   * customer sent changes no figure at all — it adds the evidence for the one
   * already there — so making it wait behind a motive would mean inventing a
   * fake correction in order to attach a file.
   *
   * Tagged with `transaction.id`, so on a receipt covering three lots the slip
   * lands on THIS lot rather than on the paper as a whole.
   */
  const addProofs = async (incoming: FileList | File[] | null) => {
    if (transaction.receiptId === null || incoming === null || incoming.length === 0) {
      return;
    }

    setProofError(null);

    /*
     * Counted against this ROW's files, which is a floor and not the server's
     * actual limit: the cap is eight per RECEIPT, and a receipt covering three
     * lots can already hold files this row never shows. So this refuses the
     * obviously-too-many early and the server stays the authority on the rest —
     * its 409 arrives below as the message it wrote.
     */
    const { accepted, rejections } = acceptProofFiles(
      Array.from(incoming),
      attachments.length,
      MAX_PROOFS,
    );

    if (rejections.length > 0) {
      setProofError(rejections[0]!);
    }

    const stored: ReceiptAttachment[] = [];

    for (const proof of accepted) {
      setProofBusy(`Uploading ${proof.file.name}…`);

      try {
        stored.push(await uploadAttachment(transaction.receiptId, proof.file, transaction.id));
      } catch (caught) {
        setProofError(
          caught instanceof Error ? caught.message : "Could not upload the proof file.",
        );
      }

      // Held only to validate the file and to name it; nothing here previews
      // it, so the object URL would otherwise leak one image per upload.
      URL.revokeObjectURL(proof.previewUrl);
    }

    setProofBusy(null);

    if (stored.length > 0) {
      setAttachments((held) => [...held, ...stored]);
      setProofsFiled(true);
      onProofsChanged();
    }
  };

  /*
   * From Google Drive instead. Everything after the download is `addProofs`,
   * and Drive's own complaints are shown only when the upload had none — see
   * `useProofAttach` for why the order matters.
   */
  const pickFromDrive = async () => {
    if (transaction.receiptId === null) {
      return;
    }

    setProofError(null);
    setProofBusy("Opening Google Drive…");

    try {
      const { files, rejections } = await pickProofsFromDrive(setProofBusy);

      await addProofs(files);

      if (rejections.length > 0) {
        setProofError((shown) => shown ?? rejections[0]!);
      }
    } catch (caught) {
      setProofError(caught instanceof Error ? caught.message : "Could not open Google Drive.");
    } finally {
      setProofBusy(null);
    }
  };

  /*
   * Dropping is the same act as choosing, so it goes through the same function
   * — the size, type and count rules, the sequential upload, and the error
   * that leaves the payment untouched are all in `addProofs` already.
   */
  const { isDraggingOver, dropHandlers } = useFileDrop(
    (files) => void addProofs(files),
    proofBusy !== null,
  );

  /**
   * Remove one. Only ever reached from the confirmation.
   *
   * Throws rather than swallowing, so `ConfirmDialog` can stay open and say
   * what went wrong — a prompt that closes on a failed delete looks exactly
   * like one that closed on a successful delete.
   */
  const removeProof = async (attachmentId: string) => {
    setProofError(null);
    setProofBusy("Removing proof file…");

    try {
      await deleteAttachment(attachmentId);
      setAttachments((held) => held.filter((file) => file.id !== attachmentId));
      setProofsFiled(true);
      onProofsChanged();
    } finally {
      setProofBusy(null);
    }
  };

  return (
    /* `wide` because the history beside the form is a table, not prose — see
       the note on `size` in components/Dialog.tsx. It stacks under the form
       below 900px, where the room to put it beside them stops existing. */
    <Dialog
      ariaLabel={`Edit transaction for ${transaction.customerName}`}
      size="wide"
      /*
       * Rewriting a posted figure is the one act on this screen that cannot be
       * undone from the outside, and it takes a written reason to do it. A
       * click that lands beside the panel must not be what throws that away.
       * Shut while a comprobante is uploading too — leaving mid-upload is how
       * the file goes missing. See `dismissible` in Dialog.tsx.
       */
      dismissible={!isDirtyEdit && !isSaving && proofBusy === null}
      onClose={onClose}
    >
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow">Edit transaction</p>
          <h2>{transaction.customerName}</h2>
          <p className="modal-description">
            {transaction.lotCode} · {transaction.projectName} · recorded by{" "}
            {transaction.recordedByName}
          </p>
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          <IconClose />
        </button>
      </div>

      <div className="edit-with-history">
        <div className="edit-form">
          <div className="modal-form-grid">
            <div className="form-field">
              <label htmlFor="edit-amount">
                Amount <span className="required-mark">*</span>
              </label>
              <MoneyInput id="edit-amount" value={amountText} onChange={setAmountText} />
              {amountCents !== transaction.amount && amountCents > 0 && (
                <span className="field-hint">
                  Before {formatMoney(transaction.amount, money)} → now{" "}
                  {formatMoney(cents(amountCents), money)}
                </span>
              )}
            </div>

            <div className="form-field">
              <label htmlFor="edit-date">
                Payment date <span className="required-mark">*</span>
              </label>
              <input
                id="edit-date"
                type="date"
                value={paidOn}
                onChange={(event) => setPaidOn(event.target.value)}
              />
              {paidOn !== transaction.paidOn && (
                <span className="field-hint">
                  Changing the date moves it in the history and recalculates all following balances.
                </span>
              )}
            </div>

            <div className="form-field">
              <label htmlFor="edit-method">Payment method</label>
              <select
                id="edit-method"
                value={method}
                onChange={(event) => setMethod(event.target.value as Method)}
              >
                {METHODS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-field">
              <label htmlFor="edit-type">Type</label>
              <select
                id="edit-type"
                value={type}
                onChange={(event) => setType(event.target.value as PaymentType)}
              >
                {PAYMENT_TYPE_OPTIONS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-field full-width">
              <label htmlFor="edit-reference">Confirmation number</label>
              <input
                id="edit-reference"
                type="text"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="e.g. BAC-889231"
              />
            </div>

            <div className="form-field full-width">
              <label htmlFor="edit-notes">{receiptBacked ? "Team note" : "Note"}</label>
              <textarea
                id="edit-notes"
                rows={2}
                maxLength={receiptBacked ? 500 : 300}
                value={notes}
                readOnly={noteLocked}
                onChange={(event) => setNotes(event.target.value)}
              />
              <span className="field-hint">
                {noteLocked
                  ? "Your account can't change the receipt note."
                  : receiptBacked
                    ? "This receipt note is visible to all users and shared by all its transactions. It isn't printed. Changing only the note doesn't require a reason."
                    : "This payment predates receipts, so its note belongs to this transaction only."}
              </span>
            </div>

            {/*
              Which lots of this receipt the correction reaches.
              *
              * Hidden entirely on a one-lot receipt, where the question does not
              * arise and a control offering one locked checkbox is just
              * furniture.
              */}
            {siblings.length > 0 && (
              <div className="apply-scope full-width">
                <p className="apply-scope-title">
                  This receipt covers {siblings.length + 1} lots. Which should this change apply to?
                </p>

                <div className="apply-scope-list">
                  {/* The lot being edited, always included and not a choice.
                      Shown anyway so the list is the whole receipt rather than
                      "the others", which would read as if this one were being
                      left out. */}
                  <label className="apply-scope-row is-fixed">
                    <input type="checkbox" checked readOnly disabled />
                    <span className="apply-scope-lot">{transaction.lotCode}</span>
                    <span className="apply-scope-meta">
                      {formatMoney(transaction.amount, money)} · this transaction
                    </span>
                  </label>

                  {siblings.map((sibling) => (
                    <label className="apply-scope-row" key={sibling.id}>
                      <input
                        type="checkbox"
                        checked={applyToIds.has(sibling.id)}
                        disabled={!sharedFieldsChanged}
                        onChange={() => toggleApplyTo(sibling.id)}
                      />
                      <span className="apply-scope-lot">{sibling.lotCode}</span>
                      <span className="apply-scope-meta">
                        {formatMoney(sibling.amount, money)}
                      </span>
                    </label>
                  ))}
                </div>

                {/*
                  The distinction the whole control turns on, said plainly.
                  *
                  * "Aplicar a todos" cannot mean putting the same amount on
                  * every lot — that would turn an L 40,000 receipt into
                  * L 120,000. Copying a DATE across three lots restates one
                  * fact; copying an AMOUNT across three lots invents money. So
                  * the amount is never part of what travels, and somebody
                  * trying to move money between lots is pointed at the screen
                  * that does it under the rule that keeps the total intact.
                  */}
                <p className="apply-scope-note">
                  The date, method, type, and confirmation number are copied. The{" "}
                  <strong>amount is not</strong>: each lot has its own share, and copying one amount
                  to all three would multiply the receipt total. To move money between lots, use{" "}
                  <strong>Redistribute</strong> in the receipt view; it keeps the shares equal to
                  the total.
                </p>

                {!sharedFieldsChanged && amountChanged && (
                  <p className="apply-scope-note is-muted">
                    You only changed the amount, so there is nothing to copy to the other lots.
                  </p>
                )}
              </div>
            )}

            <div className="form-field full-width">
              <label htmlFor="edit-reason">
                Reason for change{" "}
                {/* Not asked for when the note is all that moved — see `isNoteOnly`. */}
                {!isNoteOnly && <span className="required-mark">*</span>}
              </label>
              <textarea
                id="edit-reason"
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. The customer paid L 10,000, not L 5,000. Corrected using the printed receipt."
              />
              <span className="field-hint">
                Kept in the history with the previous amount. This is the only place the changed
                figure is preserved.
              </span>
              {trimmedReason.length > 0 && trimmedReason.length < MINIMUM_REASON && (
                <span className="field-error">
                  Enter at least {MINIMUM_REASON} characters.
                </span>
              )}
            </div>

            {/* About the amounts, so not when only the note is changing: that
                touches no figure on the receipt. */}
            {transaction.receiptId && !isNoteOnly && (
              <p className="form-warning full-width">
                This transaction is printed on receipt {transaction.receiptCode}. Saving changes
                the amounts on that receipt. If the customer has a paper copy, print it again.
              </p>
            )}

            {/*
              The customer's bank slip, attachable from here.

              It is reachable from the receipt panel too, but that is not where
              anybody looks for it: the comprobante arrives hours or days after
              the payment was recorded — the customer sends it that evening —
              and the gesture for "this payment needs something added" is the
              pencil on its row. Somebody who pressed it found a form about
              amounts and dates with no way to file the slip in their hand, and
              concluded the app could not hold one.

              Nothing here is part of the correction. The files upload as they
              are chosen and the button below never becomes the thing that
              saves them — attaching evidence is not rewriting a figure. What
              it does change is what that button SAYS: with no figure edited
              there is no correction left to save, so it reads "Listo" and
              closes, instead of sitting there refusing to be pressed.
            */}
            <div className="receipt-proofs full-width">
              <div className="receipt-proofs-head">
                <p className="receipt-preview-label">Customer payment proof</p>
              </div>

              {transaction.receiptId === null ? (
                /* Not a permission problem and not a bug, so it says which:
                   a comprobante is filed against a receipt, and this money was
                   recorded before there were any. Saying "no se puede" without
                   the reason is what sends somebody hunting for a setting. */
                <p className="state-message">
                  This payment isn't part of a receipt, and proof files are stored with receipts,
                  so this payment can't have one. Payments recorded in Receipts can.
                </p>
              ) : (
                <>
                  {/*
                    The same gesture the receipt form takes: drag the screenshot
                    straight out of the WhatsApp window.

                    It belongs here more than it belongs there. The comprobante
                    almost never arrives with the money — the customer sends it
                    that evening — so the payment is already recorded by the
                    time there is a file to file, and the pencil on its row is
                    where somebody goes to attach it. Until now this screen
                    offered a file picker and nothing else, which meant the one
                    place the drag was actually wanted was the one place it did
                    not work.
                  */}
                  {canAttachProof && attachments.length < MAX_PROOFS && (
                    <div
                      className={`proof-dropzone is-compact${isDraggingOver ? " is-over" : ""}${
                        proofBusy ? " is-disabled" : ""
                      }`}
                      {...dropHandlers}
                    >
                      <p className="proof-dropzone-title">Drop the proof file here</p>
                      <p className="proof-dropzone-hint">
                        Uploaded when dropped, without waiting for “Save correction” — attaching
                        proof doesn't change any amounts.
                      </p>

                      <div className="proof-dropzone-actions">
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={proofBusy !== null}
                          onClick={() => proofInputRef.current?.click()}
                        >
                          Choose file
                        </button>

                        {googleDriveConfigured() && (
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={proofBusy !== null}
                            onClick={() => void pickFromDrive()}
                          >
                            From Google Drive
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Only where there is no dropzone above saying the same
                      thing by being empty. */}
                  {proofs.length === 0 && !canAttachProof && (
                    <p className="state-message">No proof file attached.</p>
                  )}

                  {/* The zone is gone and the reason is not obvious: without
                      this, being at the limit looks exactly like having lost
                      the permission to attach. */}
                  {canAttachProof && attachments.length >= MAX_PROOFS && (
                    <p className="state-message">
                      This receipt already has the maximum of {MAX_PROOFS} proof files. Remove one
                      to add another.
                    </p>
                  )}

                  {proofs.length > 0 && (
                    <div className="proof-grid">
                      {proofs.map((file) => (
                        <button
                          key={file.id}
                          type="button"
                          className="proof-tile"
                          onClick={() => setViewingProof(file.id)}
                          title={`View ${file.name}`}
                        >
                          <DocumentThumb file={file} />
                          <span className="proof-tile-name">{file.name}</span>
                          {file.caption && (
                            <span className="proof-tile-lot">{file.caption}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {proofBusy && <p className="state-message">{proofBusy}</p>}
              {proofError && <p className="field-error">{proofError}</p>}

              {/* Off-screen, opened by "Elegir archivo". The dropzone's own
                  accept list, imported rather than written out again; the
                  server's is the one that counts. */}
              <input
                ref={proofInputRef}
                type="file"
                multiple
                className="proof-input"
                accept={PROOF_ACCEPT}
                onChange={(event) => {
                  void addProofs(event.target.files);
                  // Cleared so choosing the SAME file twice in a row still
                  // fires a change event.
                  event.target.value = "";
                }}
              />
            </div>

            {error && <p className="form-error full-width">{error}</p>}

            {overpaymentPrompt && (
              <div className="form-warning full-width">
                <p>{overpaymentPrompt}</p>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setOverpaymentPrompt(null);
                    void submit(true);
                  }}
                >
                  Yes, the customer overpaid — save anyway
                </button>
              </div>
            )}
          </div>
        </div>

        {/* The customer's whole history, so the change is judged in context
            rather than as a number on its own. */}
        <aside className="edit-history">
          <p className="cp-section-title">History for {transaction.customerName}</p>
          <p className="field-hint">
            {activeCount} transaction{activeCount === 1 ? "" : "s"} total
            {voidedCount > 0 &&
              `, excluding ${voidedCount} voided transaction${voidedCount === 1 ? "" : "s"}`}
            .
          </p>

          <ul className="edit-history-list">
            {history.map((entry) => {
              const isTarget = entry.id === transaction.id;

              return (
                <li
                  key={entry.id}
                  ref={isTarget ? targetRef : undefined}
                  className={`edit-history-row${isTarget ? " is-target" : ""}${
                    entry.reversedAt ? " is-void" : ""
                  }`}
                >
                  <span className="edit-history-date">{shortDate(entry.paidOn)}</span>
                  <span className="edit-history-lot">{entry.lotCode}</span>
                  <span className="edit-history-amount">
                    {isTarget && amountCents > 0 && amountCents !== entry.amount
                      ? formatMoney(cents(amountCents), money)
                      : formatMoney(entry.amount, money)}
                  </span>
                </li>
              );
            })}
          </ul>
        </aside>
      </div>

      <div className="modal-actions">
        {blockedReason && <p className="modal-actions-hint">{blockedReason}</p>}

        {/* "Cancelar" stops being true the moment a comprobante is filed: that
            file is on the server and this button will not take it back. */}
        <button type="button" className="btn-secondary" onClick={onClose}>
          {proofsFiled ? "Close" : "Cancel"}
        </button>

        {proofWasTheWork ? (
          <button type="button" className="btn-primary modal-submit" onClick={onClose}>
            Done
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary modal-submit"
            disabled={!canSubmit}
            onClick={() => void submit(false)}
          >
            {isSaving ? "Saving…" : isNoteOnly ? "Save note" : "Save correction"}
          </button>
        )}
      </div>

      {/*
        Stacked over the edit dialog — `Dialog` portals to <body> and keeps its
        own stack, so the viewer paints above this one and Escape closes only
        the top. It reads `proofs` on every render, so removing several in a row
        is one gesture repeated rather than open-delete-close-reopen.

        Deliberately NOT also guarded on `proofs.length`: the viewer closes
        itself when the list empties, and that is what clears `viewingProof`.
        Guarding here would unmount it first, leaving the id of a deleted file
        in state — so the next comprobante attached would pop the viewer open on
        its own.
      */}
      {viewingProof !== null && (
        <DocumentViewer
          files={proofs}
          startId={viewingProof}
          onClose={() => setViewingProof(null)}
          onRemove={canAttachProof ? setPendingRemoval : undefined}
        />
      )}

      {pendingRemoval && (
        <ConfirmDialog
          eyebrow="Remove proof file"
          title={pendingRemoval.name}
          description={
            pendingRemoval.sizeBytes === undefined
              ? undefined
              : readableSize(pendingRemoval.sizeBytes)
          }
          confirmLabel="Remove proof file"
          busyLabel="Removing…"
          onCancel={() => setPendingRemoval(null)}
          onConfirm={async () => {
            await removeProof(pendingRemoval.id);
            setPendingRemoval(null);
          }}
        >
          This permanently deletes the file from the server. The payment and receipt won't change;
          only the customer's proof file is removed, and if it is no longer in the chat, there is no
          other copy.
        </ConfirmDialog>
      )}
    </Dialog>
  );
}
