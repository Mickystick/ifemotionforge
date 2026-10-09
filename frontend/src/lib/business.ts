/**
 * Who the receipt is FROM.
 *
 * Lindero is the name of the software; Inversiones Manuel is the name of the
 * business that hands a customer a piece of paper. The receipt used to be
 * headed "Lindero", which named the wrong one of the two — the customer has
 * never heard of the app and is not paying it.
 *
 * These are the strings from the official receipt template (`server.js` in
 * inversion_pdf_service), collected here rather than scattered through the
 * markup so that a changed phone number is one edit in one file. They are
 * constants rather than settings because there is exactly one business in this
 * database; the day there are two, this becomes a table and the receipt reads
 * it instead.
 */
export const BUSINESS = {
  /** The trading name, printed under the logo. */
  name: "Inversiones Manuel",
  /** Whose signature appears above "Firma Autorizada". */
  signatory: "Manuel Rivera",
  location: "Tela, Atlántida",
  phone: "+504 9315-4685",
  email: "edrosfamily@gmail.com",
} as const;

export const THANK_YOU = `Thank you for your payment and for trusting ${BUSINESS.name}.`;

/**
 * The footer's one-line contact strip, composed rather than stored whole so it
 * cannot drift out of step with the fields above it.
 */
export const CONTACT_LINE = [
  BUSINESS.name,
  BUSINESS.location,
  `Tel: ${BUSINESS.phone}`,
  `Email: ${BUSINESS.email}`,
].join(" | ");
