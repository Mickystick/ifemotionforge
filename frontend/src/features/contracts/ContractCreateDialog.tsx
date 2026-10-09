import type { FormEvent } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Dialog } from "../../components/Dialog";
import { DraftNotice } from "../../components/DraftNotice";
import { useFormDraft } from "../../lib/formDrafts";
import { IconClose } from "../../components/Icons";
import { MoneyInput } from "../../components/MoneyInput";
import { businessToday } from "../../lib/businessTime";
import type { MoneyView } from "../../lib/money";
import { cents, formatMoney, parseMoneyInput, toMoneyInput } from "../../lib/money";
import type { Contract, CustomerRecord, HoldingKind, Lot, SaleType } from "../../types";
import type { AreaUnit } from "../../lib/area";
import type { ContractCreateDraft } from "./api";
import { uploadContractDocument } from "./api";
import type { PendingDocument } from "./ContractDocumentDropzone";
import { ContractDocumentDropzone, holdContractFiles } from "./ContractDocumentDropzone";
import { screenContractFiles } from "./contractFiles";
import { CustomerPicker, LotPicker } from "./ContractPartyPickers";
import { KIND_LABELS, SALE_TYPE_LABELS, formatDate } from "./contractPresentation";
import {
  addMonthsOnDay,
  clampDueDayInput,
  financedCents,
  firstDueDate,
  parseIntOrNull,
  suggestMonthlyPayment,
  summarizeSchedule,
} from "./contractSchedule";

/** Two questions, asked one at a time — see the note on the component. */
type Step = "parties" | "terms";

/**
 * What to say when the contract was written but a scan of it was not.
 *
 * Worded around the half that succeeded, because that is the half with
 * consequences: the lot has left the inventory and the customer owes money on
 * it. Somebody who reads "no se pudo" and closes the form must not go looking
 * for the contract they think they failed to create.
 */
function uploadFailure(code: string, names: string[]): string {
  return (
    `Contract ${code} was created, but these files couldn't be uploaded: ${names.join(", ")}. ` +
    "Try again, or attach them later from the contract."
  );
}

interface ContractCreateDialogProps {
  customers: CustomerRecord[];
  /** Every lot; the picker narrows it to what can actually be sold. */
  lots: Lot[];
  /** Existing contracts, used to offer joining an existing purchase. */
  contracts: Contract[];
  unitByProject: Map<string, AreaUnit>;
  money: MoneyView;
  /**
   * Paperwork the form was opened with — a scan dropped anywhere on the
   * Contratos tab. Attached on mount and filed once the contract exists.
   */
  initialFiles?: File[];
  onCancel: () => void;
  /**
   * Write the contract and answer with what the server assigned it.
   *
   * The id comes back because the documents are uploaded from here, and a
   * document needs a contract to belong to: the code is for saying WHICH
   * contract survived when one of those uploads does not.
   *
   * Rejects when the server refuses; the message is shown in the dialog.
   */
  onCreate: (draft: ContractCreateDraft) => Promise<{ id: string; code: string }>;
  /**
   * The contract exists and nothing more is owed to it — close and re-read.
   *
   * Separate from `onCreate` because the two moments stopped being the same
   * one: between them sit the uploads, and the dialog has to still be on
   * screen for those. It is also what closing after a FAILED upload calls, so
   * the list behind refreshes either way — the contract is there regardless of
   * what became of its scan.
   */
  onCreated: () => void;
}

/**
 * The "Nuevo contrato" form.
 *
 * Two steps rather than one long scroll, and the split is not cosmetic. The
 * first step settles WHO and WHICH LOT; the second settles the money. The
 * second genuinely depends on the first — the lot's list price is where the
 * sale price starts, and whether this customer already has a live purchase is
 * what decides whether these lots are one deal or two — so asking them in one
 * pile would mean showing a price field before there is a lot to price.
 *
 * What is deliberately NOT here:
 *
 * - The contract number. The server assigns it, from a per-year sequence with a
 *   unique index behind it. Two people entering contracts at the same time
 *   cannot be trusted to pick different numbers, and neither can one person.
 * - The lot's status. A lot is available exactly while no active contract
 *   points at it. Creating this contract IS what makes it sold; there is
 *   nothing to tick.
 * - A motive. Correcting a signed contract demands one (see
 *   `ContractEditDialog`) because it changes what two people are recorded as
 *   having agreed. Writing one down for the first time changes nothing — the
 *   audit trail already records who created it and when.
 */
