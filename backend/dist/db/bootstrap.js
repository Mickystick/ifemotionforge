import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { z } from "zod";
import { loadConfig } from "../config/env.js";
import { hashPassword } from "../lib/password.js";
import { createDb } from "./client.js";
import { users } from "./schema.js";
/**
 * Creates the one account a fresh database has no other way to get: the first
 * owner. `db:seed` plants fictional demo data and refuses in production (see
 * seed.ts); this asks for a real name, email and password, interactively, and
 * writes only that.
 *
 * Refuses to run if any user already exists — same rule as `db:seed`, so this
 * can never turn into a second, unwanted owner account.
 */
const MINIMUM_PASSWORD_LENGTH = 8;
// Named via fromCharCode rather than a \u escape so the byte is unambiguous
// on every editor and platform this file is opened on.
const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(8);
const DELETE = String.fromCharCode(127);
const emailSchema = z.string().trim().min(1).max(320).email();
if (!stdin.isTTY) {
    console.error("db:bootstrap needs an interactive terminal to type a password into — stdin is not a TTY. " +
        "Run it directly (not piped or redirected).");
    process.exit(1);
}
const config = loadConfig();
const { db, sqlite } = createDb(config.databasePath);
const existing = db.select({ id: users.id }).from(users).all();
if (existing.length > 0) {
    console.log("Database already has users — bootstrap refused. Sign in and use the app to add more accounts.");
    sqlite.close();
    process.exit(0);
}
const rl = createInterface({ input: stdin, output: stdout });
/** Plain, echoed prompt — retries until the answer passes `validate`. */
async function ask(prompt, validate) {
    for (;;) {
        const answer = (await rl.question(prompt)).trim();
        const error = validate(answer);
        if (error === null) {
            return answer;
        }
        console.log(error);
    }
}
/**
 * Masked prompt for a password. Bypasses readline: takes stdin into raw mode
 * so each keystroke arrives one at a time instead of only after Enter, echoes
 * `*` instead of the character typed, and handles backspace itself.
 */
function askPassword(prompt) {
    return new Promise((resolve) => {
        stdout.write(prompt);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf8");
        let value = "";
        const finish = (result) => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener("data", onData);
            stdout.write("\n");
            resolve(result);
        };
        const onData = (chunk) => {
            for (const char of chunk) {
                if (char === CTRL_C) {
                    // Restore the terminal before leaving, or the shell is left in raw
                    // mode — invisible typing — after the process exits.
                    stdin.setRawMode(false);
                    stdout.write("\n");
                    process.exit(130);
                }
                else if (char === "\r" || char === "\n") {
                    finish(value);
                    return;
                }
                else if (char === BACKSPACE || char === DELETE) {
                    if (value.length > 0) {
                        value = value.slice(0, -1);
                        stdout.write(BACKSPACE + " " + BACKSPACE);
                    }
                }
                else {
                    value += char;
                    stdout.write("*");
                }
            }
        };
        stdin.on("data", onData);
    });
}
async function askNewPassword() {
    for (;;) {
        const password = await askPassword("Owner password: ");
        if (password.length < MINIMUM_PASSWORD_LENGTH) {
            console.log(`Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
            continue;
        }
        const confirmation = await askPassword("Confirm password: ");
        if (confirmation !== password) {
            console.log("Passwords didn't match — let's try again.");
            continue;
        }
        return password;
    }
}
const name = await ask("Owner name: ", (value) => (value.length > 0 ? null : "Name can't be empty."));
const email = await ask("Owner email: ", (value) => {
    const parsed = emailSchema.safeParse(value);
    return parsed.success ? null : "That doesn't look like a valid email address.";
});
rl.close();
const password = await askNewPassword();
const id = randomUUID();
const passwordHash = await hashPassword(password);
// Stored lowercase because login always lowercases the typed email before
// looking it up (see routes/auth.ts) — storing it any other way would lock
// the owner out the moment they typed their own email in a different case.
db.insert(users)
    .values({ id, email: email.toLowerCase(), name, role: "owner", passwordHash })
    .run();
sqlite.close();
console.log(`Owner account created: ${email.toLowerCase()}`);
//# sourceMappingURL=bootstrap.js.map