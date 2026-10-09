import { useEffect, useState } from "react";

import { formatRate, formatRateInput, parseMoneyInput } from "../../lib/money";
import type { ExchangeRate } from "./api";
import { setManualRate, setRateAdjustment, useMarketRate } from "./api";

interface RatePanelProps {
  rate: ExchangeRate;
  /** Only a supervisor may change it; everyone else just reads the number. */
  canEdit: boolean;
  onChanged: (rate: ExchangeRate) => void;
  onDone: () => void;
}

/** "hace 3 horas" — how old a reading is, in words. */
export function describeAge(capturedAt: string | null): string {
  if (!capturedAt) {
    return "not updated";
  }

  const minutes = Math.max(0, Math.round((Date.now() - new Date(capturedAt).getTime()) / 60000));

  if (minutes < 60) {
    return minutes <= 1 ? "just now" : `${minutes} minutes ago`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }

  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

const SOURCE_LABELS: Record<ExchangeRate["source"], string> = {
  auto: "Automatic",
  manual: "Manual",
  default: "Not set",
};

/**
 * The lempira-per-dollar rate: where it came from, how old it is, and — for a
 * supervisor — how to change it.
 *
 * It no longer has a button of its own in the header. The rate is a property of
 * showing prices in dollars, so it lives behind the USD toggle: the second tap
 * on USD opens this. That keeps one less control on a phone header that had
 * grown too wide to fit.
 */
export function RatePanel({ rate, canEdit, onChanged, onDone }: RatePanelProps) {
  const [draft, setDraft] = useState(() => formatRateInput(formatRate(rate.rate)));
  const [adjustmentDraft, setAdjustmentDraft] = useState(() => String(rate.adjustmentPercent));
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  // Follow the rate if it changes underneath — a scheduled refresh, or another
  // save — as long as the user is not midway through typing their own.
  useEffect(() => {
    setDraft(formatRateInput(formatRate(rate.rate)));
  }, [rate.rate]);

  useEffect(() => {
    setAdjustmentDraft(String(rate.adjustmentPercent));
  }, [rate.adjustmentPercent]);

  const run = async (action: () => Promise<ExchangeRate>) => {
    setError(null);
    setSaving(true);

    try {
      onChanged(await action());
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to update the rate.");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    const value = parseMoneyInput(draft);

    if (!Number.isFinite(value) || value <= 0) {
      setError("Enter how many lempiras equal one US dollar.");
      return;
    }

    void run(() => setManualRate(value));
  };

  const handleAdjust = () => {
    const percent = Number(adjustmentDraft.replace(",", ".").trim());

    if (!Number.isFinite(percent)) {
      setError("Enter the adjustment as a percentage, for example 0.33.");
      return;
    }

    void run(() => setRateAdjustment(percent));
  };

  return (
    <div className="rate-panel">
      <p className="rate-headline">
        <span className="rate-headline-value">L. {formatRate(rate.rate)}</span>
        <span className="rate-headline-unit">per US dollar</span>
      </p>

      <p className="rate-panel-head">
        <strong>{SOURCE_LABELS[rate.source]}</strong>
        <span> · {describeAge(rate.capturedAt)}</span>
      </p>

      {rate.source === "auto" && rate.provider && (
        <p className="field-hint">
          From {rate.provider}
          {/*
            Both numbers, whenever they differ. An adjustment nobody can see is
            indistinguishable from a feed that is simply wrong — and the next
            person to ask why Lindero says one thing and a search says another
            gets the answer on the same screen as the question.
          */}
          {rate.providerRate !== null && rate.adjustmentPercent !== 0 && (
            <>
              {" "}
              to L. {formatRate(rate.providerRate)}, plus an adjustment of{" "}
              {rate.adjustmentPercent > 0 ? "+" : ""}
              {rate.adjustmentPercent} %
            </>
          )}
          .
        </p>
      )}

      {rate.source === "manual" && rate.adjustmentPercent !== 0 && (
        <p className="field-hint">
          The {rate.adjustmentPercent > 0 ? "+" : ""}
          {rate.adjustmentPercent} % adjustment is saved, but doesn't apply to a manually entered
          rate. Switch back to automatic to apply it.
        </p>
      )}
      {rate.source === "default" && (
        <p className="field-hint">
          No rate has been recorded yet. A reference value is being shown.
        </p>
      )}
      {rate.isStale && rate.source !== "default" && (
        <p className="field-hint">This rate hasn't been updated in more than two days.</p>
      )}

      {canEdit ? (
        <>
          {/*
            Two fields, and the difference between them is the whole point.

            The first overrides the feed and freezes it: the number typed is the
            number shown, until somebody asks for automatic again. The second
            stays pinned to the feed and travels with it. "The market moved and
            nobody told us" wants the first; "the market rate is not the number
            people here quote" wants the second, and using the first for it
            means retyping a rate by hand every morning forever.
          */}
          <div className="rate-edit">
            <label htmlFor="rate-input">Lempiras per US dollar</label>
            <div className="rate-edit-row">
              <input
                id="rate-input"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={draft}
                onChange={(event) => setDraft(formatRateInput(event.target.value))}
              />
              <button
                type="button"
                className="btn-primary"
                disabled={isSaving}
                onClick={handleSave}
              >
                {isSaving ? "Saving…" : "Save"}
              </button>
            </div>
            <span className="field-hint">
              Entering a rate fixes it: it will no longer follow the market until someone
              switches it back.
            </span>
          </div>

          <div className="rate-edit">
            <label htmlFor="rate-adjustment">Adjustment to the market rate (%)</label>
            <div className="rate-edit-row">
              <input
                id="rate-adjustment"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={adjustmentDraft}
                onChange={(event) => setAdjustmentDraft(event.target.value)}
              />
              <button
                type="button"
                className="btn-secondary"
                disabled={isSaving}
                onClick={handleAdjust}
              >
                Save adjustment
              </button>
            </div>
            <span className="field-hint">
              The provider publishes the market rate, while banks buy and sell above or below
              it. Use a percentage, not a fixed amount, so the adjustment keeps the same meaning
              as the rate changes: at 0.33%, a rate of 26.8118 is shown as 26.9003.
            </span>
          </div>

          {error && <p className="form-error">{error}</p>}

          <div className="rate-actions">
            <button
              type="button"
              className="btn-secondary"
              disabled={isSaving}
              onClick={() => void run(useMarketRate)}
            >
              Switch to automatic
            </button>
          </div>
        </>
      ) : (
        <p className="field-hint">Only an owner can change it.</p>
      )}

      {/* The one thing everybody must understand about this number. */}
      <p className="rate-caveat">
        For display only. Each payment stores the rate used when it was received, and balances
        are never recalculated using this rate.
      </p>
    </div>
  );
}
