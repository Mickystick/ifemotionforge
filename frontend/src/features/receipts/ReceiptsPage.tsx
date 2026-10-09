import { useEffect, useMemo, useRef, useState } from "react";
import { useRememberedState } from "../../lib/viewMemory";
import type { RefObject } from "react";

import { IconChevronDown, IconEdit, IconPaperclip, IconWhatsApp } from "../../components/Icons";
import { MenuSurface } from "../../components/MenuSurface";
import { googleDriveConfigured, preloadGoogleDrive } from "../../lib/googleDrive";
import { useDismiss } from "../../lib/useDismiss";
import { readableSize } from "../../lib/documentFiles";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney } from "../../lib/money";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import { useIsMobile } from "../../lib/viewport";
import type { Contract, Receipt, Transaction } from "../../types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { STATUS_PRESENTATION } from "../contracts/contractPresentation";
import { DocumentViewer, DocumentThumb } from "../../components/DocumentViewer";
import type { ViewerFile } from "../../components/DocumentViewer";
import { ReceiptPaper } from "./ReceiptPaper";
import { useFileDrop } from "../../lib/useFileDrop";
import { paymentTypeLabel } from "./paymentType";
import { MAX_PROOFS, PROOF_ACCEPT, acceptProofFiles, pickProofsFromDrive } from "./ProofDropzone";
import { TransactionToolbar } from "./TransactionToolbar";
import { useProofAttach } from "./useProofAttach";
import type { TransactionView } from "./TransactionToolbar";
import {
  deleteAttachment,
  fetchReceipt,
  storedProof,
  updateReceiptNote,
  uploadAttachment,
} from "./api";
import { ReceiptNote } from "./ReceiptNote";
import { receiptToPng } from "./receiptImage";
import { copyGesture, pasteInstruction, receiptCaption, sendReceiptOnWhatsApp } from "./whatsapp";
import type { TransactionFilters } from "./transactionFilters";
import {
  NO_TRANSACTION_FILTERS,
  filterTransactions,
  searchTransactions,
  transactionsInScope,
} from "./transactionFilters";
import { contractTag } from "./contractTag";
import { DEFAULT_SORT, groupByCustomer, sortTransactions } from "./transactionSort";
import type { TransactionSort } from "./transactionSort";
import { countReceipts, idsBetween, paintedByDrag, toggleOne } from "./transactionSelection";
import type { DragMode } from "./transactionSelection";
import { SelectionSummaryBar } from "./SelectionSummaryBar";
import { ReceiptRedistributeDialog } from "./ReceiptRedistributeDialog";

interface ReceiptsPageProps {
  transactions: Transaction[];
  /**
   * Every contract, so the receipt panel can offer the customer's OTHER lots as
   * somewhere to move part of this receipt — including a lot created after the
   * money was taken, which is the whole case "Repartir" exists for.
   */
  contracts: Contract[];
  money: MoneyView;
  user: User;
  onVoidReceipt: (receipt: Receipt) => void;
  onEditTransaction: (transaction: Transaction) => void;
  /**
   * Re-read the list after a comprobante is attached or removed, or a receipt's
   * note is written.
   *
   * The thumbnails and the "Nota" chip live on the transaction rows, which are
   * the parent's data — so changing either from the receipt panel has to reach
   * back up, or the row that prompted it keeps showing the old state.
   */
  onProofsChanged: () => void;
  /**
   * Re-read everything after money moves between lots.
   *
   * Wider than `onProofsChanged` on purpose: redistributing rewrites payment
   * amounts, so the contracts, the customers' totals and the lots' status all
   * re-derive — the same set a void refreshes, for the same reason.
   */
  onLedgerChanged: () => void;
}

/** "Mar 15, 2026" — compact, for a list rather than a document. */
function shortDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);

  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year!, month! - 1, day!)));
}

interface RowProps {
  transaction: Transaction;
  money: MoneyView;
  isSelected: boolean;
  canEdit: boolean;
  onSelect: () => void;
  onEdit: () => void;
  /** Show this row's comprobantes, without selecting the row. */
  onOpenProof: (files: ViewerFile[], startId: string) => void;
  /** Whether this user may file the customer's slip against a payment. */
  canAttachProof: boolean;
  /** One was just filed from this row; the list behind has to re-read. */
  onProofsChanged: () => void;
  /** Hidden inside a customer group, where the name is already the heading. */
  showCustomer: boolean;
  /** Checked for the ad-hoc sum below, independent of `isSelected`. */
  isChecked: boolean;
  /** A reversed payment has stopped counting, so there is nothing to check. */
  canCheck: boolean;
  /** Armed a possible drag; resolved as a real one, or a plain click, on mouseup. */
  onCheckMouseDown: () => void;
  /** The pointer has entered this row's box while a drag is in progress. */
  onCheckMouseEnter: () => void;
  /** Mouse released over this box without it having been dragged across. */
  onCheckClick: (shiftKey: boolean) => void;
}

interface ProofSourceMenuProps {
  /** The square and what surrounds it; a press inside is not "outside". */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onDevice: () => void;
  onDrive: () => void;
}

/**
 * Where the comprobante is: on this device, or in Google Drive.
 *
 * Mounted only while open. There are sixty of these squares down the list, and
 * a `MenuSurface` kept mounted in each would be sixty viewport listeners for
 * the one menu anybody can have open at a time.
 *
 * Each choice closes the menu and acts within the same click: both the file
 * picker and Google's consent popup are refused by the browser once the
 * gesture that asked for them is over.
 */
function ProofSourceMenu({ anchorRef, onClose, onDevice, onDrive }: ProofSourceMenuProps) {
  const isMobile = useIsMobile();

  // On a phone this is a sheet with its own backdrop and Escape handling; a
  // second outside-click listener would only fight with it.
  useDismiss(!isMobile, anchorRef, onClose);

  return (
    <MenuSurface isOpen title="Attach proof file" onClose={onClose} className="proof-source-menu">
      <p className="menu-title desktop-only">Attach proof file</p>
      <button
        type="button"
        className="menu-item"
        onClick={() => {
          onClose();
          onDevice();
        }}
      >
        Desde este equipo
      </button>
      <button
        type="button"
        className="menu-item"
        onClick={() => {
          onClose();
          onDrive();
        }}
      >
        Desde Google Drive
      </button>
    </MenuSurface>
  );
}

/**
 * One transaction.
 *
 * The row is a button so the whole thing is one keyboard-reachable target, with
 * the edit control beside it rather than inside it — a button inside a button
 * is invalid HTML and behaves unpredictably when clicked. The thumbnail is
 * outside it for the same reason.
 */
