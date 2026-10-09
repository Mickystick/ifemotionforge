import { randomUUID } from "node:crypto";

import { desc } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { exchangeRates } from "../db/schema.js";
import { parseTimestamp } from "./time.js";

/**
 * The lempira-per-dollar rate shown in the interface.
 *
 * DISPLAY ONLY, and worth repeating because the distinction is the whole
 * design: this converts figures on screen so a buyer can be told roughly what a
 * lot costs in dollars. It never computes a balance. Every payment stores the
 * rate it was actually settled at, and the accounts are built from those.
 *
 * The provider publishes an indicative market rate. It is not the rate a
 * Honduran bank pays out at, which carries a buy/sell spread, and it is not the
 * Banco Central's official rate. It is a good default for a price tag and a bad
 * one for a receipt.
 */
export const PROVIDER_NAME = "exchangerate-api.com";

const PROVIDER_URL = "https://open.er-api.com/v6/latest/USD";

const FETCH_TIMEOUT_MS = 8000;

/**
 * What to show before the first reading ever arrives — a fresh install with no
 * internet. Marked as `default` in the API response so the interface can say
 * the number is a placeholder rather than a quote.
 */
export const FALLBACK_RATE = 24.7;

/** A reading older than this is shown as stale rather than as today's number. */
const STALE_AFTER_HOURS = 48;

/**
 * Rates outside this range are refused. A provider outage that returns 0, or a
 * fat-fingered 2682 instead of 26.82, would otherwise quietly multiply every
 * dollar figure on screen by a hundred.
 */
const MIN_RATE = 1;
const MAX_RATE = 1000;

/**
 * How far the displayed rate may be nudged off the provider's figure, either
 * way, in percent.
 *
 * The gap this is meant to close is a fraction of a percent — a bank's spread,
 * or the difference between one indicative feed and the one somebody searched.
 * Anything beyond a couple of points is not a calibration, it is somebody
 * inventing an exchange rate, and the whole value of showing the provider's
 * number beside the adjusted one is that the second is visibly derived from
 * the first.
 */
const MAX_ADJUSTMENT_PERCENT = 2;

export function isPlausibleAdjustment(percent: number): boolean {
  return Number.isFinite(percent) && Math.abs(percent) <= MAX_ADJUSTMENT_PERCENT;
}

/**
 * The provider's figure, nudged by the adjustment in force.
 *
 * Rounded to six decimals because the arithmetic is floating point and the
 * inputs are not: 26.811824 * 1.0033 lands on 26.90029319200000_3 or thereabouts
 * depending on the platform, and there is no reason to store that when the
 * number is only ever displayed to four.
 */
export function applyAdjustment(providerRate: number, percent: number): number {
  return Math.round(providerRate * (1 + percent / 100) * 1e6) / 1e6;
}

export type RateSource = "auto" | "manual";

export interface RateReading {
  /** What to show: the provider's figure with the adjustment already in it. */
  rate: number;
  /** What the provider said, or null where nobody asked one. */
  providerRate: number | null;
  /** The adjustment in force, in percent. Zero where none has been set. */
  adjustmentPercent: number;
  source: RateSource | "default";
  provider: string | null;
  capturedAt: string | null;
  setBy: string | null;
}

export function isPlausibleRate(rate: number): boolean {
  return Number.isFinite(rate) && rate > MIN_RATE && rate < MAX_RATE;
}

/**
 * Ask the provider what a dollar is worth in lempiras.
 *
 * Throws on anything unusable — a timeout, a bad payload, an implausible
 * number. Callers decide what to do about it; the one thing they must not do is
 * write a number they cannot vouch for.
 */
export async function fetchMarketRate(): Promise<number> {
  const response = await fetch(PROVIDER_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`The provider responded with status ${response.status}.`);
  }

  const payload = (await response.json()) as { rates?: Record<string, unknown> };
  const value = payload.rates?.HNL;

  if (typeof value !== "number" || !isPlausibleRate(value)) {
    throw new Error("The provider did not return a usable lempira exchange rate.");
  }

  return value;
}

