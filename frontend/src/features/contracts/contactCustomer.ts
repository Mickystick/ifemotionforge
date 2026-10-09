/**
 * Writing to a customer from the Contratos list.
 *
 * Three ways out of the app, each of which hands the message to something the
 * device already has rather than sending anything itself. Lindero has no
 * outbound mail server and no WhatsApp Business number — see the note at the
 * top of features/receipts/whatsapp.ts for why the Cloud API is not built —
 * so every one of these opens the user's own WhatsApp, messages app or mail
 * client with the text already written. The send is a person's decision, taken
 * in their own client, and nothing leaves this machine until they make it.
 *
 * That is also why nothing here is recorded as a contact attempt. A draft
 * opened is not a message sent: the user may close it, rewrite it, or send it
 * an hour later, and a log that counted the click would be a log of
 * intentions. The audit trail records money, not gestures.
 */

import { formatMoney } from "../../lib/money";
import type { MoneyView } from "../../lib/money";
import type { Contract } from "../../types";

/** The three ways out, in the order they appear beside a row. */
export type ContactChannel = "whatsapp" | "sms" | "email";

/**
 * What the message says before the user changes it.
 *
 * The brief was that it must carry the lot number and the contract id, and it
 * does — but leading with them would open a message to a customer with an
 * internal reference, so the greeting comes first and the identifiers follow in
 * the line that needs them. Somebody who bought three lots gets three different
 * messages, which is the entire point of the identifiers being there.
 *
 * Deliberately NOT a demand for payment. The same button is pressed to answer a
 * question, confirm a receipt or chase a cuota, and a template that opened with
 * "you owe" would be wrong two times in three — and unpleasant the third. What
 * is owed is stated as a fact only when something actually is.
 */
export function defaultMessage(contract: Contract, money: MoneyView): string {
  const greeting = `Good morning, ${firstName(contract.customer.fullName)}.`;
  const reference = `We're contacting you about lot ${contract.lot.code} (${contract.lot.projectName}), contract ${contract.code}.`;

  if (contract.health.arrears > 0) {
    return `${greeting} ${reference} You have an overdue balance of ${formatMoney(
      contract.health.arrears,
      money,
    )}. Can we coordinate payment?`;
  }

  if (contract.health.nextDueOn && contract.health.nextDueAmount > 0) {
    // The regular cuota, with any advance named beside it, the same way the
    // screens show it: "L 7,249.51" would read as a different cuota.
    const advance =
      contract.health.nextDueCredit > 0
        ? ` ${formatMoney(contract.health.nextDueCredit, money)} has already been paid toward that installment.`
        : "";

    return `${greeting} ${reference} Your next installment is ${formatMoney(
      contract.health.nextInstallment,
      money,
    )}, due on ${formatDueDate(contract.health.nextDueOn)}.${advance}`;
  }

  return `${greeting} ${reference}`;
}

/** The subject line, for the one channel that has one. */
export function defaultSubject(contract: Contract): string {
  return `Lot ${contract.lot.code} · Contract ${contract.code}`;
}

/**
 * Just the first name, because "Buenos días, María Fernanda Rodríguez Paz" is
 * how a bank writes and not how anybody here speaks.
 */
function firstName(fullName: string): string {
  const [first] = fullName.trim().split(/\s+/);

  return first ?? fullName;
}

/** "15 de marzo" — inside a sentence, so no year and no abbreviation. */
function formatDueDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);

  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year!, month! - 1, day!)));
}

/**
 * Can this channel actually be used for this customer?
 *
 * A button for a channel with no address behind it is disabled rather than
 * hidden: a missing email is a gap in the customer's record worth seeing, and a
 * row whose buttons come and go is harder to use than a row whose buttons are
 * always in the same three places.
 */
export function canContact(contract: Contract, channel: ContactChannel): boolean {
  if (channel === "email") {
    return (contract.customer.email ?? "").trim() !== "";
  }

  return (contract.customer.phone ?? "").trim() !== "";
}

/**
 * The URL that opens the right app with the message already in it.
 *
 * `wa.me` wants bare digits with the country code and no plus — the same form
 * `features/receipts/whatsapp.ts` builds, and for the same reason: the number
 * comes from the customer's own record, so the chat that opens is provably the
 * right person's rather than whoever a contact picker lands on.
 *
 * `sms:` takes the number as stored, E.164 and all. The `?&body=` spelling is
 * the one that works on both iOS and Android — iOS needs the `&` after `?`
 * when there is no recipient list separator, and Android tolerates it.
 */
export function contactUrl(
  contract: Contract,
  channel: ContactChannel,
  message: string,
  subject: string,
): string {
  // Only called once `canContact` has already gated the button on this being
  // non-empty; the fallback here is for the type checker, not a real case.
  const phone = contract.customer.phone ?? "";

  if (channel === "whatsapp") {
    return `https://wa.me/${phone.replace(/\D/g, "")}?text=${encodeURIComponent(message)}`;
  }

  if (channel === "sms") {
    return `sms:${phone}?&body=${encodeURIComponent(message)}`;
  }

  const email = (contract.customer.email ?? "").trim();

  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(message)}`;
}

/** What each button is called, for its tooltip and its screen-reader label. */
export const CHANNEL_LABELS: Record<ContactChannel, string> = {
  whatsapp: "Send WhatsApp message",
  sms: "Send text message",
  email: "Send email",
};

/** Why a button is off, said in the tooltip rather than left to be guessed. */
export const CHANNEL_MISSING: Record<ContactChannel, string> = {
  whatsapp: "This customer has no phone number on file",
  sms: "This customer has no phone number on file",
  email: "This customer has no email address on file",
};