function TransactionRow({
  transaction,
  money,
  isSelected,
  canEdit,
  onSelect,
  onEdit,
  onOpenProof,
  canAttachProof,
  onProofsChanged,
  showCustomer,
  isChecked,
  canCheck,
  onCheckMouseDown,
  onCheckMouseEnter,
  onCheckClick,
}: RowProps) {
  const isReversed = transaction.reversedAt !== null;
  const tag = contractTag(transaction);
  const slotInputRef = useRef<HTMLInputElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const [choosingSource, setChoosingSource] = useState(false);

  /*
   * This row's evidence, ready for the viewer.
   *
   * `storedProof` addresses each file by id on the server, so the thumbnail is
   * the actual comprobante rather than a placeholder — and the browser fetches
   * it lazily, only for rows scrolled into view.
   */
  const proofs = transaction.attachments.map((file) =>
    storedProof(file, file.paymentId === null ? null : transaction.lotCode),
  );

  /*
   * Tagged with `transaction.id`, so on a receipt covering three lots the slip
   * lands on THIS lot rather than on the paper as a whole — the same rule the
   * correction dialog files by. The row's own copy of the list is the one App
   * handed down, so nothing is patched locally: `onProofsChanged` re-reads and
   * the square below turns into the thumbnail.
   */
  const attach = useProofAttach({
    receiptId: transaction.receiptId,
    paymentId: transaction.id,
    heldCount: proofs.length,
    onStored: onProofsChanged,
  });

  /**
   * Whether this row offers somewhere to drop the customer's slip.
   *
   * The gap in the leftmost column is not decoration: a payment with no
   * comprobante is exactly the payment somebody is holding a screenshot for,
   * and until now the only way to file it was to open the row's pencil and
   * find the zone inside. The empty square IS the affordance — it says both
   * "nothing is on file here" and "put it here", which is what the blank space
   * was already trying to say and failing.
   *
   * Not on a reversed row: that money is out of the accounts and the row shows
   * no actions at all, struck through. Not without a receipt either — a
   * comprobante is filed against one, so there would be nowhere to put it.
   */
  const offersProofSlot =
    canAttachProof && !isReversed && transaction.receiptId !== null && proofs.length === 0;

  return (
    <div
      className={`txn-row${isSelected ? " is-selected" : ""}${isReversed ? " is-void" : ""}${
        isChecked ? " is-checked" : ""
      }`}
    >
      {/*
        The box a spreadsheet would call selecting a cell. A reversed payment
        has stopped counting — see the filter default in transactionFilters.ts
        — so its box stays disabled rather than letting somebody add it into a
        sum by hand.

        The SPAN is the real mouse target, not the checkbox inside it — see
        `.txn-check` in styles.css, which turns off pointer events on the
        input itself. A native checkbox flips its own `checked` the moment the
        mouse goes down and only commits to that (or reverts it) once the
        click finishes, which is a fight React's own re-render cannot win
        consistently — it used to take a second click for the box to catch up
        to what had already happened. Routing the mouse through the span
        instead means the browser never touches `checked` at all; only React
        ever writes it, so there is nothing left to race. It is also what
        lets a press-and-drag paint several boxes in one gesture, which a
        native checkbox has no notion of. The input stays real underneath
        for the keyboard: Tab still reaches it and Space still toggles it,
        through its own `onChange`, untouched by any of this.
      */}
      <span
        className={`txn-check-slot${canCheck ? "" : " is-disabled"}`}
        onMouseDown={
          canCheck
            ? (event) => {
                event.preventDefault();
                onCheckMouseDown();
              }
            : undefined
        }
        onMouseEnter={
          canCheck
            ? (event) => {
                if (event.buttons === 1) {
                  onCheckMouseEnter();
                }
              }
            : undefined
        }
        onClick={
          canCheck
            ? (event) => {
                event.stopPropagation();
                onCheckClick(event.shiftKey);
              }
            : undefined
        }
      >
        {/*
          `readOnly`, with NO `onChange` — and that is not a lapse.

          Pressing Space on a focused checkbox runs the browser's activation
          behaviour: it dispatches a `click` on the input, which bubbles up to
          the span above and toggles the row, and only THEN fires `change`. An
          `onChange` here would toggle the very same row a second time, and the
          two would cancel out — the box would look and behave as though the
          keyboard did nothing at all. The span is the one handler for both
          mouse and keyboard; `readOnly` is only what tells React this input is
          deliberately not the one driving the state.
        */}
        <input
          type="checkbox"
          className="txn-check"
          checked={isChecked}
          disabled={!canCheck}
          readOnly
          aria-label={`Select transaction for ${transaction.customerName} dated ${shortDate(transaction.paidOn)}`}
        />
      </span>

      {/*
        The comprobante, at a glance and one click from being read.

        Outside `txn-main` because it does something different from the row:
        the row opens the RECEIPT — the document the office issued — and this
        opens the SLIP the customer sent. Both are "look at this payment", and
        confusing them is how somebody confirms a transfer against a document
        the office wrote itself.
      */}
      {proofs.length > 0 && (
        <button
          type="button"
          className="txn-proof"
          onClick={() => onOpenProof(proofs, proofs[0]!.id)}
          title={
            proofs.length === 1
              ? `View proof file: ${proofs[0]!.name}`
              : `View ${proofs.length} proof files`
          }
          aria-label={`View proof file for ${transaction.customerName}`}
        >
          <DocumentThumb file={proofs[0]!} />
          {proofs.length > 1 && <span className="txn-proof-count">{proofs.length}</span>}
        </button>
      )}

      {/*
        The same square, empty, as a place to drop one.

        It carries `proof-dropzone` so it lights up with every other target in
        the app the moment files come over the window, and `is-over` when this
        is the one they would land on — a row in a list of sixty needs to say
        which square is about to take the file more than a full-width zone in a
        dialog ever did.

        `aria-disabled` while an upload is in flight rather than `disabled`: a
        disabled button stops receiving drag events, so the drop would fall
        through to the window behind and open a whole new transaction form on
        top of the upload already running.
      */}
      {offersProofSlot && (
        <div className="txn-proof-slot menu-anchor" ref={slotRef}>
          <button
            type="button"
            className={`proof-dropzone is-slot${attach.isDraggingOver ? " is-over" : ""}${
              attach.busy ? " is-disabled" : ""
            }${attach.error ? " is-error" : ""}`}
            {...attach.dropHandlers}
            aria-disabled={attach.busy !== null}
            aria-expanded={googleDriveConfigured() ? choosingSource : undefined}
            onClick={() => {
              if (attach.busy !== null) {
                return;
              }

              // With Drive on offer the square asks where the file is. Without
              // it there is one answer, and asking would be a wasted click.
              if (googleDriveConfigured()) {
                setChoosingSource((open) => !open);
              } else {
                slotInputRef.current?.click();
              }
            }}
            title={
              attach.error ??
              (attach.busy ?? "No proof attached. Drop the customer's file here, or click to browse.")
            }
            aria-label={`Attach proof for ${transaction.customerName} dated ${transaction.paidOn}`}
          >
            <IconPaperclip />
          </button>

          <input
            ref={slotInputRef}
            type="file"
            multiple
            className="proof-input"
            accept={PROOF_ACCEPT}
            onChange={(event) => {
              void attach.addProofs(event.target.files);
              // Cleared so choosing the SAME file twice in a row still fires a
              // change event.
              event.target.value = "";
            }}
          />

          {choosingSource && (
            <ProofSourceMenu
              anchorRef={slotRef}
              onClose={() => setChoosingSource(false)}
              onDevice={() => slotInputRef.current?.click()}
              onDrive={() => void attach.pickFromDrive()}
            />
          )}
        </div>
      )}

      {/*
        Neither a slip nor anywhere to put one — a reversed payment, money
        recorded before there were receipts, or somebody who may not attach.
        The column is held open anyway: the date is the first thing the eye
        scans down this list, and a handful of rows starting 44px to the left
        of the rest turns that column into a zigzag.
      */}
      {proofs.length === 0 && !offersProofSlot && (
        <div className="txn-proof-slot is-empty" aria-hidden="true" />
      )}

      <button type="button" className="txn-main" onClick={onSelect}>
        <span className="txn-date">{shortDate(transaction.paidOn)}</span>

        <span className="txn-who">
          {showCustomer && <span className="txn-name">{transaction.customerName}</span>}
          <span className="txn-detail">
            {transaction.lotCode} · {transaction.projectName}
          </span>
        </span>

        <span className="txn-tags">
          {/* Prima or cuota: the one fact about a payment that the row does not
              already say, and that used to take opening payments one by one.

              Not here any more: the receipt code and the payment method. Both
              are on the receipt itself, a click away. The code stays findable —
              `searchTransactions` matches it, so typing it, or scanning the
              printed barcode into the search box, lands on the row. */}
          <span className="txn-type">{paymentTypeLabel(transaction.type)}</span>
          {tag !== null && (
            <span className={`txn-contract is-${tag.side}`} title={tag.title}>
              {tag.side === "adenda" && "Adenda · "}
              {tag.code}
            </span>
          )}
          {/* A message was left on this receipt. Only THAT it exists — the
              sentence is the tooltip here and the box in the panel. */}
          {transaction.receiptNote !== null && (
            <span className="txn-note" title={transaction.receiptNote}>
              Nota
            </span>
          )}
          {/* The one thing the old receipt tag also said, and only when it is
              the exception: this money was never put on paper. */}
          {transaction.receiptCode === null && (
            <span className="txn-receipt is-missing" title="This payment was never printed">
              no receipt
            </span>
          )}
          {isReversed && <span className="txn-void">anulada</span>}
        </span>

        <span className="txn-amount">{formatMoney(transaction.amount, money)}</span>
      </button>

      {canEdit && !isReversed && (
        <button
          type="button"
          className="icon-btn txn-edit"
          onClick={onEdit}
          aria-label={`Edit transaction for ${transaction.customerName} dated ${transaction.paidOn}`}
          title="Edit this transaction"
        >
          <IconEdit />
        </button>
      )}
    </div>
  );
}

