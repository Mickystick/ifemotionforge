/**
 * Phone numbers, stored in one canonical shape.
 *
 * A phone number in this app is not decoration. It is the address a receipt or
 * a reminder will eventually be sent to over WhatsApp, and WhatsApp will not
 * accept "9982-4471" — it wants 50499824471, digits only, country code
 * included. So the number is normalised HERE, at the API boundary, and stored
 * as E.164 ("+50499824471"). The frontend writes it back out as "9982-4471",
 * which is how people say it here.
 *
 * This is the same argument as money in centavos and areas in square metres:
 * one stored form, converted at the edges. The alternative — keeping whatever
 * each person typed and guessing at send time — means the guess has to be made
 * once per message, forever, and it only has to be wrong once to send somebody
 * else's receipt to a stranger.
 *
 * Honduras is +504 with eight national digits. A number typed without a country
 * code is assumed to be Honduran, because that is where the land is; anything
 * written with an explicit "+" is kept as the international number it is, so a
 * customer living abroad is not mangled into a local one.
 */
const HONDURAS_CODE = "504";
const HONDURAS_NATIONAL_DIGITS = 8;
/**
 * Turn what somebody typed into a storable E.164 number, or `null` if it cannot
 * be one.
 *
 * Accepts the shapes people actually write: "9982-4471", "9982 4471",
 * "+504 9982-4471", "(504) 99824471".
 */
export function normalizePhone(input) {
    const trimmed = input.trim();
    if (trimmed === "") {
        return null;
    }
    // A leading "+" is the one piece of punctuation that carries meaning: it says
    // "what follows already includes a country code, do not add one".
    const isInternational = trimmed.startsWith("+");
    const digits = trimmed.replace(/\D/g, "");
    if (digits === "") {
        return null;
    }
    if (isInternational) {
        // E.164 allows at most fifteen digits, and nothing real is shorter than
        // eight. Outside that range it is a typo, not a phone number.
        return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
    }
    if (digits.length === HONDURAS_NATIONAL_DIGITS) {
        return `+${HONDURAS_CODE}${digits}`;
    }
    // "50499824471" — the country code typed without its plus.
    if (digits.startsWith(HONDURAS_CODE) &&
        digits.length === HONDURAS_CODE.length + HONDURAS_NATIONAL_DIGITS) {
        return `+${digits}`;
    }
    return null;
}
//# sourceMappingURL=phone.js.map