export function ContractCreateDialog({
  customers,
  lots,
  contracts,
  unitByProject,
  money,
  initialFiles,
  onCancel,
  onCreate,
  onCreated,
}: ContractCreateDialogProps) {
  const [step, setStep] = useState<Step>("parties");

  const [customer, setCustomer] = useState<CustomerRecord | null>(null);
  const [lot, setLot] = useState<Lot | null>(null);
  /** The contract this purchase joins, or "" for a sale of its own. */
  const [joinContractId, setJoinContractId] = useState("");

  const [kind, setKind] = useState<HoldingKind>("contract");
  const [saleType, setSaleType] = useState<SaleType>("financed");

  // `null` in the three overrides below means "follow the suggestion". Once the
  // user types, their value is kept verbatim and the suggestion never
  // overwrites a decision they made — the same rule the Nuevo lote form uses
  // for the lot number.
  const [priceOverride, setPriceOverride] = useState<string | null>(null);
  const [monthlyOverride, setMonthlyOverride] = useState<string | null>(null);
  const [expiresOverride, setExpiresOverride] = useState<string | null>(null);
  const [signedOnOverride, setSignedOnOverride] = useState<string | null>(null);

  const [downPayment, setDownPayment] = useState("");
  const [termMonths, setTermMonths] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [firstDueOn, setFirstDueOn] = useState("");
  const [notes, setNotes] = useState("");

  /**
   * The signed paperwork, held until there is a contract to file it against.
   *
   * The reason it is collected HERE rather than only from the contract's panel
   * afterwards: the scan and the terms are read off the same piece of paper in
   * the same minute. Filing it used to mean saving the contract, finding it in
   * the list, opening its panel and adding the file there — four screens for
   * one document, which is how a business ends up with the terms in Lindero and
   * the contracts in a folder on somebody's phone.
   */
  const [documents, setDocuments] = useState<PendingDocument[]>([]);

  /**
   * What the server assigned, once it has assigned it.
   *
   * The guard against creating the same sale twice. The uploads happen AFTER
   * the contract is written, so a failure in one of them leaves a form on
   * screen whose Crear button would otherwise write a second contract — and
   * unlike a receipt there is no idempotency key on this route to catch it.
   * Set the instant the server answers; from then on this form only retries
   * uploads.
   */
  const [created, setCreated] = useState<{ id: string; code: string } | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);
  /*
   * What the dropzone is waiting on — a Google Drive download, usually — or
   * null when nothing is in flight. See `ContractDocumentDropzone`.
   */
  const [documentBusy, setDocumentBusy] = useState<string | null>(null);
  /** What the save is doing right now — a contract, or the third of five scans. */
  const [savingStep, setSavingStep] = useState<string | null>(null);

  /* Read by the unmount cleanup below, which must see what is held at the
     moment it runs rather than what was held when it was registered. */
  const documentsRef = useRef(documents);
  documentsRef.current = documents;

  /*
   * Attach the files the form was opened with — dropped anywhere on the
   * Contratos tab. See lib/useFileDrop.ts and lib/windowDropTarget.ts.
   *
   * A LAYOUT effect for the reason `NewReceiptDialog` spells out at length: the
   * object URLs must be created by something whose own cleanup revokes them, or
   * React's development StrictMode remount leaves the form holding a `blob:`
   * URL that has already been revoked — and the document cannot be previewed,
   * while the identical file added through the dropzone a second later is fine.
   * Running before paint keeps the thumbnail arriving with the form.
   */
  useLayoutEffect(() => {
    if (initialFiles === undefined || initialFiles.length === 0) {
      return;
    }

    const { accepted, rejections } = screenContractFiles(initialFiles, 0);
    const held = holdContractFiles(accepted);

    setDocuments(held);

    /* A file that arrived with the form and could not be taken says so. Dropped
       silently, somebody would create the contract believing the scan was on
       it — and a .docx draft dropped by mistake looks exactly like a PDF that
       landed. */
    if (rejections[0] !== undefined) {
      setError((current) => current ?? rejections[0] ?? null);
    }

    return () => {
      for (const document of held) {
        URL.revokeObjectURL(document.previewUrl);
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
      for (const document of documentsRef.current) {
        URL.revokeObjectURL(document.previewUrl);
      }
    };
  }, []);

  const isFinanced = saleType === "financed";
  const isDonation = saleType === "donation";
  const isReservation = kind === "reservation";

  /*
   * Is there anything here worth protecting?
   *
   * The guard below only bites once the answer is yes. A form opened and
   * immediately thought better of still closes on a click outside, which is
   * what anybody expects — the cost of a stray click is only real once there is
   * work to lose.
   *
   * Deliberately coarse. Picking the customer is the first thing that happens
   * on this form and everything after it is more typing, so that one field is
   * enough to say "somebody is in the middle of this".
   */
  const hasEnteredAnything =
    customer !== null ||
    lot !== null ||
    joinContractId !== "" ||
    documents.length > 0 ||
    notes.trim() !== "";

  /*
   * A file is being read out of Drive, or the save is running.
   *
   * Nothing may close the form during either. The download is the dangerous
   * one: it is seconds long, it shows only a small line of text inside the
   * dropzone, and closing across it loses the file silently — see
   * `ContractDocumentDropzone`.
   */
  const isWorking = isSaving || documentBusy !== null;

  /*
   * The form, kept across a reload.
   *
   * The customer and the lot are stored as IDS rather than as the objects
   * themselves. The objects are rows from a list this form is handed fresh on
   * every open, and a stale copy from yesterday could describe a lot somebody
   * else has since sold — so the id is re-resolved against today's list on
   * restore, and a lot that is no longer free simply does not come back.
   *
   * `documents` is absent, because a `File` cannot be serialised. That absence
   * is stated to the user rather than hidden; see the notice below.
   *
   * Suspended once the contract exists: from that point the form is only
   * retrying uploads, and there is nothing left to recover.
   */
  const draft = useFormDraft(
    "contract-create",
    {
      step,
      customerId: customer?.id ?? null,
      lotId: lot?.id ?? null,
      joinContractId,
      kind,
      saleType,
      priceOverride,
      monthlyOverride,
      expiresOverride,
      signedOnOverride,
      downPayment,
      termMonths,
      dueDay,
      firstDueOn,
      notes,
    },
    hasEnteredAnything && created === null,
  );

  // The active contracts this customer already holds. Only these can be joined:
  // a sale group exists so that ONE payment can be split across the lots of ONE
  // purchase, so mixing two customers into a group would put one person's money
  // against another person's lot.
  const groupCandidates = useMemo(
    () =>
      customer === null
        ? []
        : contracts.filter(
            (candidate) => candidate.customer.id === customer.id && candidate.status === "active",
          ),
    [contracts, customer],
  );

  /*
   * One option per PURCHASE, which is not the same as one per contract.
   *
   * This list used to be `groupCandidates` straight through, and that made the
   * question contradict its own answer. Say a customer buys lot A, then buys
   * lot B and joins it to A's purchase — the right thing, and what the field is
   * for. Open the form again for lot C and the old list offered "CT-2026-014 ·
   * Lote A-12" AND "CT-2026-015 · Lote B-03" as two separate things to join.
   * They are not two things. They are two doors into one purchase, and being
   * shown both is what makes somebody who just said "these are one sale"
   * conclude the app did not believe them.
   *
   * Contracts already sharing a `saleGroupId` therefore collapse into a single
   * entry describing the whole purchase. A contract standing on its own keeps
   * its own entry, because that is genuinely one thing.
   *
   * The VALUE stays an ordinary contract id — any member of the group will do.
   * The server reads whichever contract it is handed, takes that contract's
   * `saleGroupId` (minting one if the contract had none yet) and files the new
   * contract under it, so collapsing the list here needs no change on the other
   * side. See routes/contracts.ts.
   */
  const purchaseOptions = useMemo(() => {
    const byGroup = new Map<string, Contract[]>();

    for (const candidate of groupCandidates) {
      // A contract with no group is its own purchase, keyed by its own id so it
      // can never be folded in with another ungrouped one.
      const key = candidate.saleGroupId ?? `solo:${candidate.id}`;
      const members = byGroup.get(key);

      if (members) {
        members.push(candidate);
      } else {
        byGroup.set(key, [candidate]);
      }
    }

    return [...byGroup.values()].map((members) => {
      const first = members[0]!;
      const lots = members
        .map((member) => member.lot.code)
        .sort((a, b) => a.localeCompare(b, "es"));

      return {
        // Any member joins the same purchase; the first is as good as any.
        value: first.id,
        label:
          members.length === 1
            ? `${first.code} · Lot ${first.lot.code} · signed ${formatDate(first.terms.signedOn)}`
            : `Purchase of ${members.length} lots · ${lots.join(", ")} · signed ${formatDate(first.terms.signedOn)}`,
        lotCount: members.length,
      };
    });
  }, [groupCandidates]);

  const joinContract = groupCandidates.find((candidate) => candidate.id === joinContractId) ?? null;

  /* How many lots the chosen purchase already covers, for the hint below. */
  const joinLotCount =
    purchaseOptions.find((option) => option.value === joinContractId)?.lotCount ?? 0;

  // Joining an existing purchase inherits its signing date by default: these
  // are lots bought in the same deal, and two signing dates a week apart would
  // give one purchase two different payment calendars.
  const signedOn = signedOnOverride ?? joinContract?.terms.signedOn ?? businessToday();

  const salePrice = priceOverride ?? (lot === null ? "" : toMoneyInput(lot.basePrice));

  const priceNumber = isDonation ? 0 : parseMoneyInput(salePrice);
  // A prima is a piece of the price held back from what gets financed, so it
  // only means anything on a credit sale. Contado is settled in full at
  // signing and a donation is settled at zero; neither has a remainder for a
  // prima to reduce, so neither shows the field and neither sends a number.
  const downNumber = !isFinanced || downPayment.trim() === "" ? 0 : parseMoneyInput(downPayment);
  const priceCents = Number.isFinite(priceNumber) ? Math.round(priceNumber * 100) : 0;
  const downCents = Number.isFinite(downNumber) ? Math.round(downNumber * 100) : 0;
  const financed = financedCents(priceCents, downCents);

  const months = parseIntOrNull(termMonths);
  const day = parseIntOrNull(dueDay);
  const hasTerm = months !== null && Number.isFinite(months) && months >= 1;
  const hasDueDay = day !== null && Number.isFinite(day) && day >= 1 && day <= 31;

  const suggestedMonthly = isFinanced && hasTerm ? suggestMonthlyPayment(financed, months) : null;
  const monthlyPayment =
    monthlyOverride ?? (suggestedMonthly === null ? "" : toMoneyInput(cents(suggestedMonthly)));

  const monthlyNumber = monthlyPayment.trim() === "" ? Number.NaN : parseMoneyInput(monthlyPayment);
  const monthlyCents = Number.isFinite(monthlyNumber) ? Math.round(monthlyNumber * 100) : 0;

  // What the schedule works out to, previewed live. The server builds the real
  // one from the same rules on every read; this exists so the person typing can
  // see that "24 meses de L 3,500" against this price is really 23 cuotas and a
  // short one at the end, before they promise it to somebody.
  const scheduledFirstDue = firstDueDate(
    signedOn,
    hasDueDay ? day : null,
    firstDueOn.trim() === "" ? null : firstDueOn,
  );
  const schedule =
    isFinanced && hasTerm && hasDueDay && scheduledFirstDue !== null
      ? summarizeSchedule(financed, months, monthlyCents, scheduledFirstDue, day)
      : null;

  // A hold with no end date keeps a lot off the market forever and nobody ever
  // notices, so the field is required — starting a month out, which is what
  // these are in practice.
  const expiresOn =
    expiresOverride ??
    (isReservation && signedOn !== ""
      ? addMonthsOnDay(signedOn, 1, Number(signedOn.slice(8, 10)))
      : "");

  const chooseCustomer = (next: CustomerRecord | null) => {
    setCustomer(next);
    // The group belongs to the person who was selected a moment ago, so it
    // cannot survive them being swapped out.
    setJoinContractId("");
    setError(null);
  };

  const chooseLot = (next: Lot | null) => {
    setLot(next);
    setError(null);
  };

  const goBack = () => {
    setStep("parties");
    setError(null);
  };

  /*
   * Escape, the backdrop and the X all lead here.
   *
   * Once the contract exists, closing is not cancelling: the lists behind have
   * to be re-read whether or not the scan made it, or the Contratos screen sits
   * there without the sale that was just written on it.
   */
  const close = () => {
    if (created === null) {
      onCancel();
      return;
    }

    onCreated();
  };

  const submitParties = () => {
    if (customer === null) {
      setError("Choose the customer signing this contract.");
      return;
    }
    if (lot === null) {
      setError("Choose the lot being sold.");
      return;
    }

    setError(null);
    setStep("terms");
  };

  /**
   * File the held documents against the contract that now exists.
   *
   * Each one that lands is dropped from `documents` as it goes, so pressing
   * Reintentar after a failed upload sends only what is still missing rather
   * than filing the first three scans a second time.
   *
   * Returns the names it could not send. The contract is already written by
   * this point, so a failure here must NOT read as a failed save.
   */
  const fileDocuments = async (contractId: string): Promise<string[]> => {
    const pending = [...documents];
    const failures: string[] = [];

    for (const [index, held] of pending.entries()) {
      setSavingStep(
        pending.length === 1
          ? `Uploading ${held.file.name}…`
          : `Uploading document ${index + 1} of ${pending.length}…`,
      );

      try {
        await uploadContractDocument(contractId, held.file);
        URL.revokeObjectURL(held.previewUrl);
        setDocuments((current) => current.filter((entry) => entry.id !== held.id));
      } catch {
        failures.push(held.file.name);
      }
    }

    setSavingStep(null);

    return failures;
  };

  const submitTerms = async () => {
    setError(null);

    /*
     * The contract already exists and only its paperwork is outstanding, so
     * this press retries the uploads and nothing else — the terms above are
     * settled and no longer on screen to change.
     */
    if (created !== null) {
      setSaving(true);

      const failures = await fileDocuments(created.id);

      if (failures.length > 0) {
        setError(uploadFailure(created.code, failures));
        setSaving(false);
        return;
      }

      onCreated();
      return;
    }

    if (customer === null || lot === null) {
      setStep("parties");
      return;
    }

    // The same relationships the server checks in `termsProblem`, mirrored here
    // so a mistake is caught before the round trip rather than after it.
    if (!isDonation) {
      if (!Number.isFinite(priceNumber) || priceNumber < 0) {
        setError("Enter the sale price in lempiras.");
        return;
      }
    }

    if (isFinanced) {
      if (!Number.isFinite(downNumber) || downNumber < 0) {
        setError("Enter the down payment in lempiras.");
        return;
      }
      if (downCents > priceCents) {
        setError("The down payment can't exceed the sale price.");
        return;
      }
      if (!hasTerm) {
        setError("A financed contract requires a term in months.");
        return;
      }
      if (monthlyCents <= 0) {
        setError("A financed contract requires a monthly installment.");
        return;
      }
      if (!hasDueDay) {
        setError("Due day must be between 1 and 31.");
        return;
      }
      if (downCents === priceCents) {
        setError("If the down payment covers the full price, this is a cash sale, not a financed sale.");
        return;
      }
    }
    // No matching `else` complaining about a stray plazo or cuota, which is
    // what the server checks for. The three schedule fields only EXIST here
    // while the sale is financed, so a leftover in one of them after switching
    // to contado is invisible — and an error about a field that is not on
    // screen is an error nobody can clear. They are sent as null below instead.

    if (signedOn.trim() === "") {
      setError("Enter the contract signing date.");
      return;
    }
    if (isReservation && expiresOn.trim() === "") {
      setError("A reservation requires an expiration date.");
      return;
    }
    // Guarded on `isFinanced` for the same reason as the note above: the field
    // is only on screen for a credit sale, and a leftover date behind a hidden
    // field must not refuse a save. It is sent as null below either way.
    if (isFinanced && firstDueOn.trim() !== "" && firstDueOn < signedOn) {
      setError("The first installment can't be due before the contract is signed.");
      return;
    }
    if (isReservation && expiresOn < signedOn) {
      setError("The reservation can't expire before the signing date.");
      return;
    }

    setSaving(true);
    setSavingStep("Creating contract…");

    let contract: { id: string; code: string };

    try {
      contract = await onCreate({
        customerId: customer.id,
        lotId: lot.id,
        kind,
        saleType,
        // A donation is recorded at zero rather than left out of the table: the
        // lot's history has to say what became of it, and "no aparece" is not
        // an answer.
        salePriceCents: isDonation ? 0 : priceCents,
        downPaymentCents: isFinanced ? downCents : 0,
        termMonths: isFinanced ? months : null,
        monthlyPaymentCents: isFinanced ? monthlyCents : null,
        dueDay: isFinanced ? day : null,
        signedOn,
        // Blank means "let it follow from the signing date", which is a
        // different instruction from any particular date.
        firstDueOn: isFinanced && firstDueOn.trim() !== "" ? firstDueOn : null,
        expiresOn: isReservation ? expiresOn : null,
        notes: notes.trim() === "" ? null : notes.trim(),
        joinGroupOfContractId: joinContractId === "" ? null : joinContractId,
      });
    } catch (caught) {
      // The server checks every one of these rules independently, and it is
      // also the only one that can see whether somebody else took this lot
      // thirty seconds ago — so that refusal surfaces here too.
      setError(caught instanceof Error ? caught.message : "Could not create the contract.");
      setSaving(false);
      setSavingStep(null);
      return;
    }

    // From here the contract EXISTS, whatever happens to its documents.
    // Recorded before the uploads are attempted so that a failure in one of
    // them cannot be answered by writing the sale a second time.
    setCreated(contract);
    draft.clear();

    const failures = await fileDocuments(contract.id);

    if (failures.length > 0) {
      setError(uploadFailure(contract.code, failures));
      setSaving(false);
      return;
    }

    onCreated();
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();

    if (step === "parties") {
      submitParties();
      return;
    }

    void submitTerms();
  };

  return (
    <Dialog
      ariaLabel="New contract"
      /*
       * Once there is something in the form, the backdrop and Escape stop
       * closing it — the X and Cancelar above are the way out. Twenty fields
       * copied off a signed contract are not something a click that missed the
       * panel by two pixels should be able to destroy.
       *
       * Also shut while a file is being read out of Drive, empty form or not:
       * that is the window in which leaving silently loses the document.
       */
      dismissible={!hasEnteredAnything && !isWorking}
      onClose={close}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">
              {created === null
                ? `New contract · Step ${step === "parties" ? 1 : 2} of 2`
                : `Contract ${created.code} created`}
            </p>
            <h2>
              {created !== null
                ? isSaving
                  ? "Saving signed contract"
                  : "Signed contract needed"
                : step === "parties"
                  ? "Customer and lot"
                  : "Sale terms"}
            </h2>
            <p className="modal-description">
              {created === null && step === "parties" ? (
                "A contract is for one customer and one lot. The number is assigned when you save."
              ) : customer && lot ? (
                <>
                  {customer.fullName} · Lot {lot.code} · {lot.projectName}
                </>
              ) : (
                ""
              )}
            </p>
          </div>
          {/* The deliberate way out, and the ONLY one once the form has
              something in it — see `dismissible` on the Dialog below. Refused
              only while a file is still being read or the save is running,
              because leaving in the middle of either is what loses the
              document. */}
          <button
            type="button"
            className="modal-close"
            onClick={close}
            disabled={isWorking}
            title={documentBusy ?? undefined}
            aria-label="Close"
          >
            <IconClose />
          </button>
        </div>

        {created === null && step === "parties" && (
          <div className="modal-form-grid">
            {draft.found && (
              <DraftNotice
                savedAt={draft.found.savedAt}
                /* Said plainly, because a form that comes back looking
                   finished with its scan quietly missing is how an unfiled
                   contract gets saved and nobody notices for months. */
                missing="Select the signed contract file again; previously attached files can't be restored."
                onRestore={() => {
                  const saved = draft.found!.values;

                  // Re-resolved against TODAY's lists: a lot sold since, or a
                  // customer deactivated since, simply does not return.
                  setCustomer(customers.find((row) => row.id === saved.customerId) ?? null);
                  setLot(lots.find((row) => row.id === saved.lotId) ?? null);
                  setJoinContractId(saved.joinContractId);
                  setKind(saved.kind);
                  setSaleType(saved.saleType);
                  setPriceOverride(saved.priceOverride);
                  setMonthlyOverride(saved.monthlyOverride);
                  setExpiresOverride(saved.expiresOverride);
                  setSignedOnOverride(saved.signedOnOverride);
                  setDownPayment(saved.downPayment);
                  setTermMonths(saved.termMonths);
                  setDueDay(saved.dueDay);
                  setFirstDueOn(saved.firstDueOn);
                  setNotes(saved.notes);

                  /*
                   * Back to the step they were on — but only if the two things
                   * that step depends on both came back. Landing somebody on
                   * "Términos de la venta" with no lot behind it is a screen
                   * that cannot be completed and does not say why.
                   */
                  const customerBack = customers.some((row) => row.id === saved.customerId);
                  const lotBack = lots.some((row) => row.id === saved.lotId);

                  if (saved.step === "terms" && customerBack && lotBack) {
                    setStep("terms");
                  }

                  draft.dismiss();
                }}
                onDiscard={draft.discard}
              />
            )}

            {/* Where the file went.

                A drop on the Contratos tab opens this form at step 1, which is
                a screen with no dropzone on it — so without this, the gesture
                that carried a scan in ends on a page showing no sign of it. */}
            {documents.length > 0 && (
              <p className="form-note full-width">
                {documents.length === 1 ? (
                  <>
                    <strong>{documents[0]!.file.name}</strong> will be attached to the contract.
                  </>
                ) : (
                  <>
                    <strong>{documents.length} files</strong> will be attached to the contract.
                  </>
                )}{" "}
                Choose the customer and lot to continue.
              </p>
            )}

            <div className="form-field full-width">
              {/* A <p> rather than a <label>: a label has to name one control,
                  and the picker below is a search box that disappears the
                  moment a choice is made. The controls inside carry their own
                  aria-label instead. */}
              <p className="picker-label">
                Customer<span className="required-mark" aria-hidden="true"> *</span>
              </p>
              <CustomerPicker
                customers={customers}
                selected={customer}
                onSelect={chooseCustomer}
              />
            </div>

            <div className="form-field full-width">
              <p className="picker-label">
                Lot<span className="required-mark" aria-hidden="true"> *</span>
              </p>
              <LotPicker
                lots={lots}
                unitByProject={unitByProject}
                money={money}
                selected={lot}
                onSelect={chooseLot}
              />
              <span className="field-hint">
                Only available lots are shown. Saving this contract removes the lot from available
                inventory; there's no separate status to set.
              </span>
            </div>

            {/* Offered only when there is something to join. A customer with no
                live contract cannot be buying a second lot of the same deal. */}
            {purchaseOptions.length > 0 && (
              <div className="form-field full-width">
                <label htmlFor="new-contract-group">Is this part of an existing purchase?</label>
                <select
                  id="new-contract-group"
                  value={joinContractId}
                  onChange={(event) => setJoinContractId(event.target.value)}
                >
                  <option value="">No, it's a separate purchase</option>
                  {purchaseOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  {joinContract
                    ? `These ${joinLotCount + 1} lots will be treated as one purchase, each with its own balance. Payments from ${customer?.fullName} can be split between them from the contracts list.`
                    : "Join them only if this is the same sale: lots signed on the same day with one receipt. Lots purchased in different years share a customer, not a purchase."}
                </span>
              </div>
            )}

            {error && <p className="form-error full-width">{error}</p>}
          </div>
        )}

        {created === null && step === "terms" && lot && (
          <div className="modal-form-grid">
            <div className="form-field">
              <label htmlFor="new-contract-kind">Type</label>
              <select
                id="new-contract-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as HoldingKind)}
              >
                {(Object.keys(KIND_LABELS) as HoldingKind[]).map((value) => (
                  <option key={value} value={value}>
                    {KIND_LABELS[value]}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                A reservation holds a lot until its expiration date; a contract is the sale.
              </span>
            </div>

            <div className="form-field">
              <label htmlFor="new-contract-sale-type">Payment type</label>
              <select
                id="new-contract-sale-type"
                value={saleType}
                onChange={(event) => setSaleType(event.target.value as SaleType)}
              >
                {(Object.keys(SALE_TYPE_LABELS) as SaleType[]).map((value) => (
                  <option key={value} value={value}>
                    {SALE_TYPE_LABELS[value]}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                Financed sales have a down payment, term, installments, and due day. Cash sales
                are paid in full when signed.
              </span>
            </div>

            {/* A donation has no price and no prima by definition, so both
                fields are gone rather than sitting there waiting to be zeroed
                and then refused. */}
            {isDonation ? (
              <p className="form-blocked full-width">
                A donation is recorded with a price and down payment of zero. The lot leaves
                inventory just as it would in a sale, and its history shows who received it.
              </p>
            ) : (
              <div className="form-field">
                <label htmlFor="new-contract-price">
                  Sale price<span className="required-mark" aria-hidden="true"> *</span>
                </label>
                <MoneyInput
                  id="new-contract-price"
                  value={salePrice}
                  onChange={setPriceOverride}
                  placeholder="0.00"
                />
                <span className="field-hint">
                  {priceCents === lot.basePrice ? (
                    <>Lot's listed price. It's negotiable: enter the agreed price.</>
                  ) : (
                    <>
                      The lot is listed at {formatMoney(lot.basePrice, money)}.{" "}
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => setPriceOverride(null)}
                      >
                        Reset to list price
                      </button>
                    </>
                  )}
                </span>
              </div>
            )}

            {/* Only on a credit sale. A prima is the part of the price that is
                NOT financed, so on a venta de contado — where the whole price
                is due at signing — there is nothing for it to hold back. The
                field used to sit here for every forma de pago, and a number
                typed into it on a contado sale did nothing except leave the
                contract owing a prima that the Panel General then listed as
                pendiente forever. */}
            {isFinanced && (
              <div className="form-field">
                <label htmlFor="new-contract-down">Agreed down payment</label>
                <MoneyInput
                  id="new-contract-down"
                  value={downPayment}
                  onChange={setDownPayment}
                  placeholder="0.00"
                />
                <span className="field-hint">
                  The amount agreed, not the amount collected. The down payment is recorded as a
                  payment later; until then, the list will show it as unpaid.
                </span>
              </div>
            )}

            {isFinanced && (
              <>
                <div className="form-field">
                  <label htmlFor="new-contract-term">
                    Term in months<span className="required-mark" aria-hidden="true"> *</span>
                  </label>
                  <input
                    id="new-contract-term"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="600"
                    value={termMonths}
                    placeholder="24"
                    onChange={(event) => setTermMonths(event.target.value)}
                  />
                  <span className="field-hint">
                    {financed > 0
                      ? `${formatMoney(cents(financed), money)} will be financed after the down payment.`
                      : "The amount remaining after the down payment is what gets financed."}
                  </span>
                </div>

                <div className="form-field">
                  <label htmlFor="new-contract-monthly">
                    Monthly installment<span className="required-mark" aria-hidden="true"> *</span>
                  </label>
                  <MoneyInput
                    id="new-contract-monthly"
                    value={monthlyPayment}
                    onChange={setMonthlyOverride}
                    placeholder="0.00"
                  />
                  <span className="field-hint">
                    {suggestedMonthly !== null && monthlyOverride === null
                      ? "Suggested based on the term. The installment is negotiable; enter a different amount if agreed."
                      : suggestedMonthly !== null
                        ? (
                            <>
                              Equal installments would be{" "}
                              {formatMoney(cents(suggestedMonthly), money)}.{" "}
                              <button
                                type="button"
                                className="link-btn"
                                onClick={() => setMonthlyOverride(null)}
                              >
                                Use this installment
                              </button>
                            </>
                          )
                        : "Enter the term to see the suggested installment."}
                  </span>
                </div>

                <div className="form-field">
                  <label htmlFor="new-contract-due-day">
                    Due day<span className="required-mark" aria-hidden="true"> *</span>
                  </label>
                  <input
                    id="new-contract-due-day"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="31"
                    value={dueDay}
                    placeholder="5"
                    onChange={(event) => setDueDay(clampDueDayInput(event.target.value))}
                  />
                  <span className="field-hint">
                    Short months are adjusted automatically: a due day of 31 becomes 28 in February.
                  </span>
                </div>
              </>
            )}

            <div className="form-field">
              <label htmlFor="new-contract-signed">
                Signing date<span className="required-mark" aria-hidden="true"> *</span>
              </label>
              <input
                id="new-contract-signed"
                type="date"
                value={signedOn}
                onChange={(event) => setSignedOnOverride(event.target.value)}
              />
              <span className="field-hint">
                {joinContract && signedOnOverride === null
                  ? `Copied from ${joinContract.code}, the other part of this purchase.`
                  : "The payment schedule starts from this date."}
              </span>
            </div>

            {isFinanced && (
              <div className="form-field">
                <label htmlFor="new-contract-first-due">First installment</label>
                <input
                  id="new-contract-first-due"
                  type="date"
                  value={firstDueOn}
                  onChange={(event) => setFirstDueOn(event.target.value)}
                />
                <span className="field-hint">
                  {firstDueOn.trim() === "" && scheduledFirstDue !== null
                    ? `Optional. If left blank, it's due ${formatDate(scheduledFirstDue)}, one month after signing.`
                    : "Only if negotiated separately. Leave blank to set it one month after signing."}
                </span>
              </div>
            )}

            {isReservation && (
              <div className="form-field">
                <label htmlFor="new-contract-expires">
                  Reservation expires<span className="required-mark" aria-hidden="true"> *</span>
                </label>
                <input
                  id="new-contract-expires"
                  type="date"
                  value={expiresOn}
                  onChange={(event) => setExpiresOverride(event.target.value)}
                />
                <span className="field-hint">
                  A reservation without an expiration date keeps the lot off the market indefinitely.
                </span>
              </div>
            )}

            <div className="form-field full-width">
              <label htmlFor="new-contract-notes">Notes</label>
              <textarea
                id="new-contract-notes"
                rows={2}
                value={notes}
                placeholder="e.g. Pays by bank transfer in the first few days of the month."
                onChange={(event) => setNotes(event.target.value)}
              />
              <span className="field-hint">
                Shown in the contracts list below the customer's name.
              </span>
            </div>

            {/* Asked for here rather than only from the contract's panel
                afterwards. The scan and the terms come off the same piece of
                paper, in the same minute — see `ContractDocumentDropzone`. */}
            <div className="form-field full-width">
              <label>Signed contract</label>
              <ContractDocumentDropzone
                files={documents}
                onFilesChange={setDocuments}
                onReject={setError}
                onBusyChange={setDocumentBusy}
                disabled={isSaving}
              />
              <span className="field-hint">
                Optional for now. Uploaded as soon as the contract exists; it can also be attached
                later from the contract.
              </span>
            </div>

            {/* The schedule as it really comes out, not as the two numbers
                above suggest. The last cuota absorbs the rounding, so an agreed
                figure over an agreed term routinely produces a final payment
                that is nothing like the others — and that is worth seeing
                before it is promised to somebody rather than a year later. */}
            {schedule !== null && (
              <p className="form-note full-width">
                <strong>
                  {schedule.count} installment{schedule.count === 1 ? "" : "s"}
                </strong>{" "}
                of {formatMoney(cents(monthlyCents), money)}, from{" "}
                {formatDate(scheduledFirstDue)} a {formatDate(schedule.lastDueOn)}.
                {schedule.lastAmountCents !== monthlyCents && (
                  <>
                    {" "}
                    The last payment is {formatMoney(cents(schedule.lastAmountCents), money)} to
                    account for rounding.
                  </>
                )}
                {schedule.count < (months ?? 0) && (
                  <>
                    {" "}
                    At this installment amount, the balance will be paid off in {schedule.count}
                    months, before the {months}-month term ends.
                  </>
                )}
              </p>
            )}

            {error && <p className="form-error full-width">{error}</p>}
          </div>
        )}

        {/*
          The sale is written and only its paperwork is outstanding.

          The form above is gone rather than merely disabled: those fields no
          longer describe anything this dialog can change, and a price still
          sitting in an editable box next to a button reading "Reintentar" is a
          promise that pressing it would save the new number.
        */}
        {created !== null && (
          <div className="modal-form-grid">
            {/* The same panel carries the upload itself and what is left of it
                if the upload fails, because they are the same situation seen a
                moment apart — the sale is written either way. Only the tone
                changes: nothing has gone wrong while the files are still
                going up. */}
            {isSaving ? (
              <p className="form-note full-width">
                Contract <strong>{created.code}</strong> is saved. Upload the file before closing
                this window.
              </p>
            ) : (
              <p className="form-warning full-width">
                Contract <strong>{created.code}</strong> has been created, and the lot is no
                longer in inventory. Only the file is missing; the terms are saved and can be
                edited from the contract, not here.
              </p>
            )}

            <div className="form-field full-width">
              <label>Signed contract</label>
              <ContractDocumentDropzone
                files={documents}
                onFilesChange={setDocuments}
                onReject={setError}
                onBusyChange={setDocumentBusy}
                disabled={isSaving}
              />
            </div>

            {error && <p className="form-error full-width">{error}</p>}
          </div>
        )}

        <div className="modal-actions">
          {created !== null ? (
            /* Not "Cancelar": there is nothing left to cancel. It closes the
               form and leaves the contract standing, with or without its scan. */
            <button type="button" className="btn-secondary" onClick={close} disabled={isWorking}>
              Close
            </button>
          ) : step === "terms" ? (
            <button type="button" className="btn-secondary" onClick={goBack} disabled={isWorking}>
              Back
            </button>
          ) : (
            <button
              type="button"
              className="btn-secondary"
              onClick={onCancel}
              disabled={isWorking}
            >
              Cancel
            </button>
          )}

          <button
            type="submit"
            className="btn-primary modal-submit"
            disabled={
              isWorking ||
              (created === null && step === "parties" && (customer === null || lot === null))
            }
          >
            <span>
              {documentBusy
                ? documentBusy
                : isSaving
                  ? (savingStep ?? "Saving…")
                : created !== null
                  ? documents.length === 0
                    ? "Done"
                    : "Try again"
                  : step === "parties"
                    ? "Continue"
                    : isReservation
                      ? "Create reservation"
                      : "Create contract"}
            </span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
