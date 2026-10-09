/**
 * Phone numbers, on the screen side.
 *
 * The server stores one canonical form — E.164, "+50499824471" — because that
 * is what WhatsApp needs to deliver a receipt. Nobody here says a number that
 * way, so this file is the translation layer: it writes a stored number out as
 * "9982-4471", and it works out what a typed number will become before the
 * user commits to it.
 *
 * Same shape as lib/area.ts and lib/money.ts: one stored unit, converted at the
 * edges, never in the middle. The server normalises independently and its
 * answer is the one that counts — this is here so the form can show the user
 * what it is about to save.
 */

const HONDURAS_PREFIX = "+504";
const HONDURAS_NATIONAL_DIGITS = 8;

/**
 * Turn what somebody typed into the stored form, or `null` if it cannot be one.
 *
 * Kept deliberately in step with backend/src/lib/phone.ts. Where the two ever
 * disagree the server wins, which is why the form treats this as a preview and
 * still shows whatever the server says on refusal.
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();

  if (trimmed === "") {
    return null;
  }

  const isInternational = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (digits === "") {
    return null;
  }

  if (isInternational) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  if (digits.length === HONDURAS_NATIONAL_DIGITS) {
    return `${HONDURAS_PREFIX}${digits}`;
  }

  if (digits.startsWith("504") && digits.length === 11) {
    return `+${digits}`;
  }

  return null;
}

/**
 * A stored number, written the way people here read it.
 *
 * A Honduran number drops its country code and takes the familiar dash —
 * "9982-4471" — because printing "+50499824471" in a table would be technically
 * correct and unreadable. A foreign number keeps its country code: without it
 * the number is not merely ugly, it is wrong.
 */
export function formatPhone(phone: string): string {
  if (phone.startsWith(HONDURAS_PREFIX)) {
    const national = phone.slice(HONDURAS_PREFIX.length);

    if (national.length === HONDURAS_NATIONAL_DIGITS) {
      return `${national.slice(0, 4)}-${national.slice(4)}`;
    }
  }

  return phone;
}

/* -------------------------------------------------------------------------- */
/* Country codes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The dial code used when nothing else matches.
 *
 * A stored number whose country code is not in the list below is NOT quietly
 * reassigned to Honduras — it keeps every digit it has and is shown under
 * "Otro país", where the user can see and correct it. Silently adopting a
 * foreign number as a local one is the failure that sends a receipt to a
 * stranger.
 */
export const OTHER_DIAL = "+";

export interface CountryCode {
  /** Dial code including the plus, e.g. "+504". */
  dial: string;
  label: string;
  /**
   * How many digits the national number has, where the country has a single
   * fixed length. `null` means "varies", and only the generic E.164 bounds are
   * enforced. Only Honduras is worth being strict about here: it is the number
   * everyone types, and eight digits is unambiguous.
   */
  nationalDigits: number | null;
}

/**
 * The countries this business actually deals with, Honduras first.
 *
 * Deliberately short. A picker with every country on earth is slower to use
 * than typing, and the honest fallback for anywhere else is "Otro país", which
 * accepts the full international number as written.
 */
export const COUNTRY_CODES: readonly CountryCode[] = [
  { dial: "+504", label: "Honduras", nationalDigits: 8 },
  { dial: "+502", label: "Guatemala", nationalDigits: null },
  { dial: "+503", label: "El Salvador", nationalDigits: null },
  { dial: "+505", label: "Nicaragua", nationalDigits: null },
  { dial: "+506", label: "Costa Rica", nationalDigits: null },
  { dial: "+507", label: "Panama", nationalDigits: null },
  { dial: "+1", label: "US / Canada", nationalDigits: null },
  { dial: "+52", label: "Mexico", nationalDigits: null },
  { dial: "+34", label: "Spain", nationalDigits: null },
  { dial: OTHER_DIAL, label: "Other country", nationalDigits: null },
];

/** The default for a new customer: the country the land is in. */
export const DEFAULT_DIAL = "+504";

export interface PhoneParts {
  dialCode: string;
  /** The number without its country code, digits only. */
  national: string;
}

/**
 * Split a stored number into the two fields the form edits.
 *
 * Longest dial code wins, so "+1" never claims a "+1..." that is really
 * something else, and a number under an unknown code lands whole under
 * "Otro país" rather than losing its first digits.
 */
export function splitPhone(phone: string): PhoneParts {
  const digits = phone.replace(/\D/g, "");

  const known = COUNTRY_CODES.filter(
    (country) => country.dial !== OTHER_DIAL && phone.startsWith(country.dial),
  ).sort((a, b) => b.dial.length - a.dial.length)[0];

  if (known) {
    return { dialCode: known.dial, national: digits.slice(known.dial.length - 1) };
  }

  return { dialCode: OTHER_DIAL, national: digits };
}

/** Put the two fields back together as the number that will be sent. */
export function joinPhone(dialCode: string, national: string): string {
  return `${dialCode}${national.replace(/\D/g, "")}`;
}

/**
 * What is wrong with these two fields, or `null` if nothing is.
 *
 * Blank is not a problem: the phone is optional, and a customer who paid a lot
 * outright in one visit may simply never have come up in a conversation that
 * needed a number. This only has something to say once digits have actually
 * been typed and do not add up to a usable number.
 *
 * The server validates independently and its answer is the one that counts.
 * This exists so the form can say which part is wrong while the user is still
 * looking at it.
 */
export function describePhoneProblem(dialCode: string, national: string): string | null {
  const digits = national.replace(/\D/g, "");

  if (digits === "") {
    return null;
  }

  const country = COUNTRY_CODES.find((entry) => entry.dial === dialCode);

  if (country?.nationalDigits && digits.length !== country.nationalDigits) {
    return `A phone number from ${country.label} has ${country.nationalDigits} digits.`;
  }

  // The generic E.164 bounds, for everywhere the list is not strict about.
  return normalizePhone(joinPhone(dialCode, digits)) === null
    ? "That number doesn't have a valid number of digits."
    : null;
}
