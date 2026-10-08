/**
 * Reading the two timestamp shapes this database contains.
 *
 * Rows written by the application carry a full ISO-8601 string with a `Z`
 * ("2026-08-28T01:23:45.678Z"). Rows written by a column's `CURRENT_TIMESTAMP`
 * default carry SQLite's own format, which is UTC but says so nowhere
 * ("2026-08-26 15:02:23"). Handed to `new Date()` the second one is read as
 * LOCAL time, which quietly shifts it by the timezone offset.
 *
 * So both are normalised here, in one place, rather than at each call site.
 */
export function parseTimestamp(value) {
    const trimmed = value.trim();
    // Already carries a zone — ISO with Z, or with a +hh:mm / -hh:mm offset.
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
    const normalised = hasZone ? trimmed : `${trimmed.replace(" ", "T")}Z`;
    return new Date(normalised).getTime();
}
/**
 * Today's calendar date in the BUSINESS's timezone: "2026-08-31".
 *
 * `new Date().toISOString().slice(0, 10)` is the obvious spelling and it is
 * wrong everywhere east of UTC and west of it alike. It reads the date in UTC,
 * so in Tegucigalpa — six hours behind — every evening from 18:00 onwards it
 * answers with tomorrow. A payment taken at half past nine at night was filed
 * on the next day, an installment due today was already counted late, and the
 * Panel General opened on a month that had not started.
 *
 * `Intl` is asked for the parts rather than handed a locale that happens to
 * print ISO order. "en-CA" does produce YYYY-MM-DD today, but that is a
 * property of a locale's formatting conventions, not a guarantee, and a
 * date-ordering change in a future ICU release must not silently reorder the
 * day and the month in a database column.
 */
export function businessToday(timeZone, now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);
    const find = (type) => parts.find((part) => part.type === type)?.value ?? "";
    return `${find("year")}-${find("month")}-${find("day")}`;
}
//# sourceMappingURL=time.js.map