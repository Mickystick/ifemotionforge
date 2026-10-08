import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
const SALT_BYTES = 16;
const KEY_BYTES = 64;
/**
 * Password hashing with scrypt, which is built into Node — no native module to
 * compile, nothing to keep patched.
 *
 * scrypt is deliberately slow and memory-hungry, so an attacker who steals the
 * database still cannot test guesses quickly. Every password gets its own
 * random salt, so two people who choose the same password get different
 * hashes, and one cracked password reveals nothing about the other.
 */
export async function hashPassword(plainPassword) {
    const salt = randomBytes(SALT_BYTES).toString("hex");
    const derived = (await scrypt(plainPassword, salt, KEY_BYTES));
    return `scrypt$${salt}$${derived.toString("hex")}`;
}
/**
 * Check a password against a stored hash.
 *
 * The comparison uses `timingSafeEqual` rather than `===`: a normal string
 * comparison returns faster when the first character is wrong, and that timing
 * difference can be measured and used to guess a hash byte by byte.
 */
export async function verifyPassword(plainPassword, storedHash) {
    const [algorithm, salt, hash] = storedHash.split("$");
    if (algorithm !== "scrypt" || !salt || !hash) {
        return false;
    }
    const expected = Buffer.from(hash, "hex");
    const actual = (await scrypt(plainPassword, salt, expected.length));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}
//# sourceMappingURL=password.js.map