/** The rate in force: the most recent reading, whatever its source. */
export function readCurrentRate(db: Db): RateReading {
  const row = db
    .select()
    .from(exchangeRates)
    .orderBy(desc(exchangeRates.capturedAt))
    .limit(1)
    .get();

  if (!row) {
    return {
      rate: FALLBACK_RATE,
      providerRate: null,
      adjustmentPercent: 0,
      source: "default",
      provider: null,
      capturedAt: null,
      setBy: null,
    };
  }

  return {
    rate: Number(row.rate),
    // Null on every row written before adjustments existed, which is honest:
    // that reading was the provider's number, but this column cannot say so
    // retroactively without claiming to know something it does not.
    providerRate: row.providerRate === null ? null : Number(row.providerRate),
    adjustmentPercent: row.adjustmentPercent === null ? 0 : Number(row.adjustmentPercent),
    source: row.source === "manual" ? "manual" : "auto",
    provider: row.provider,
    capturedAt: row.capturedAt,
    setBy: row.setBy,
  };
}

export function isStale(reading: RateReading): boolean {
  if (reading.capturedAt === null) {
    return true;
  }

  const capturedAt = parseTimestamp(reading.capturedAt);

  if (Number.isNaN(capturedAt)) {
    return true;
  }

  return Date.now() - capturedAt > STALE_AFTER_HOURS * 60 * 60 * 1000;
}

interface RecordRateInput {
  /** The number to display, adjustment already applied. */
  rate: number;
  /** What the provider said. Null on a manual reading; nobody asked one. */
  providerRate?: number | null;
  /**
   * The adjustment setting at this moment, in percent.
   *
   * Written on manual rows too, where it had no part in `rate`. It is the
   * setting, not a description of this reading, and storing it here is what
   * carries it across an override — the alternative is a settings table
   * holding one number.
   */
  adjustmentPercent: number;
  source: RateSource;
  /** Null for automatic readings — nobody typed them. */
  actorId: string | null;
}

/**
 * Append a reading. Nothing is ever overwritten; the newest row wins.
 *
 * Takes a transaction handle as readily as the database handle, so a rate and
 * its audit row commit together — the same arrangement `recordAudit` uses.
 */
export function recordRate(db: Pick<Db, "insert">, input: RecordRateInput): RateReading {
  const row = db
    .insert(exchangeRates)
    .values({
      id: randomUUID(),
      // `String(number)` keeps the provider's decimals without inventing any.
      rate: String(input.rate),
      providerRate:
        input.providerRate === undefined || input.providerRate === null
          ? null
          : String(input.providerRate),
      adjustmentPercent: String(input.adjustmentPercent),
      source: input.source,
      provider: input.source === "auto" ? PROVIDER_NAME : null,
      setBy: input.actorId,
      capturedAt: new Date().toISOString(),
    })
    .returning()
    .get();

  return {
    rate: Number(row.rate),
    providerRate: row.providerRate === null ? null : Number(row.providerRate),
    adjustmentPercent: Number(row.adjustmentPercent),
    source: input.source,
    provider: row.provider,
    capturedAt: row.capturedAt,
    setBy: row.setBy,
  };
}

/**
 * Fetch and store today's rate, unless a supervisor has taken manual control.
 *
 * A manual rate is a deliberate decision — usually because the market feed
 * disagrees with what the bank is actually paying — so the scheduler leaves it
 * alone until somebody explicitly asks for automatic updates again. Silently
 * overwriting it a few hours later would make the override useless.
 */
export async function refreshAutomaticRate(
  db: Db,
): Promise<{ status: "updated" | "skipped_manual" | "failed"; rate?: number; error?: string }> {
  const current = readCurrentRate(db);

  if (current.source === "manual") {
    return { status: "skipped_manual" };
  }

  try {
    const providerRate = await fetchMarketRate();
    // The adjustment travels with the readings rather than being re-decided
    // here, so a scheduled refresh cannot quietly drop the calibration a
    // supervisor set — it applies whatever was last in force.
    const rate = applyAdjustment(providerRate, current.adjustmentPercent);

    recordRate(db, {
      rate,
      providerRate,
      adjustmentPercent: current.adjustmentPercent,
      source: "auto",
      actorId: null,
    });

    return { status: "updated", rate };
  } catch (caught) {
    // A failed fetch keeps the last known reading. Showing an old rate labelled
    // with its age is honest; showing nothing, or a guess, is not.
    return { status: "failed", error: caught instanceof Error ? caught.message : "desconocido" };
  }
}
