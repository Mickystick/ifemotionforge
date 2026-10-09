import { formatPhone } from "./phone";

/**
 * The número de identidad, on the screen side.
 *
 * The column is nullable — an identidad is confidential, and plenty of buyers
 * are on file before anybody has one — so "there isn't one" is an ordinary
 * answer that every screen has to be able to give. It is given in two different
 * ways, and the difference matters:
 *
 * - `identificationLabel` is for a field with a heading of its own, where the
 *   row exists whether or not it is filled and a blank cell reads as a bug.
 * - `customerLine` is for a run-on line under somebody's name, where the label
 *   is the punctuation and an absent identidad has to take its separator with
 *   it. "· 9982-4471" hanging off nothing is the failure this prevents.
 *
 * Both live here rather than beside one of the six screens that need them,
 * because the interesting part is the decision, and six copies of a decision is
 * five chances to make it differently.
 */

/** What to show where a field is expected: the number, or that there isn't one. */
export function identificationLabel(identification: string | null): string {
  const trimmed = identification?.trim() ?? "";

  return trimmed === "" ? "No ID" : trimmed;
}

/** True when the label above is standing in for a number rather than showing one. */
export function hasIdentification(identification: string | null): boolean {
  return (identification?.trim() ?? "") !== "";
}

/**
 * "0801-1990-04412 · 9982-4471" — how a customer is told apart from another of
 * the same name, with whichever half is missing dropped along with its
 * separator.
 *
 * The phone is written the local way, never raw: it is stored as
 * "+50499824471" so WhatsApp can dial it, and nobody reads it that way.
 */
export function customerLine(customer: {
  identification: string | null;
  phone: string | null;
}): string {
  const identification = customer.identification?.trim() ?? "";
  const phone = customer.phone?.trim() ?? "";

  return [identification, phone ? formatPhone(phone) : ""]
    .filter((part) => part !== "")
    .join(" · ");
}