/**
 * The Recibos screen: the transactions on the left, the receipt on the right.
 *
 * Two arrangements of the same list, because the tab is opened for two
 * different questions. "¿Cuánto entró esta semana?" wants everything in date
 * order. "¿Qué ha pagado Ana?" wants one row per person that opens into their
 * history — which is also the only way to find a specific old payment without
 * scrolling through everybody else's.
 *
 * Both are built from ONE array of transactions, so they cannot disagree about
 * what exists. The receipt preview is fetched separately, on demand, because a
 * receipt's figures are derived from the whole ledger and the freshest answer
 * is always the one the server just computed.
 */
export function ReceiptsPage({
  transactions,
  contracts,
  money,
  user,
  onVoidReceipt,
  onEditTransaction,
  onProofsChanged,
  onLedgerChanged,
}: ReceiptsPageProps) {
  const [view, setView] = useRememberedState<TransactionView>("receipts.view", "date");
  const [search, setSearch] = useRememberedState("receipts.search", "");
  const [sort, setSort] = useRememberedState<TransactionSort>("receipts.sort", DEFAULT_SORT);
  const [filters, setFilters] = useRememberedState<TransactionFilters>(
    "receipts.filters",
    NO_TRANSACTION_FILTERS,
  );
  const [expanded, setExpanded] = useRememberedState<ReadonlySet<string>>(
    "receipts.expanded",
    new Set(),
  );
  // Remembered too: coming back to Recibos reopens the receipt that was being
  // read. The detail effect below fetches it again on the way in, so a receipt
  // changed in the meantime is shown as it is now, not as it was.
  const [selectedReceiptId, setSelectedReceiptId] = useRememberedState<string | null>(
    "receipts.selectedReceiptId",
    null,
  );
  /*
   * The ad-hoc sum: whichever rows somebody has checked by hand, independent
   * of the receipt shown in the panel. `lastCheckedId` is the anchor a
   * shift-click extends FROM — the row last clicked, whether or not it is
   * still checked, same as a spreadsheet keeps its anchor after a range is
   * clicked again to shrink it.
   */
  // Remembered across a tab change. Rows that have since left the screen are
  // pruned on the way back in by the same effect that prunes them on a search.
  const [checkedIds, setCheckedIds] = useRememberedState<ReadonlySet<string>>(
    "receipts.checkedIds",
    new Set(),
  );
  const [lastCheckedId, setLastCheckedId] = useRememberedState<string | null>(
    "receipts.lastCheckedId",
    null,
  );
  /*
   * A press-and-drag across several boxes, in progress.
   *
   * A ref rather than state: it changes on every row the pointer crosses
   * while held, and none of that is worth a render on its own — only the
   * `checkedIds` it paints along the way is. `painted` is what tells the
   * click that follows the eventual mouseup whether this gesture already did
   * its work — without it, releasing the mouse back over the row it started
   * on fires a click that would flip the box a second time and cancel the
   * drag out.
   */
  const dragRef = useRef<{
    anchorId: string;
    mode: DragMode;
    /*
     * The selection exactly as it stood when the mouse went down.
     *
     * Every move recomputes the whole answer from THIS, never from the
     * previous move's result — see `paintedByDrag`. It is what makes going
     * back over the rows you just crossed release them again instead of
     * leaving a one-way trail behind the pointer.
     */
    before: ReadonlySet<string>;
    painted: boolean;
  } | null>(null);
  const [detail, setDetail] = useState<Receipt | null>(null);
  const [isLoadingDetail, setLoadingDetail] = useState(false);

  /*
   * Whatever is being looked at, and where it came from.
   *
   * ONE viewer for every document this screen can show — a row's comprobante,
   * the panel's comprobantes, and the receipt image itself. They are the same
   * act (look at this, full size, without saving it anywhere), so only one can
   * be open at a time.
   *
   * What is stored is the SOURCE, not the list. The panel's files are derived
   * again on every render, so a receipt re-read underneath an open viewer —
   * which a teammate's write makes routine, and which removing a file does on
   * purpose — updates what is on screen instead of leaving it pointed at a
   * file that is no longer there. A row's files are carried, because they may
   * belong to a receipt that is not the one open in the panel.
   */
  const [viewing, setViewing] = useState<
    | { source: "proofs"; startId: string }
    | { source: "receipt" }
    | { source: "row"; files: ViewerFile[]; startId: string }
    | null
  >(null);
  /*
   * The comprobante somebody has asked to remove, waiting on a second press.
   *
   * The same guard the contract documents have, and for the same reason: the
   * remove control lives in a viewer that is opened to LOOK at things, so the
   * press that destroys a file must never be the press that was aimed at
   * dismissing one.
   */
  const [pendingRemoval, setPendingRemoval] = useState<ViewerFile | null>(null);
  const [proofBusy, setProofBusy] = useState<string | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const proofInputRef = useRef<HTMLInputElement>(null);

  /*
   * Google's scripts are fetched when the tab opens rather than on the click,
   * so the consent popup opens inside the click that asked for it — from the
   * panel's button and from any row's square alike. See `preloadGoogleDrive`.
   */
  useEffect(preloadGoogleDrive, []);

  /*
   * Ends a drag wherever the mouse comes back up — not just over a box, but
   * anywhere on the page. Without this, releasing past the edge of the list
   * would leave the drag armed, and the next unrelated click would paint as
   * though it were still part of it.
   *
   * Deferred a tick on purpose. `mouseup` always fires before the `click` it
   * turns into, so clearing the ref here right away would erase `painted`
   * before `handleCheckClick` — which runs from that click — ever gets to
   * read it, and a drag that ended back on its own starting box would count
   * as a plain click and flip it again. Pushing the clear to a macrotask lets
   * that click, when there is one, go first; when there is none — mouseup
   * over a different box than mousedown started on — nothing was waiting on
   * it and the ref is simply freed a moment later.
   */
  useEffect(() => {
    const endDrag = () => {
      setTimeout(() => {
        dragRef.current = null;
      }, 0);
    };

    window.addEventListener("mouseup", endDrag);
    return () => window.removeEventListener("mouseup", endDrag);
  }, []);

  /*
   * The receipt as a PNG, prepared as soon as one is opened.
   *
   * Rendered ahead of the button rather than on the press of it, and that is a
   * correctness thing rather than a speed one. `navigator.share` only works
   * while the browser still believes it is inside a user gesture, and Safari
   * stops believing it across an await that takes a few hundred milliseconds —
   * which rasterising an A4 document does. Rendering first means the click has
   * a file in hand and shares immediately.
   *
   * The pleasant side effect is that Enviar is instant, which is the whole
   * point of the feature: the customer is standing at the window.
   */
  const [shareImage, setShareImage] = useState<File | null>(null);
  const [isSharing, setSharing] = useState(false);
  /*
   * What to tell the user after pressing Enviar.
   *
   * Not just errors. On a phone the share sheet appears and needs no words, but
   * on a desktop what happens is that the image lands on the clipboard and a
   * chat opens — and nobody guesses that unless it is said. `chatUrl` is set
   * only when this screen could not open the chat itself, so the message can
   * offer it as a link instead of opening a second tab a blocker would eat.
   */
  const [shareNote, setShareNote] = useState<
    { tone: "info" | "error"; text: string; chatUrl?: string } | null
  >(null);
  const shareStageRef = useRef<HTMLDivElement>(null);

  /*
   * On a phone the receipt is a SCREEN, not a column.
   *
   * Side by side, the list and the document are two panes and picking a row
   * fills the one next to it. Stacked, the same arrangement puts the receipt —
   * and Imprimir and Anular with it — underneath every transaction in the list,
   * so printing the receipt somebody just tapped means scrolling past a hundred
   * rows to reach the button. The document is what the tab is FOR; it cannot be
   * the part you have to go looking for.
   *
   * So on a phone, tapping a transaction opens the receipt over the list
   * instead of below it. The list is covered rather than unmounted, which is
   * what keeps its scroll position: going back puts the user on the row they
   * tapped rather than at the top of the list.
   *
   * `useIsMobile` rather than a media query alone because the difference is
   * structural — a back button that exists on one and not the other — and it is
   * the one place the breakpoint is defined, so JavaScript and the stylesheet
   * cannot disagree about where a phone ends.
   */
  const isMobile = useIsMobile();
  const isSheetOpen = isMobile && selectedReceiptId !== null;

  // Two permissions, not one. Reversing writes a visible counter-entry;
  // correcting rewrites a posted figure in place. See routes/transactions.ts.
  const canEdit = can(user, "payment:edit");
  const canVoid = can(user, "payment:reverse");

  /*
   * The receipt currently being re-split across lots, if any.
   *
   * Behind `payment:edit` rather than `payment:record`: moving money that is
   * already posted and already printed is the same act, and the same trust, as
   * correcting a transaction's amount. See POST /receipts/:id/redistribute.
   */
  const [receiptBeingSplit, setReceiptBeingSplit] = useState<Receipt | null>(null);
  // Attaching the proof behind a payment is part of recording it, so it rides
  // on the same capability rather than inventing a third.
  const canRecord = can(user, "payment:record");

  const projectNames = useMemo(
    () => [...new Set(transactions.map((t) => t.projectName))].sort((a, b) => a.localeCompare(b, "es")),
    [transactions],
  );

  const visible = useMemo(
    () => sortTransactions(filterTransactions(searchTransactions(transactions, search), filters), sort),
    [transactions, search, filters, sort],
  );

  const groups = useMemo(() => groupByCustomer(visible, sort), [visible, sort]);

  /*
   * The rows a selection may contain: on screen, and still counting.
   *
   * A reversed payment is out of the accounts — see the filter default in
   * transactionFilters.ts — so it can be looked at but never summed. Every
   * selection gesture reads this rather than `visible`, which keeps the ranges
   * a shift-click or a drag spans in step with the boxes that actually respond.
   */
  const selectable = useMemo(
    () => visible.filter((transaction) => transaction.reversedAt === null),
    [visible],
  );

  /*
   * The same rows, in the order the screen is actually showing them.
   *
   * `selectable` is the flat, date-sorted list, which is what the Fecha view
   * renders — but the Cliente view renders one folded block per customer, so
   * two rows that look adjacent under "Ana" can be four hundred apart in date
   * order. A shift-click or a drag between them would then span every payment
   * made in between, by everybody, which is not what was pointed at.
   *
   * Collapsed groups contribute nothing: their rows are not on screen, so
   * there is nothing there to drag across and nothing to pull in as a sibling.
   */
  const selectionOrder = useMemo(() => {
    if (view === "date") {
      return selectable;
    }

    return groups.flatMap((group) =>
      expanded.has(group.customerId)
        ? group.transactions.filter((transaction) => transaction.reversedAt === null)
        : [],
    );
  }, [view, selectable, groups, expanded]);

  /*
   * Drop anything the search or the filters have taken off screen.
   *
   * Without this the selection keeps ids nobody can see: the sum is computed
   * from what is visible, so it shrinks to nothing and the bar carrying
   * "Limpiar selección" disappears with it — leaving rows checked, no figures,
   * and no control to clear them until the original search is typed back in.
   *
   * `current` is returned unchanged when nothing was pruned, so this settles in
   * one pass instead of scheduling itself forever.
   */
  useEffect(() => {
    setCheckedIds((current) => {
      if (current.size === 0) {
        return current;
      }

      const onScreen = new Set(selectable.map((transaction) => transaction.id));
      const next = new Set<string>();

      for (const id of current) {
        if (onScreen.has(id)) {
          next.add(id);
        }
      }

      return next.size === current.size ? current : next;
    });
  }, [selectable]);

  // Selecting a transaction shows its receipt. One without a receipt clears the
  // panel rather than leaving the previous customer's document on screen beside
  // a row it has nothing to do with.
  useEffect(() => {
    if (selectedReceiptId === null) {
      setDetail(null);
      return;
    }

    // A newer request can resolve before an older one; `cancelled` makes the
    // outdated response drop itself instead of overwriting the current sheet.
    let cancelled = false;
    setLoadingDetail(true);

    fetchReceipt(selectedReceiptId)
      .then((receipt) => {
        if (!cancelled) {
          setDetail(receipt);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetail(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingDetail(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedReceiptId, transactions]);

  /*
   * Rasterise the offscreen copy whenever the receipt on screen changes.
   *
   * Keyed on the receipt's id and its voided state rather than on the object,
   * so re-reading the same receipt after somebody else's write — which
   * lib/liveUpdates.ts now makes routine — does not throw away a perfectly good
   * image and render it again. Voiding it must, because the document grows an
   * ANULADO banner and the old picture no longer tells the truth.
   *
   * A failure here is deliberately silent. Nothing on screen is wrong; the one
   * button that depends on it simply stays out of reach, and says so.
   */
  const shareKey = detail === null ? null : `${detail.id}:${detail.voidedAt ?? ""}`;

  useEffect(() => {
    setShareImage(null);
    setShareNote(null);

    if (detail === null) {
      return;
    }

    let cancelled = false;

    // One frame, so the stage below is laid out before it is measured. Reading
    // `offsetHeight` off a node React has only just mounted gives zero.
    const frame = requestAnimationFrame(() => {
      const stage = shareStageRef.current;

      if (stage === null) {
        return;
      }

      receiptToPng(stage, detail.code)
        .then((file) => {
          if (!cancelled) {
            setShareImage(file);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setShareNote({
              tone: "error",
              text: "Could not prepare the receipt image.",
            });
          }
        });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareKey]);

  /*
   * Hand the receipt to WhatsApp, and say what happened.
   *
   * Which of the three routes runs is decided by the device, not here — see
   * whatsapp.ts. What this owns is the sentence afterwards, because two of the
   * three leave a step for the person to finish and an unexplained new tab is
   * indistinguishable from a bug.
   */
  const share = async () => {
    const phone = detail?.customer.phone ?? null;

    if (detail === null || shareImage === null || phone === null) {
      return;
    }

    setSharing(true);
    setShareNote(null);

    try {
      const outcome = await sendReceiptOnWhatsApp(shareImage, receiptCaption(detail), phone);

      if (outcome.status === "copied") {
        setShareNote({
          tone: "info",
          text: `Opened the chat with ${detail.customer.fullName}. ${pasteInstruction()}`,
        });
      } else if (outcome.status === "manual") {
        const gesture = copyGesture();

        // Neither the clipboard nor the share sheet was available, so the
        // receipt is shown HERE to be copied by hand. Opening it in the app's
        // own viewer rather than a new tab is the point: a blob in a tab is
        // saved to disk by several browsers, and eaten by popup blockers in the
        // rest.
        openReceiptImage();

        setShareNote({
          tone: "info",
          /*
           * "insecure" is worth its own sentence. This device can almost
           * certainly do better — an Android phone on HTTPS gets the share
           * sheet — and without being told, the fallback reads as the feature
           * being broken rather than as the address bar being http://.
           */
          text:
            outcome.reason === "insecure"
              ? `This page is open over HTTP, and browsers only allow sharing over HTTPS. Open it over HTTPS and this button will send the receipt directly. For now, the receipt is open here: ${gesture}.`
              : `The receipt is open here. ${gesture[0]!.toUpperCase()}${gesture.slice(1)}.`,
          chatUrl: outcome.chatUrl,
        });
      }
      // "shared" and "cancelled" need no words: the share sheet either appeared
      // and was used, or appeared and was dismissed. Both are self-evident.
    } catch {
      setShareNote({ tone: "error", text: "Could not open WhatsApp." });
    } finally {
      setSharing(false);
    }
  };

  /*
   * The rendered receipt, addressable by the viewer.
   *
   * A `blob:` URL for the PNG that has already been rasterised for WhatsApp —
   * the same bytes, shown rather than sent. Revoked when the receipt changes,
   * because an object URL is held by the document until it is: without this,
   * clicking through thirty receipts leaves thirty full-page images in memory.
   *
   * This is what "Ver" opens. It used to be that the only way to see the
   * receipt at full size was the fallback path in whatsapp.ts, which opened a
   * blob in a new tab — and in several browsers a new tab pointed at an image
   * blob saves it instead of showing it. The document now stays inside Lindero.
   */
  const [shareImageUrl, setShareImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (shareImage === null) {
      setShareImageUrl(null);
      return;
    }

    const url = URL.createObjectURL(shareImage);
    setShareImageUrl(url);

    return () => URL.revokeObjectURL(url);
  }, [shareImage]);

  /**
   * Show the rendered receipt, full size, inside the app.
   *
   * Shared by the Ver button and by the last-resort branch of Enviar, so the
   * document appears in exactly one place however it was asked for.
   */
  const openReceiptImage = () => {
    if (detail === null || shareImageUrl === null) {
      return;
    }

    setViewing({ source: "receipt" });
  };

  /** Every comprobante on the open receipt, labelled with the lot it belongs to. */
  const detailProofs: ViewerFile[] = useMemo(() => {
    if (detail === null) {
      return [];
    }

    return detail.attachments.map((file) =>
      storedProof(
        file,
        detail.lines.find((line) => line.paymentId === file.paymentId)?.lotCode ?? null,
      ),
    );
  }, [detail]);

  /**
   * Save the note on the open receipt.
   *
   * The server answers with the receipt as it now stands, so the panel updates
   * without a second round trip; the list is told to re-read so the row's
   * "Nota" chip appears, changes or goes in step with it. A refusal rejects,
   * and `ReceiptNote` shows the server's own sentence.
   */
  const saveNote = async (note: string | null) => {
    if (detail === null) {
      return;
    }

    setDetail(await updateReceiptNote(detail.id, note));
    onProofsChanged();
  };

  /** Re-read the receipt, and the list behind it, after the files change. */
  const refreshAfterProofChange = async (receiptId: string) => {
    try {
      setDetail(await fetchReceipt(receiptId));
    } catch {
      // The write succeeded; only the re-read did not. The parent reload below
      // gets a second chance at it, and the panel is not wrong meanwhile.
    }

    onProofsChanged();
  };

  /**
   * Attach more comprobantes to a receipt that already exists.
   *
   * The validation is `acceptProofFiles`, the same function the new-receipt
   * dropzone uses, so a file refused there is refused here for the same reason
   * in the same words. What differs is the timing: there is a receipt to belong
   * to already, so these upload immediately rather than waiting for a save.
   */
  const addProofs = async (incoming: FileList | File[] | null) => {
    if (detail === null || incoming === null || incoming.length === 0) {
      return;
    }

    setProofError(null);

    const { accepted, rejections } = acceptProofFiles(
      Array.from(incoming),
      detail.attachments.length,
      MAX_PROOFS,
    );

    if (rejections.length > 0) {
      setProofError(rejections[0]!);
    }

    for (const proof of accepted) {
      setProofBusy(`Uploading ${proof.file.name}…`);

      try {
        await uploadAttachment(detail.id, proof.file);
      } catch (caught) {
        setProofError(
          caught instanceof Error ? caught.message : "Could not upload the proof file.",
        );
      }

      // Held only to validate and to name the file; nothing here previews it,
      // so the object URL would otherwise leak one image per upload.
      URL.revokeObjectURL(proof.previewUrl);
    }

    setProofBusy(null);

    if (accepted.length > 0) {
      await refreshAfterProofChange(detail.id);
    }
  };

  /*
   * From Google Drive instead. Everything after the download is `addProofs`,
   * and Drive's own complaints are shown only when the upload had none — see
   * `useProofAttach` for why the order matters.
   */
  const pickFromDrive = async () => {
    if (detail === null) {
      return;
    }

    setProofError(null);
    setProofBusy("Abriendo Google Drive…");

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
   * Dropping is the same act as choosing, so it goes through the same
   * function — the rules, the sequential upload and the re-read afterwards all
   * live in `addProofs` already.
   */
  const { isDraggingOver, dropHandlers } = useFileDrop(
    (files) => void addProofs(files),
    proofBusy !== null,
  );

  /**
   * Actually remove it. Only ever reached from the confirmation dialog.
   *
   * Throws rather than swallowing, so `ConfirmDialog` can stay open and show
   * what went wrong — a prompt that closes on a failed delete looks exactly
   * like one that closed on a successful delete.
   */
  const removeProof = async (attachmentId: string) => {
    if (detail === null) {
      return;
    }

    setProofError(null);
    setProofBusy("Removing proof file…");

    try {
      await deleteAttachment(attachmentId);
      /*
       * The viewer stays open, and re-reads.
       *
       * `refreshAfterProofChange` re-fetches the receipt, `detailProofs` is
       * derived from it, and the viewer reads that list on every render — so
       * the removed file simply leaves the strip and the neighbour takes its
       * place. Removing several in a row is one gesture repeated rather than
       * open-delete-close-reopen. The viewer closes itself once the last one
       * is gone.
       */
      await refreshAfterProofChange(detail.id);
    } finally {
      setProofBusy(null);
    }
  };

  /*
   * What the viewer is actually showing, resolved from the source.
   *
   * Derived rather than stored, so the panel's comprobantes re-read themselves
   * while the viewer is open — which is what makes deleting several in a row
   * one gesture, and what stops a teammate's write leaving a dead URL on
   * screen. Null when there is nothing to show, including the case where every
   * file has just been removed.
   */
  const viewerFiles = useMemo((): { files: ViewerFile[]; startId: string } | null => {
    if (viewing === null) {
      return null;
    }

    if (viewing.source === "row") {
      return { files: viewing.files, startId: viewing.startId };
    }

    if (viewing.source === "proofs") {
      return detailProofs.length === 0
        ? null
        : { files: detailProofs, startId: viewing.startId };
    }

    if (detail === null || shareImageUrl === null) {
      return null;
    }

    const id = `receipt-${detail.id}`;

    return {
      files: [
        {
          id,
          name: `Receipt ${detail.code}`,
          contentType: "image/png",
          url: shareImageUrl,
          caption: detail.customer.fullName,
        },
      ],
      startId: id,
    };
  }, [viewing, detailProofs, detail, shareImageUrl]);

  /*
   * Nothing left to show means nothing left open.
   *
   * `viewerFiles` goes null when the last comprobante on the receipt is
   * removed, or when the receipt it was showing is closed. Without this the
   * viewer would merely stop rendering while `viewing` still said it was open,
   * and attaching a new file afterwards would make it reappear unasked.
   */
  useEffect(() => {
    if (viewing !== null && viewerFiles === null) {
      setViewing(null);
    }
  }, [viewing, viewerFiles]);

  const toggleCustomer = (customerId: string) => {
    setExpanded((current) => {
      const next = new Set(current);

      if (next.has(customerId)) {
        next.delete(customerId);
      } else {
        next.add(customerId);
      }

      return next;
    });
  };

  /*
   * Open this row's receipt, or close it if it is the one already open.
   *
   * Compared by RECEIPT rather than by row, which is what makes a receipt
   * covering three lots behave like the single document it is: whichever of
   * its three rows opened it, any of the three closes it. A first click that
   * opens and a second that does nothing is how a preview ends up stuck on
   * screen with no obvious way to dismiss it.
   */
  const select = (transaction: Transaction) =>
    setSelectedReceiptId((current) =>
      current !== null && current === transaction.receiptId ? null : transaction.receiptId,
    );

  /*
   * Shift-click extends the checked set to every row between the anchor and
   * this one; a plain click toggles just the row it landed on, and nothing
   * else — see `toggleOne` for why a receipt with several lots is no longer
   * pulled in whole. Both read `selectionOrder` at click time, so the range
   * always spans what is actually on screen, in the order the screen is
   * showing it.
   *
   * Skipped when a drag already painted this gesture — see `dragRef` — so
   * the click that fires on mouseup does not flip the box a second time.
   */
  const handleCheckClick = (transactionId: string, shiftKey: boolean) => {
    const alreadyPainted = dragRef.current?.painted === true;
    dragRef.current = null;

    if (alreadyPainted) {
      return;
    }

    if (shiftKey && lastCheckedId !== null) {
      setCheckedIds((current) => {
        const next = new Set(current);

        for (const id of idsBetween(selectionOrder, lastCheckedId, transactionId)) {
          next.add(id);
        }

        return next;
      });
    } else {
      setCheckedIds((current) => toggleOne(current, transactionId));
    }

    setLastCheckedId(transactionId);
  };

  /*
   * Arms a possible drag on mousedown, and decides its direction here rather
   * than per row: a drag that starts on an unchecked box selects the whole way,
   * one that starts on a checked box deselects the whole way. Nothing is
   * painted yet — a plain click with no movement in between must produce
   * exactly one toggle, not one here and one more from `handleCheckClick`.
   */
  const handleCheckMouseDown = (transactionId: string) => {
    dragRef.current = {
      anchorId: transactionId,
      mode: checkedIds.has(transactionId) ? "remove" : "add",
      before: checkedIds,
      painted: false,
    };
  };

  /*
   * The pointer has entered a box while the primary button is held — a real
   * drag, as opposed to a click that never left its row.
   *
   * The whole selection is recomputed from the snapshot on every row crossed,
   * so this is also what handles the pointer coming BACK: the range shrinks and
   * the rows it no longer covers return to whatever they were before the
   * gesture started. A drag that begins and ends on the same box without ever
   * crossing another never reaches this at all, and is left for
   * `handleCheckClick` to treat as the plain click it is.
   */
  const handleCheckMouseEnter = (transactionId: string) => {
    const drag = dragRef.current;

    if (drag === null) {
      return;
    }

    drag.painted = true;

    setCheckedIds(
      paintedByDrag(selectionOrder, drag.before, drag.anchorId, transactionId, drag.mode),
    );
    setLastCheckedId(transactionId);
  };

  const clearChecked = () => {
    setCheckedIds(new Set());
    setLastCheckedId(null);
    dragRef.current = null;
  };

  /*
   * Everything the current search and filters let through, in one press.
   *
   * Deliberately NOT every transaction in the database: the figures beside it
   * are the sum of what is on screen, and a "seleccionar todo" that quietly
   * reached past the filters would put a number there that no visible set of
   * rows adds up to.
   */
  const selectAll = () => {
    setCheckedIds(new Set(selectionOrder.map((transaction) => transaction.id)));
    setLastCheckedId(null);
    dragRef.current = null;
  };

  // Filtered through `visible` rather than summed straight from the ids: a row
  // that scrolled out of the current search or filters must not go on padding
  // a total nobody can see the rows for.
  const checkedTransactions = selectable.filter((transaction) => checkedIds.has(transaction.id));
  const checkedSum = cents(
    checkedTransactions.reduce((sum, transaction) => sum + transaction.amount, 0),
  );
  const checkedAverage =
    checkedTransactions.length === 0 ? cents(0) : cents(Math.round(checkedSum / checkedTransactions.length));
  const checkedReceipts = countReceipts(checkedTransactions);

  /*
   * A selection spanning several receipts puts the panel away.
   *
   * The preview answers "which receipt is this", and once the selection covers
   * four of them there is no honest answer — leaving one of the four on screen
   * beside a total drawn from all of them is how somebody reads a figure off
   * the document that the figures beside it do not describe. Selecting a single
   * receipt, lots and all, leaves it up: there the document is exactly what was
   * picked.
   *
   * It does not come back when the selection is cleared. The panel opens on a
   * deliberate click on a row and on nothing else, which is one rule instead of
   * a remembered state that reappears a minute later with no gesture behind it.
   */
  useEffect(() => {
    if (checkedReceipts > 1) {
      setSelectedReceiptId(null);
    }
  }, [checkedReceipts]);

  return (
    <div className="receipts-layout">
      {/* `is-selecting` while anything is checked: mid-selection every row
          shows its box, not just the one under the pointer. See `.txn-check`. */}
      <div className={`card txn-list${checkedTransactions.length > 0 ? " is-selecting" : ""}`}>
        <div className="card-head">
          <h2>Transactions</h2>
        </div>

        <TransactionToolbar
          view={view}
          onViewChange={setView}
          projectNames={projectNames}
          filters={filters}
          onFiltersChange={setFilters}
          sort={sort}
          onSortChange={setSort}
          search={search}
          onSearchChange={setSearch}
          shownCount={visible.length}
          // What the list holds before the search and the filters narrow it —
          // NOT every row in the database. See `transactionsInScope`.
          totalCount={transactionsInScope(transactions, filters)}
        />

        {/* Clipped to the card's rounded bottom corners separately from the
            card itself, so the sort/filter popover above can float past the
            card's own edge instead of being cut off when the card is short.
            See `.txn-list-body` in styles.css. */}
        <div className="txn-list-body">
          {checkedTransactions.length > 0 && (
            <SelectionSummaryBar
              count={checkedTransactions.length}
              receiptCount={checkedReceipts}
              sumCents={checkedSum}
              averageCents={checkedAverage}
              money={money}
              selectableCount={selectionOrder.length}
              onSelectAll={selectAll}
              onClear={clearChecked}
            />
          )}

          {visible.length === 0 && (
            <p className="state-message">
              {transactions.length === 0
                ? "No transactions have been recorded yet."
                : "No transactions match your search."}
            </p>
          )}

          {view === "date" &&
            visible.map((transaction) => (
              <TransactionRow
                key={transaction.id}
                transaction={transaction}
                money={money}
                isSelected={
                  transaction.receiptId !== null && transaction.receiptId === selectedReceiptId
                }
                canEdit={canEdit}
                onSelect={() => select(transaction)}
                onEdit={() => onEditTransaction(transaction)}
                onOpenProof={(files, startId) => setViewing({ source: "row", files, startId })}
                canAttachProof={canRecord}
                onProofsChanged={onProofsChanged}
                showCustomer
                isChecked={checkedIds.has(transaction.id)}
                canCheck={transaction.reversedAt === null}
                onCheckMouseDown={() => handleCheckMouseDown(transaction.id)}
                onCheckMouseEnter={() => handleCheckMouseEnter(transaction.id)}
                onCheckClick={(shiftKey) => handleCheckClick(transaction.id, shiftKey)}
              />
            ))}

          {view === "customer" &&
            groups.map((group) => {
              const isOpen = expanded.has(group.customerId);

              return (
                <div key={group.customerId} className="txn-group">
                  <button
                    type="button"
                    className={`txn-group-head${isOpen ? " is-open" : ""}`}
                    aria-expanded={isOpen}
                    onClick={() => toggleCustomer(group.customerId)}
                  >
                    <span className={`txn-caret${isOpen ? " is-open" : ""}`}>
                      <IconChevronDown />
                    </span>

                    <span className="txn-who">
                      <span className="txn-name">{group.customerName}</span>
                      <span className="txn-detail">
                        {group.transactions.length} transaction
                        {group.transactions.length === 1 ? "" : "s"} · last{" "}
                        {shortDate(group.lastPaidOn)}
                      </span>
                      {group.hasAmendment && (
                        <span
                          className="stamp neutral txn-amendment-badge"
                          title="One of this customer's contracts was replaced by an amendment"
                        >
                          Adenda
                        </span>
                      )}
                    </span>

                    <span className="txn-amount">
                      {formatMoney(cents(group.totalCents), money)}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="txn-group-body">
                      {group.byContract.length > 1 && (
                        <div className="txn-contract-breakdown">
                          {group.byContract.map((entry) => {
                            const presentation = STATUS_PRESENTATION[entry.contractStatus];

                            return (
                              <div key={entry.contractId} className="txn-contract-breakdown-row">
                                <span className="txn-contract-breakdown-code">
                                  {entry.contractCode}
                                </span>
                                <span className={presentation.stampClass}>
                                  {presentation.label}
                                </span>
                                <span className="txn-contract-breakdown-amount">
                                  {formatMoney(cents(entry.totalCents), money)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {group.transactions.map((transaction) => (
                        <TransactionRow
                          key={transaction.id}
                          transaction={transaction}
                          money={money}
                          isSelected={
                            transaction.receiptId !== null &&
                            transaction.receiptId === selectedReceiptId
                          }
                          canEdit={canEdit}
                          onSelect={() => select(transaction)}
                          onEdit={() => onEditTransaction(transaction)}
                          onOpenProof={(files, startId) =>
                            setViewing({ source: "row", files, startId })
                          }
                          canAttachProof={canRecord}
                          onProofsChanged={onProofsChanged}
                          showCustomer={false}
                          isChecked={checkedIds.has(transaction.id)}
                          canCheck={transaction.reversedAt === null}
                          onCheckMouseDown={() => handleCheckMouseDown(transaction.id)}
                          onCheckMouseEnter={() => handleCheckMouseEnter(transaction.id)}
                          onCheckClick={(shiftKey) => handleCheckClick(transaction.id, shiftKey)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </div>

      <div className={`receipt-preview-wrap${isSheetOpen ? " is-sheet" : ""}`}>
        {isSheetOpen ? (
          /* Named for where it goes back TO, not for the act of going back:
             "Transacciones" answers the question the arrow raises. Rendered
             whatever the receipt does — while it loads and if it fails — so a
             receipt that will not open can never trap somebody on this screen. */
          <div className="receipt-sheet-head">
            <button
              type="button"
              className="receipt-sheet-back"
              onClick={() => setSelectedReceiptId(null)}
            >
              <span className="receipt-sheet-back-icon">
                <IconChevronDown />
              </span>
              Transactions
            </button>
          </div>
        ) : (
          <p className="receipt-preview-label">Receipt preview</p>
        )}

        {detail === null && !isLoadingDetail && (
          <p className="state-message">
            {selectedReceiptId === null
              ? "Select a transaction to view its receipt. Items marked “no receipt” were never printed."
              : "Could not load the receipt."}
          </p>
        )}

        {isLoadingDetail && detail === null && <p className="state-message">Loading…</p>}

        {detail && (
          <>
            {/* Above the paper, not down with the comprobantes: the paper is a
                full sheet tall, and a message left for the next reader is no
                use at the bottom of that scroll. */}
            <ReceiptNote
              key={detail.id}
              receipt={detail}
              canWrite={canRecord}
              onSave={saveNote}
            />

            <div className="receipt-actions">
              <div className="receipt-actions-main">
                {/* The document at full size, inside Lindero. The preview
                    beside the list is 320px of a sidebar and folds itself to
                    fit; this is the A4 sheet the customer would be handed. */}
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={shareImageUrl === null}
                  onClick={openReceiptImage}
                >
                  Ver
                </button>

                <button type="button" className="btn-secondary" onClick={() => window.print()}>
                  Print
                </button>

                {/* The document itself, not a description of it — see
                    whatsapp.ts. Disabled rather than hidden while the image is
                    being prepared, so the control does not appear a moment
                    after somebody has looked for it and given up. Also
                    disabled — with its own reason in the tooltip — when the
                    customer has no phone on file, same as the Escribir
                    buttons on Contratos. See `contactCustomer.ts`. */}
                <button
                  type="button"
                  className="btn-secondary receipt-send"
                  disabled={shareImage === null || isSharing || detail.customer.phone === null}
                  onClick={() => void share()}
                  title={
                    detail.customer.phone === null
                      ? "This customer has no phone number on file"
                      : `Send the receipt to ${detail.customer.fullName} on WhatsApp`
                  }
                >
                  <IconWhatsApp />
                  {shareImage === null && shareNote?.tone !== "error"
                    ? "Preparando…"
                    : isSharing
                      ? "Enviando…"
                      : "Send"}
                </button>
              </div>

              {canEdit && detail.voidedAt === null && detail.lines.length > 0 && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setReceiptBeingSplit(detail)}
                  title="Move part of this receipt to another lot belonging to the same customer"
                >
                  Repartir
                </button>
              )}

              {canVoid && detail.voidedAt === null && (
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => onVoidReceipt(detail)}
                >
                  Anular
                </button>
              )}
            </div>

            <ReceiptPaper receipt={detail} money={money} />
            <div className="receipt-tear" />

            {/*
              The evidence, beside the document rather than on it.

              It used to be printed under the note on `ReceiptPaper`, which put
              the customer's own bank slip into the PNG sent back to them over
              WhatsApp. It belongs here: a receipt is what the office issues,
              and a comprobante is what the office keeps.
            */}
            <div className="receipt-proofs">
              <div className="receipt-proofs-head">
                <p className="receipt-preview-label">Customer payment proofs</p>
              </div>

              {/* The same zone the receipt form and the correction dialog
                  offer. Three screens can attach a comprobante and the gesture
                  has to be one gesture — a picker here and a drag there is how
                  somebody concludes the app "sometimes" takes dropped files. */}
              {canRecord && detail.attachments.length < MAX_PROOFS && (
                <div
                  className={`proof-dropzone is-compact${isDraggingOver ? " is-over" : ""}${
                    proofBusy ? " is-disabled" : ""
                  }`}
                  {...dropHandlers}
                >
                  <p className="proof-dropzone-title">Drop the proof file here</p>
                  <p className="proof-dropzone-hint">
                    The deposit screenshot, straight from WhatsApp.
                  </p>

                  <div className="proof-dropzone-actions">
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={proofBusy !== null}
                      onClick={() => proofInputRef.current?.click()}
                    >
                      Elegir archivo
                    </button>

                    {googleDriveConfigured() && (
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={proofBusy !== null}
                        onClick={() => void pickFromDrive()}
                      >
                        Desde Google Drive
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Only where there is no dropzone above already saying it by
                  being empty. */}
              {detail.attachments.length === 0 && !canRecord && (
                <p className="state-message">No proof files are attached to this receipt.</p>
              )}

              {/* The zone is gone and the reason is not obvious: without this,
                  being at the limit looks exactly like having lost the
                  permission to attach. */}
              {canRecord && detail.attachments.length >= MAX_PROOFS && (
                <p className="state-message">
                  This receipt already has the maximum of {MAX_PROOFS} proof files. Remove one to
                  add another.
                </p>
              )}

              {detail.attachments.length > 0 && (
                <div className="proof-grid">
                  {detailProofs.map((file) => (
                    <button
                      key={file.id}
                      type="button"
                      className="proof-tile"
                      onClick={() => setViewing({ source: "proofs", startId: file.id })}
                      title={`View ${file.name}`}
                    >
                      <DocumentThumb file={file} />
                      <span className="proof-tile-name">{file.name}</span>
                      {file.caption && <span className="proof-tile-lot">{file.caption}</span>}
                    </button>
                  ))}
                </div>
              )}

              {proofBusy && <p className="state-message">{proofBusy}</p>}
              {proofError && <p className="form-error">{proofError}</p>}

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
                  event.target.value = "";
                }}
              />
            </div>

            {shareNote && (
              <p className={`receipt-share-note${shareNote.tone === "error" ? " is-error" : ""}`}>
                {shareNote.text}
                {shareNote.chatUrl && (
                  <>
                    {" "}
                    <a href={shareNote.chatUrl} target="_blank" rel="noreferrer">
                      Abrir el chat de {detail.customer.fullName}
                    </a>
                  </>
                )}
              </p>
            )}

            {/*
              The copy that actually gets photographed.

              The receipt beside the list is 320px of a sidebar, and its own
              container queries fold it into a narrow layout to fit — rendering
              THAT would send the customer a tall thin strip. This one is laid
              out offscreen at A4 proportions with the print type size, so what
              arrives on their phone is the document they would have been handed
              across the counter. Same component, same stylesheet; only the box
              around it differs. See `.receipt-share-stage`.
            */}
            <div className="receipt-share-stage" ref={shareStageRef} aria-hidden="true">
              <ReceiptPaper receipt={detail} money={money} />
            </div>
          </>
        )}
      </div>

      {viewerFiles !== null && (
        <DocumentViewer
          files={viewerFiles.files}
          startId={viewerFiles.startId}
          onClose={() => setViewing(null)}
          /*
           * Removing is offered only for the open receipt's own comprobantes.
           *
           * Not for a thumbnail opened from a transaction ROW, whose files may
           * belong to a receipt that is not the one in the panel — deleting
           * there would leave the screen describing a receipt it had not
           * re-read. Not for the receipt IMAGE either: it is drawn from the
           * ledger every time it is opened, so there is nothing to remove.
           */
          onRemove={
            canRecord && viewing?.source === "proofs" ? setPendingRemoval : undefined
          }
        />
      )}

      {pendingRemoval !== null && (
        <ConfirmDialog
          eyebrow="Remove proof file"
          title={pendingRemoval.name}
          description={
            pendingRemoval.sizeBytes === undefined
              ? undefined
              : readableSize(pendingRemoval.sizeBytes)
          }
          confirmLabel="Remove proof file"
          busyLabel="Quitando…"
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

      {receiptBeingSplit !== null && (
        <ReceiptRedistributeDialog
          receipt={receiptBeingSplit}
          contracts={contracts}
          money={money}
          onClose={() => setReceiptBeingSplit(null)}
          onRedistributed={() => {
            setReceiptBeingSplit(null);
            // The panel re-reads itself off the reloaded transactions — see the
            // effect on `selectedReceiptId`.
            onLedgerChanged();
          }}
        />
      )}
    </div>
  );
}
