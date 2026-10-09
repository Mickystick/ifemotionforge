import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Dialog } from "../../components/Dialog";
import { DraftNotice } from "../../components/DraftNotice";
import { useFormDraft } from "../../lib/formDrafts";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import { ApiError } from "../../lib/api";
import { businessToday } from "../../lib/businessTime";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney, parseMoneyInput, toMoneyInput } from "../../lib/money";
import type { Contract, CustomerRecord, Receipt } from "../../types";
import { CustomerPicker } from "../contracts/ContractPartyPickers";
import type { PaymentType } from "./paymentType";
import {
  PAYMENT_TYPE_OPTIONS,
  outstandingDownPayment,
  sharedPaymentType,
  suggestPaymentType,
} from "./paymentType";
import type { PendingProof, ProofLot } from "./ProofDropzone";
import { MAX_PROOFS, ProofDropzone, acceptProofFiles } from "./ProofDropzone";
import type { ReceiptDraft, ReceiptDraftLine } from "./api";
import { createReceipt, fetchCustomerSplit, fetchDuplicates, uploadAttachment } from "./api";
import type { DuplicateMatch } from "./api";
import { AMOUNT_FIELD, CUSTOMER_FIELD, receiptBlocker } from "./receiptBlocker";

interface NewReceiptDialogProps {
  customers: CustomerRecord[];
  contracts: Contract[];
  money: MoneyView;
  onClose: () => void;
  onIssued: (receipt: Receipt) => void;
  /**
   * Comprobantes the form should open with already attached.
   *
   * Set when the dialog was opened by sharing an image from WhatsApp rather
   * than by pressing "Nuevo recibo" — see lib/sharedIntake.ts. They go through
   * exactly the same validation the dropzone applies, because the server's
   * rules do not soften for a file that arrived by a different route.
   */
  initialFiles?: File[];
  /**
   * A line to show above the form the moment it opens.
   *
   * Only used when a share arrived but carried no usable image — the worker
   * could not read it, or it was text only. It reuses the dialog's own error
   * line rather than introducing a notification system for one message, and it
   * is placed there deliberately: somebody who just shared a photo and finds
   * an empty dropzone needs the explanation where they are already looking.
   */
  initialNotice?: string;
}

type Method = "cash" | "transfer" | "card";

/*
 * What the Tipo field at the top shows when the lots below are on different
 * types.
 *
 * A reading, not a value: nothing is ever filed under it, and the option
 * carrying it is disabled so it cannot be picked on purpose. It exists so the
 * field can stay on screen for a multi-lot receipt without having to name one
 * of the lots' types and be wrong about the others.
 */
const MIXED = "mixed";

const METHODS: Array<{ value: Method; label: string }> = [
  { value: "cash", label: "Cash" },
  { value: "transfer", label: "Bank transfer" },
  { value: "card", label: "Card" },
];

/**
 * A key unique to one open form.
 *
 * `crypto.randomUUID` only exists in a SECURE context — https, or localhost.
 * Field staff reaching this app over plain http on a LAN address ("192.168.1.x")
 * would find it undefined, and the form would throw before it ever rendered.
 * That is the exact situation the idempotency key exists to protect, so it
 * cannot be the thing that breaks there.
 */
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const random = new Uint8Array(16);

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(random);
  } else {
    for (let index = 0; index < random.length; index += 1) {
      random[index] = Math.floor(Math.random() * 256);
    }
  }

  return Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Record a payment and issue its receipt.
 *
 * The shape of this form follows the shape of the money: ONE customer, ONE date
 * and ONE method at the top, then a line per lot underneath. That is not a
 * layout preference — it is what a receipt is. A customer holding three lots
 * hands over a single amount at a single window and expects a single piece of
 * paper, and the split across their contracts happens below the fold.
 *
 * Nothing here computes a balance. Every figure the customer will read is
 * derived by the server when the receipt is fetched back, so this form cannot
 * disagree with the document it produces — and the split, likewise, is proposed
 * by the server rather than worked out twice.
 */
export function NewReceiptDialog({
  customers,
  contracts,
  money,
  onClose,
  onIssued,
  initialFiles,
  initialNotice,
}: NewReceiptDialogProps) {
  const [customerId, setCustomerId] = useState("");
  /* The customer the amounts on screen were typed for. "Cambiar" clears the
     choice without clearing them, so re-picking the same person after a
     mis-tap keeps what was typed; picking somebody else does not. */
  const amountsCustomerRef = useRef("");
  const [paidOn, setPaidOn] = useState(businessToday);
  const [method, setMethod] = useState<Method>("cash");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  /*
   * What the customer handed over, as one figure.
   *
   * The whole receipt's amount, for one lot or for five. When there are
   * several, this is what "Repartir entre los lotes" divides into
   * `amountByContract`; when there is one, it IS that lot's amount and no
   * per-lot field exists to disagree with it.
   */
  const [amountText, setAmountText] = useState("");
  /** Only meaningful with several lots: how the amount above was divided. */
  const [amountByContract, setAmountByContract] = useState<Record<string, string>>({});
  /*
   * A type chosen by hand, per lot. The ONLY place a chosen type is kept.
   *
   * There is deliberately no second piece of state for the field at the top of
   * the form. That field reads this map — the shared value when the lots agree,
   * "Varios" when they do not — and writing to it sets every lot at once. State
   * of its own is exactly what would let it display "Cuota" while a line below
   * it filed a prima, and that is not a cosmetic difference: a prima recorded
   * as a cuota leaves `downPaymentPaid` short for the life of the contract, and
   * no screen says so.
   *
   * Per lot rather than per receipt because they genuinely disagree — somebody
   * who bought a second lot last month is settling its prima while still paying
   * cuotas on the first.
   *
   * A lot with no entry here follows `suggestPaymentType`. That absence is also
   * what keeps "nobody has touched this" apart from "somebody picked exactly
   * what was suggested": the first has to keep following the customer being
   * changed, the second has to survive it. The keys are contract ids and the
   * map is emptied when the customer changes, so both hold on their own.
   */
  const [typeByContract, setTypeByContract] = useState<Record<string, PaymentType>>({});
  const [proofs, setProofs] = useState<PendingProof[]>([]);
  const [error, setError] = useState<string | null>(null);
  /**
   * Whatever went wrong with the comprobante specifically — a share that
   * carried no image, a file the dropzone refused, an upload that failed
   * after the payment was already saved — kept apart from `error` so it can
   * be shown where it is actually about: right by the Comprobante field,
   * not wherever the form's general error banner happens to sit. See the
   * render below.
   */
  const [proofNotice, setProofNotice] = useState<string | null>(initialNotice ?? null);
  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);
  const [overpaymentPrompt, setOverpaymentPrompt] = useState<string | null>(null);
  const [splitNote, setSplitNote] = useState<string | null>(null);
  const [isSplitting, setSplitting] = useState(false);
  const [isSaving, setSaving] = useState(false);
  const [savingStep, setSavingStep] = useState<string | null>(null);

  /**
   * Minted once, for the life of this open form.
   *
   * It has to survive a failed attempt: if the first submission actually
   * reached the server and only the response was lost, the retry must carry the
   * SAME key or the money is taken twice — which is the exact failure the key
   * exists to prevent.
   */
  const [idempotencyKey] = useState(newIdempotencyKey);

  // Only what this person is actually paying on. A cancelled or defaulted
  // contract does not take money, and a paid-off one has nothing left to take.
  const payable = useMemo(
    () => contracts.filter((contract) => contract.customer.id === customerId && contract.status === "active"),
    [contracts, customerId],
  );

  const isMultiLot = payable.length > 1;

  /*
   * What kind of money this lot is receiving: what somebody picked for it, or
   * failing that what the contract itself implies.
   */
  const typeFor = (contract: Contract): PaymentType =>
    typeByContract[contract.id] ?? suggestPaymentType(contract);

  /** The lot the top field speaks for, when there is exactly one. */
  const soleLot = payable.length === 1 ? payable[0]! : null;

  /*
   * The one type every lot is on, or `null` when they differ.
   *
   * What the field at the top displays — DERIVED, so it can only ever show a
   * type the lines below are really using. `null` is the honest answer for a
   * receipt settling a prima on one lot and paying a cuota on another, and the
   * field renders it as "Varios" rather than picking a side.
   *
   * With no customer chosen there are no lots to read, so it falls back to the
   * same default the form has always opened on.
   */
  const sharedType: PaymentType | null =
    payable.length === 0 ? "installment" : sharedPaymentType(payable.map(typeFor));

  /*
   * Put one type on every lot at once.
   *
   * What the field at the top does when it is changed, and the reason changing
   * it can never be a lie: afterwards the lots agree, so the value on screen is
   * the value in use. Every lot is written explicitly rather than left to fall
   * back, because "all of them are cuotas" is a decision somebody made and it
   * has to survive a lot whose contract would have suggested otherwise.
   *
   * A single-lot receipt goes through here too — the same control doing the
   * same thing to a shorter list.
   */
  const applyTypeToAll = (next: PaymentType) =>
    setTypeByContract(Object.fromEntries(payable.map((contract) => [contract.id, next])));

  /** Near-proof, rather than a coincidence of amount and day. */
  const hasReferenceMatch = duplicates.some((match) => match.reason === "reference");

  /*
   * Object URLs live until revoked, so the form releases them when it closes.
   *
   * Through a ref rather than reading `proofs` directly. An unmount cleanup
   * with an empty dependency array closes over the FIRST render's value — an
   * empty array here — so the previous version revoked nothing at all and
   * every attached image stayed in memory for the life of the page. The ref is
   * re-pointed on every render, so the cleanup always sees what is actually
   * held at the moment of closing.
   */
  const proofsRef = useRef(proofs);
  proofsRef.current = proofs;

  /*
   * Attach the files the form was opened with — shared in from WhatsApp, or
   * dropped anywhere on the window. See lib/sharedIntake.ts and useFileDrop.ts.
   *
   * A LAYOUT effect, and that is the entire point of it. This used to seed
   * `proofs` from a lazy `useState` initialiser so the thumbnail landed in the
   * same paint as the form, which reads as instant — but that creates the
   * object URLs during RENDER, while the only thing that revokes them is the
   * unmount cleanup below. The two are then not symmetric, and React's
   * development StrictMode mounts, unmounts and remounts every component
   * precisely to catch that: the cleanup ran, the URLs it revoked were the ones
   * held in state, and a `useState` initialiser does not re-run on the remount.
   * The form came back up holding a revoked `blob:` URL, so the comprobante it
   * had just accepted could not be previewed — "el navegador no puede
   * mostrarlo aquí" — while the identical file added through the dropzone a
   * second later was fine, because that URL is created in an event handler and
   * nothing had unmounted since.
   *
   * Creating them HERE makes the pair symmetric: whatever this effect creates,
   * its own cleanup revokes, and a remount creates fresh ones. `useLayoutEffect`
   * rather than `useEffect` keeps what the initialiser was for — it runs before
   * the browser paints, so the thumbnail still arrives with the form rather
   * than a frame after it.
   */
  useLayoutEffect(() => {
    if (initialFiles === undefined || initialFiles.length === 0) {
      return;
    }

    const { accepted, rejections } = acceptProofFiles(initialFiles, 0, MAX_PROOFS);

    setProofs(accepted);

    /*
     * A file that arrived with the form and could not be taken says so.
     *
     * The screening used to keep what it accepted and drop what it refused on
     * the floor, which was survivable while every file came from a share sheet
     * somebody had aimed deliberately. It is not survivable now that a file can
     * arrive by being dropped anywhere on the window: a PDF too large or a
     * .docx dropped by mistake would open this form, attach nothing, and give
     * no hint that anything had been refused — leaving somebody to record the
     * payment believing the comprobante was on it.
     *
     * It does not overwrite `initialNotice`, which is the more specific
     * complaint when both exist.
     */
    if (rejections[0] !== undefined) {
      setProofNotice((current) => current ?? rejections[0] ?? null);
    }

    return () => {
      for (const proof of accepted) {
        URL.revokeObjectURL(proof.previewUrl);
      }
    };
    // Mount only. `initialFiles` is what the form was OPENED with; re-running
    // this because the prop changed identity would wipe out files added since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Everything still held when the form closes, which is more than the effect
     above releases: the files added through the dropzone since. Revoking twice
     is a no-op, so the overlap between the two costs nothing. */
  useEffect(() => {
    return () => {
      for (const proof of proofsRef.current) {
        if (proof.previewUrl) {
          URL.revokeObjectURL(proof.previewUrl);
        }
      }
    };
  }, []);

  const lines: ReceiptDraftLine[] = useMemo(() => {
    const drafts: ReceiptDraftLine[] = [];

    for (const contract of payable) {
      /*
       * One lot takes the amount straight from the top of the form; several
       * take their share of it. Deliberately NOT mirrored into
       * `amountByContract` for the single-lot case: two fields holding the
       * same figure is two fields that can drift, and the one the user cannot
       * see is the one that wins.
       */
      const typed = parseMoneyInput(isMultiLot ? (amountByContract[contract.id] ?? "") : amountText);

      if (Number.isNaN(typed) || typed <= 0) {
        continue;
      }

      drafts.push({
        contractId: contract.id,
        amountCents: Math.round(typed * 100),
        type: typeByContract[contract.id] ?? suggestPaymentType(contract),
      });
    }

    return drafts;
  }, [payable, isMultiLot, amountByContract, amountText, typeByContract]);

  const total = lines.reduce((sum, line) => sum + line.amountCents, 0);

  /**
   * Saldo actual − Monto, across the lots this receipt actually puts money on.
   *
   * Over the LINES rather than over `payable`, so a customer with three lots
   * who is paying one is told what that lot will owe, not a figure blended
   * with two contracts this receipt never touches.
   */
  const balanceAfter = useMemo(() => {
    const balances = new Map<string, number>(payable.map((contract) => [contract.id, contract.balance]));

    return lines.reduce(
      (sum, line) => sum + ((balances.get(line.contractId) ?? 0) - line.amountCents),
      0,
    );
  }, [payable, lines]);

  /*
   * Is this payment already in the ledger?
   *
   * Asked while the form is being filled in rather than when it is submitted,
   * because a duplicate payment is not something an error afterwards can undo —
   * it has a receipt, it moved a balance, and unwinding it means a reversal
   * that will be visible in the customer's history forever. The point is to be
   * told BEFORE, while changing your mind is free.
   *
   * Debounced, because a confirmation number is long and this would otherwise
   * fire on every keystroke of it. 400ms is after a pause in typing but before
   * the hand reaches the next field.
   *
   * A failure is swallowed on purpose. This is an advisory question, and an
   * error banner because a helpful check could not run would be worse than the
   * check silently not running — the receipt itself is unaffected either way.
   */
  useEffect(() => {
    const trimmedReference = reference.trim();
    const canAskByAmount = customerId !== "" && total > 0;

    if (trimmedReference === "" && !canAskByAmount) {
      setDuplicates([]);

      return;
    }

    let abandoned = false;

    const timer = setTimeout(() => {
      void fetchDuplicates({
        reference: trimmedReference,
        customerId,
        paidOn,
        amountCents: total,
      })
        .then((matches) => {
          // The answer to a question the form has since moved on from must not
          // land: without this, an answer for an old amount can arrive after a
          // newer request and overwrite it.
          if (!abandoned) {
            setDuplicates(matches);
          }
        })
        .catch(() => {
          if (!abandoned) {
            setDuplicates([]);
          }
        });
    }, 400);

    return () => {
      abandoned = true;
      clearTimeout(timer);
    };
  }, [reference, customerId, paidOn, total]);

  /**
   * Divide the typed total across everything this customer is paying on.
   *
   * Asked of the SERVER rather than computed here, so this screen and the
   * payment that gets recorded cannot disagree: equal shares to the centavo,
   * except that a lot never gets more than it still owes nor less than its own
   * next installment — see src/lib/allocation.ts.
   *
   * The result lands in the per-lot fields as ordinary typed values, so every
   * line stays editable afterwards. It is a proposal, never a decision.
   */
  const distribute = async () => {
    const typed = parseMoneyInput(amountText);

    if (Number.isNaN(typed) || typed <= 0) {
      setError("Enter the amount paid by the customer.");
      return;
    }

    setError(null);
    setSplitNote(null);
    setSplitting(true);

    try {
      const result = await fetchCustomerSplit(customerId, Math.round(typed * 100));
      const next: Record<string, string> = {};

      for (const line of result.lines) {
        next[line.contractId] = line.amountCents > 0 ? toMoneyInput(cents(line.amountCents)) : "";
      }

      setAmountByContract(next);

      const notes: string[] = [];

      if (result.unallocatedCents > 0) {
        // Handed back rather than absorbed: pushing the extra onto a lot that
        // is already paid off is how a customer ends up with a credit nobody
        // can explain.
        notes.push(
          `There is ${formatMoney(cents(result.unallocatedCents), money)} left over because the customer owes less than this. ` +
            "Choose where this money goes before saving.",
        );
      }

      const short = result.lines.filter((line) => line.belowMinimum);

      if (short.length > 0) {
        // The total simply was not enough to cover every lot's current cuota,
        // even after the server favored the smallest ones first. Said here
        // rather than left for the lot to quietly show up late afterwards.
        const codes = short.map((line) => line.lotCode).join(", ");

        notes.push(
          `The amount does not cover the full installment for ${codes}. Adjust the lines manually or ` +
            (short.length > 1 ? "those lots will become overdue." : "that lot will become overdue."),
        );
      }

      if (notes.length > 0) {
        setSplitNote(notes.join(" "));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not split the amount.");
    } finally {
      setSplitting(false);
    }
  };

  /*
   * The lots a comprobante can be filed against.
   *
   * Derived from the LINES rather than from `payable`, so the picker offers
   * only the lots this receipt actually puts money on. Offering a lot that ends
   * up with no line would produce a proof tagged to a payment that was never
   * created, which the server would then refuse at upload time — after the
   * money had already been recorded.
   */
  const proofLots: ProofLot[] = useMemo(
    () =>
      lines.map((line) => ({
        contractId: line.contractId,
        lotCode:
          payable.find((contract) => contract.id === line.contractId)?.lot.code ?? "this lot",
      })),
    [lines, payable],
  );

  const submit = async (allowOverpayment: boolean) => {
    setError(null);
    setProofNotice(null);
    setSaving(true);
    setSavingStep("Recording payment…");

    const draft: ReceiptDraft = {
      customerId,
      paidOn,
      method,
      reference: reference.trim() === "" ? null : reference.trim(),
      note: note.trim() === "" ? null : note.trim(),
      idempotencyKey,
      allowOverpayment,
      lines,
    };

    try {
      const { receipt } = await createReceipt(draft);

      // The receipt has to exist before a file can belong to it, so the uploads
      // follow rather than travel with it.
      if (proofs.length > 0) {
        const failures: string[] = [];

        /*
         * Which payment each lot ended up as.
         *
         * The form tags a proof with a CONTRACT, because that is all it can
         * know — the payments do not exist until the receipt is written. The
         * server answers with the lines it created, and this is where the one
         * becomes the other. A tag whose line is missing (it should not
         * happen; an amount edited to zero between the tag and the save would
         * do it) simply falls back to the whole receipt rather than failing
         * the upload of a file that is already correct.
         */
        const paymentByContract = new Map(
          receipt.lines.map((line) => [line.contractId, line.paymentId]),
        );

        for (const [index, proof] of proofs.entries()) {
          setSavingStep(`Uploading proof file ${index + 1} of ${proofs.length}…`);

          try {
            await uploadAttachment(
              receipt.id,
              proof.file,
              proof.contractId === null ? null : (paymentByContract.get(proof.contractId) ?? null),
            );
          } catch {
            failures.push(proof.file.name);
          }
        }

        // The money is already recorded, so a failed upload must NOT read as a
        // failed payment. The receipt stands; the file can be added again from
        // the receipt itself.
        if (failures.length > 0) {
          setProofNotice(
            `Payment recorded as ${receipt.code}, but these files could not be uploaded: ` +
              `${failures.join(", ")}. You can attach them again from the receipt.`,
          );
          setSaving(false);
          setSavingStep(null);
          return;
        }
      }

      // The receipt exists; there is nothing left to recover.
      formDraft.clear();
      onIssued(receipt);
    } catch (caught) {
      // The server refuses an overpayment by default and names the balance.
      // Surfaced as a question rather than an error: paying more than is owed
      // is a real thing customers do, it just must not happen by accident.
      if (caught instanceof ApiError && caught.code === "overpayment") {
        setOverpaymentPrompt(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : "Could not record the receipt.");
      }
      setSaving(false);
      setSavingStep(null);
    }
  };

  /*
   * What stops this receipt from being issued, and which field fixes it.
   *
   * Derived rather than stored, so the notice clears itself the moment the
   * missing value is typed instead of sitting there until the next click. The
   * rule itself lives in `receiptBlocker` where it can be tested; see the note
   * there for why the button no longer just goes dead.
   */
  const blocker = useMemo(
    () =>
      receiptBlocker({
        customerId,
        payable,
        lineCount: lines.length,
        amountByContract,
        amountText,
      }),
    [customerId, payable, lines, amountByContract, amountText],
  );

  /*
   * Held back until the first press of the button.
   *
   * A form that turns red before it has been filled in is nagging, not
   * helping — every receipt would open already complaining about the monto
   * nobody has had a chance to type yet.
   */
  const [attempted, setAttempted] = useState(false);
  /* What the comprobante zone is waiting on — a Drive download, usually. The
     form may not be closed or saved across it. See `ProofDropzone`. */
  const [proofBusy, setProofBusy] = useState<string | null>(null);

  /*
   * Anything in the form a stray click would destroy.
   *
   * The date is excluded: it opens on today and an untouched default is not
   * work. Everything else here is typed or chosen, including the per-lot
   * amounts on a multi-lot receipt, which are the most laborious thing on the
   * screen and the worst to lose.
   */
  const hasEnteredAnything =
    customerId !== "" ||
    amountText.trim() !== "" ||
    reference.trim() !== "" ||
    note.trim() !== "" ||
    proofs.length > 0 ||
    Object.values(amountByContract).some((amount) => amount.trim() !== "");

  /*
   * The form, kept across a reload.
   *
   * The per-lot split is the part worth saving: on a customer with four lots
   * those are four amounts reconciled by hand against one total, and they are
   * the most laborious thing on this screen.
   *
   * `proofs` is absent — a `File` cannot be serialised — and the notice below
   * says so rather than letting a receipt be issued with its comprobante
   * silently missing.
   *
   * The customer id is stored raw and re-checked on restore: a customer
   * deactivated since yesterday would otherwise come back selected in a list
   * that no longer contains them.
   */
  const formDraft = useFormDraft(
    "receipt-create",
    { customerId, paidOn, method, reference, note, amountText, amountByContract, typeByContract },
    hasEnteredAnything,
  );

  const invalidField = attempted && blocker ? blocker.focus : null;

  const chooseCustomer = (customer: CustomerRecord | null) => {
    const nextId = customer?.id ?? "";
    setCustomerId(nextId);

    if (nextId === "" || nextId === amountsCustomerRef.current) {
      return;
    }

    if (amountsCustomerRef.current !== "") {
      // Amounts belong to the previous person's lots; keeping them would file
      // one customer's money against another's contract.
      setAmountByContract({});
      // Same for a type chosen by hand: "Prima" was decided about the lot that
      // is no longer on screen.
      setTypeByContract({});
      setAmountText("");
      setSplitNote(null);
      setOverpaymentPrompt(null);
    }

    amountsCustomerRef.current = nextId;
  };

  return (
    /*
     * Wider once the receipt is about more than one lot.
     *
     * 620px is the right ceiling for a column of form fields and the wrong one
     * the moment a table of lots appears beside them — four columns, one of
     * them a field being typed into, inside 566px of content box. The amount
     * was the column that gave way: with a long project name beside it the
     * field was cut to "12,5" while the same build looked fine against the
     * short-named project the development data uses.
     *
     * `is-wide` is `min(1000px, 100%)`, so this is not a second fixed width —
     * it takes the room where the room exists and is unchanged on a laptop that
     * never had it.
     */
    <Dialog
      ariaLabel="Record a transaction"
      size={isMultiLot ? "wide" : "default"}
      /*
       * A receipt is typed at the window with the customer standing there. The
       * backdrop and Escape stop closing it once anything is in it; the X above
       * is the way out. Shut outright while the save is running, which is when
       * leaving would abandon an upload halfway. See `dismissible` in
       * Dialog.tsx.
       */
      dismissible={!hasEnteredAnything && !isSaving && proofBusy === null}
      onClose={onClose}
    >
      <div className="modal-header">
        <div>
          <p className="modal-eyebrow">New transaction</p>
          <h2>Record a payment</h2>
          <p className="modal-description">
            One receipt per customer. If they have multiple lots, split the payment below; each lot
            keeps its own balance.
          </p>
        </div>
        {/* The deliberate way out. Refused only while a file is still being
            read out of Drive — leaving across that download is what loses the
            comprobante. See `proofBusy`. */}
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          disabled={proofBusy !== null}
          title={proofBusy ?? undefined}
          aria-label="Close"
        >
          <IconClose />
        </button>
      </div>

      <div className="modal-form-grid">
        {formDraft.found && (
          <DraftNotice
            savedAt={formDraft.found.savedAt}
            missing={
              "Choose the proof file you attached again. " +
              "Also check the amount against today's balance."
            }
            onRestore={() => {
              const saved = formDraft.found!.values;

              // Only if they are still somebody this form can write a receipt
              // for. Everything else is plain text and comes back as typed.
              const savedCustomer = customers.find((row) => row.id === saved.customerId);

              if (savedCustomer) {
                chooseCustomer(savedCustomer);
              }

              setPaidOn(saved.paidOn);
              setMethod(saved.method);
              setReference(saved.reference);
              setNote(saved.note);
              setAmountText(saved.amountText);
              setAmountByContract(saved.amountByContract);
              setTypeByContract(saved.typeByContract);
              formDraft.dismiss();
            }}
            onDiscard={formDraft.discard}
          />
        )}

        {/* The same picker as "Nuevo contrato": searchable by name, identity and
            phone — the phone matters here, because a comprobante usually arrives
            from a WhatsApp number — and collapsed to one row once chosen, so a
            half-typed search can never sit over the customer being paid for. */}
        <div className="form-field full-width">
          <p className="picker-label">
            Customer <span className="required-mark">*</span>
          </p>
          <CustomerPicker
            customers={customers}
            selected={customers.find((row) => row.id === customerId) ?? null}
            onSelect={chooseCustomer}
            inputId={CUSTOMER_FIELD}
            invalid={invalidField === CUSTOMER_FIELD}
          />
        </div>

        {/*
          Monto and Tipo sit with Cliente, Fecha and Forma de pago because they
          are the same kind of fact: one answer about the whole payment. What is
          left below is the part that genuinely varies per lot.
        */}
        <div className="form-field">
          <label htmlFor="receipt-amount">
            Amount <span className="required-mark">*</span>
          </label>
          <MoneyInput
            id="receipt-amount"
            value={amountText}
            onChange={setAmountText}
            placeholder="e.g. 5,000"
            invalid={invalidField === AMOUNT_FIELD}
          />
          {isMultiLot && (
            <span className="field-hint">
              The total amount paid, to split below across their {payable.length} lots.
            </span>
          )}
        </div>

        {/*
          One control, on both shapes of this form.

          It READS the lots rather than standing beside them: with several it
          shows the type they share, or "Varios" when they disagree, and
          changing it puts one type on all of them. That is what lets it sit up
          here at all. The objection to a top-level type was never its position
          — it was a control that could say "Cuota" while a line below it filed
          a prima. This one cannot say anything the lines are not already doing,
          and the per-lot pickers in the table stay the finer answer for the
          receipt that needs one.
        */}
        <div className="form-field">
          <label htmlFor="receipt-type">Type</label>
          <select
            id="receipt-type"
            value={sharedType ?? MIXED}
            /* Nothing to put a type ON until a customer brings lots with them.
               Left enabled it would take a choice and drop it — this field
               writes to the lots, and before there are any there is nowhere
               for the answer to go. */
            disabled={payable.length === 0}
            onChange={(event) => applyTypeToAll(event.target.value as PaymentType)}
          >
            {/* Only while the lots disagree, and disabled: it is a reading of
                the table, not something a payment can be filed under. */}
            {sharedType === null && (
              <option value={MIXED} disabled>
                Multiple
              </option>
            )}
            {PAYMENT_TYPE_OPTIONS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
          {/* Why it says what it says, so it can be checked rather than
              trusted. Only where there is something to check: "es una cuota
              porque no es nada más" is noise on every receipt. With several
              lots the same fact sits on the row it belongs to. */}
          {soleLot && outstandingDownPayment(soleLot) > 0 && (
            <span className="field-hint">
              {formatMoney(cents(outstandingDownPayment(soleLot)), money)} remaining on the down payment.
            </span>
          )}
          {soleLot &&
            typeByContract[soleLot.id] !== undefined &&
            typeByContract[soleLot.id] !== suggestPaymentType(soleLot) && (
              <span className="field-hint">
                Suggested:{" "}
                {
                  PAYMENT_TYPE_OPTIONS.find(
                    (entry) => entry.value === suggestPaymentType(soleLot),
                  )?.label
                }
              </span>
            )}
          {/* How far this control reaches, because with several lots that is
              not something the control itself can show. */}
          {isMultiLot && (
            <span className="field-hint">
              {sharedType === null
                ? `The ${payable.length} lots have different types. Choosing one here applies it to all.`
                : `Applies to all ${payable.length} lots; you can change one below.`}
            </span>
          )}
        </div>

        <div className="form-field">
          <label htmlFor="receipt-date">
            Payment date <span className="required-mark">*</span>
          </label>
          <input
            id="receipt-date"
            type="date"
            value={paidOn}
            onChange={(event) => setPaidOn(event.target.value)}
          />
          <span className="field-hint">
            The day the money was received, not the day you record it. Earlier dates are placed
            automatically in the right place in the history.
          </span>
        </div>

        <div className="form-field">
          <label htmlFor="receipt-method">Payment method</label>
          <select
            id="receipt-method"
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

        {method === "transfer" && (
          <div className="form-field full-width">
            <label htmlFor="receipt-reference">Confirmation number</label>
            <input
              id="receipt-reference"
              type="text"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="e.g. BAC-889231"
            />
            <span className="field-hint">
              Helps reconcile this payment with the bank statement months later.
            </span>
          </div>
        )}
      </div>

      {customerId !== "" && payable.length === 0 && (
        <p className="form-blocked">This customer has no contracts that can accept payments.</p>
      )}

      {payable.length > 0 && (
        <div className="split-preview">
          {/* No heading for a single lot: the money was already named "Monto"
              above, and a section title over one row of a table is furniture.
              Several lots still need to say what the table is doing. */}
          {isMultiLot && (
            <>
              <p className="cp-section-title">Split across their {payable.length} lots</p>

              {/* The fast path: the customer hands over one figure for three
                  lots and nobody wants to do the division at the window. */}
              <div className="split-total-row">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={isSplitting || amountText.trim() === ""}
                  onClick={() => void distribute()}
                >
                  {isSplitting ? "Splitting…" : "Split amount between lots"}
                </button>
              </div>

              <p className="field-hint">
                Split evenly to the cent. Change a lot only if the split would leave it with less
                than its next installment or more than it owes; the remainder is split equally
                across the other lots. You can adjust any line afterward.
              </p>
            </>
          )}

          {/* The columns below have floors, and past a certain amount of
              content those floors add up to more than the dialog. Scrolling is
              the honest outcome there; clipping a figure is not. */}
          <div className="split-table-scroll">
            <table className="split-table">
            <thead>
              <tr>
                <th>Lot</th>
                <th className="col-money">Current balance</th>
                {/* Only when there is a division to see. One lot receives the
                    Monto typed above, in full, and a column repeating it would
                    be a second place for the same figure to live. The type
                    moves down here for the same reason it moves up there: with
                    several lots it is a per-lot answer, not one. */}
                {isMultiLot && <th className="col-money col-receive">Amount</th>}
                {isMultiLot && <th className="col-type">Type</th>}
              </tr>
            </thead>
            <tbody>
              {payable.map((contract) => (
                <tr key={contract.id}>
                  <td>
                    <span className="code-badge">{contract.lot.code}</span>
                    {/* Truncated by CSS when the column is tight, so the whole
                        name has to stay reachable somewhere. */}
                    <span className="cell-sub" title={contract.lot.projectName}>
                      {contract.lot.projectName}
                    </span>
                  </td>
                  <td className="col-money">
                    <span className="cell-money is-balance">
                      {formatMoney(contract.balance, money)}
                    </span>
                    {contract.health.nextDueOn && (
                      <span className="cell-sub">
                        next installment {formatMoney(contract.health.nextInstallment, money)}
                        {contract.health.nextDueCredit > 0 &&
                          ` · ${formatMoney(contract.health.nextDueCredit, money)} paid in advance`}
                      </span>
                    )}
                  </td>
                  {isMultiLot && (
                    <td className="col-money col-receive">
                      <MoneyInput
                        id={`receipt-amount-${contract.id}`}
                        invalid={invalidField === `receipt-amount-${contract.id}`}
                        value={amountByContract[contract.id] ?? ""}
                        onChange={(formatted) =>
                          setAmountByContract((current) => ({
                            ...current,
                            [contract.id]: formatted,
                          }))
                        }
                        placeholder="0"
                      />
                    </td>
                  )}
                  {isMultiLot && (
                    <td className="col-type">
                      <select
                        aria-label={`Payment type for ${contract.lot.code}`}
                        value={typeFor(contract)}
                        onChange={(event) =>
                          setTypeByContract((current) => ({
                            ...current,
                            [contract.id]: event.target.value as PaymentType,
                          }))
                        }
                      >
                        {PAYMENT_TYPE_OPTIONS.map((entry) => (
                          <option key={entry.value} value={entry.value}>
                            {entry.label}
                          </option>
                        ))}
                      </select>
                      {/* Per row, because with several lots this is the one
                          that differs between them — and it is the whole
                          reason the column exists. */}
                      {outstandingDownPayment(contract) > 0 && (
                        <span className="cell-sub">
                          {formatMoney(cents(outstandingDownPayment(contract)), money)} remaining on
                          down payment
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            </table>
          </div>

          {splitNote && <p className="form-blocked">{splitNote}</p>}

          {/*
            What the customer will still owe once this is recorded.

            "Total del recibo" used to sit here, and it was the Monto typed
            three fields up read back — the one figure on the screen nobody
            needed telling. This is the figure they do: today it exists only on
            the issued receipt, as `newBalance`, which means the answer to "y
            cuánto me queda" arrives after the money has been taken.

            Plain subtraction, and it agrees with the server for the same
            reason routes/receipts.ts says its own check does: with no charges
            in the system yet, a balance IS sale price minus payments. The
            receipt remains the authority — this is the same arithmetic run
            early, not a second source of truth.
          */}
          {total > 0 && (
            <>
              <p className={`receipt-running-total${balanceAfter < 0 ? " is-over" : ""}`}>
                Remaining balance <strong>{formatMoney(cents(balanceAfter), money)}</strong>
              </p>

              {balanceAfter < 0 && (
                <p className="receipt-over-note">
                  The payment exceeds the amount owed. You'll be asked to confirm before it is
                  accepted.
                </p>
              )}
            </>
          )}
        </div>
      )}

      <div className="modal-form-grid">
        <div className="form-field full-width">
          <label>Proof file</label>
          {/* Right above the field it is about, not down with the form's
              general errors — see the `proofNotice` state doc above. */}
          {proofNotice && <p className="form-error full-width">{proofNotice}</p>}
          <ProofDropzone
            files={proofs}
            onFilesChange={setProofs}
            onReject={setProofNotice}
            maxFiles={MAX_PROOFS}
            lots={proofLots}
            onBusyChange={setProofBusy}
            disabled={isSaving}
          />
        </div>

        <div className="form-field full-width">
          <label htmlFor="receipt-note">Team note (optional)</label>
          <textarea
            id="receipt-note"
            rows={2}
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="e.g. Will pay the rest on Friday. Proof is missing."
          />
          {/* Said here, where it is typed: this field used to be printed on the
              receipt, and somebody who remembers that would otherwise keep
              writing for the customer. */}
          <span className="field-hint">
            Visible to all users in Receipts. Not printed on the receipt or sent to the customer.
          </span>
        </div>

        {error && <p className="form-error full-width">{error}</p>}

        {attempted && blocker && (
          // `role="alert"` so it is spoken the moment it appears: the press
          // that reveals it moves the caret to the offending field, not here.
          <p className="form-error full-width" role="alert">
            {blocker.message}
          </p>
        )}

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
              Yes, the customer overpaid — record it anyway
            </button>
          </div>
        )}
      </div>

      {duplicates.length > 0 && (
        /*
         * Red when the bank's own confirmation number matches, amber when it is
         * only customer, day and total. The second is a genuine signal — it is
         * the shape of the two L 7,000 payments hours apart that caused trouble
         * — but it is also how a customer paying the same installment twice in
         * a day looks, so it must not shout as loudly as near-proof does.
         */
        <div className={hasReferenceMatch ? "form-warning" : "form-blocked"}>
          <strong>
            {hasReferenceMatch
              ? "That confirmation number has already been recorded."
              : "A receipt for this customer with the same amount and date already exists."}
          </strong>
          <ul className="duplicate-matches">
            {duplicates.map((match) => (
              <li key={match.receiptId ?? `${match.paidOn}-${match.amountCents}`}>
                {match.receiptCode ? `Receipt ${match.receiptCode}` : "Payment without a receipt"}
                {" · "}
                {formatMoney(cents(match.amountCents), money)}
                {" · "}
                {match.paidOn}
                {match.lotCodes.length > 0 && ` · ${match.lotCodes.join(", ")}`}
                {match.cancelled && " · VOIDED"}
              </li>
            ))}
          </ul>
          Review before continuing. If this is a second payment, you can still record it.
        </div>
      )}

      <div className="modal-actions">
        <button
          type="button"
          className="btn-secondary"
          onClick={onClose}
          disabled={isSaving || proofBusy !== null}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary modal-submit"
          disabled={isSaving || proofBusy !== null}
          onClick={() => {
            if (blocker) {
              // Say it, then put the caret where it can be fixed. Announcing
              // without moving leaves the user hunting a field in a form long
              // enough to scroll.
              setAttempted(true);
              document.getElementById(blocker.focus)?.focus();
              return;
            }

            void submit(false);
          }}
        >
          {proofBusy ?? savingStep ?? "Record payment and issue receipt"}
        </button>
      </div>
    </Dialog>
  );
}
