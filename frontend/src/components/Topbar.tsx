import { useRef, useState } from "react";

import type { ExchangeRate } from "../features/rate/api";
import { RatePanel } from "../features/rate/RatePanel";
import type { Currency } from "../lib/money";
import { formatRate } from "../lib/money";
import { useDismiss } from "../lib/useDismiss";
import { useIsMobile } from "../lib/viewport";
import { IconBell, IconChevronDown, IconMenu, IconPlus } from "./Icons";
import { MenuSurface } from "./MenuSurface";

interface TopbarProps {
  title: string;
  primaryActionLabel: string;
  /** `undefined` on tabs whose primary action does not exist yet — the button
   * is then disabled rather than silently doing nothing when clicked. */
  onPrimaryAction?: () => void;
  currency: Currency;
  onCurrencyChange: (currency: Currency) => void;
  /** The lempira/dollar rate, reached through the USD button. */
  rate: ExchangeRate;
  canEditRate: boolean;
  onRateChanged: (rate: ExchangeRate) => void;
  onOpenMenu: () => void;
}

export function Topbar({
  title,
  primaryActionLabel,
  onPrimaryAction,
  currency,
  onCurrencyChange,
  rate,
  canEditRate,
  onRateChanged,
  onOpenMenu,
}: TopbarProps) {
  const [isRateOpen, setRateOpen] = useState(false);
  const currencyRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  useDismiss(!isMobile && isRateOpen, currencyRef, () => setRateOpen(false));

  /**
   * USD does two jobs, in order: switch the display to dollars, then — once it
   * is already selected — open the rate behind it.
   *
   * The rate had its own button in the header, which on a phone left no room
   * for anything else. Folding it into the control it belongs to costs one tap
   * and gives the header back.
   */
  const handleUsdClick = () => {
    if (currency !== "USD") {
      onCurrencyChange("USD");
      return;
    }

    setRateOpen((open) => !open);
  };

  return (
    <header className="topbar">
      {/* Visible only on phones — see the .menu-btn rule at the end of styles.css */}
      <button className="icon-btn menu-btn" onClick={onOpenMenu} aria-label="Open menu">
        <IconMenu />
      </button>

      {/*
        The header used to carry a search box here. It searched nothing — it was
        never wired to anything — and the screens that actually hold lists have
        since grown their own search, which knows what it is looking through.
        One box per table beats one box that promises to find everything and
        finds nothing.
      */}
      <div className="page-title">{title}</div>

      <div className="currency-anchor" ref={currencyRef}>
        <div className="currency-toggle">
          <button
            type="button"
            className={currency === "HNL" ? "on" : undefined}
            onClick={() => {
              onCurrencyChange("HNL");
              setRateOpen(false);
            }}
          >
            L.
          </button>
          <button
            type="button"
            className={currency === "USD" ? "on" : undefined}
            onClick={handleUsdClick}
            aria-expanded={currency === "USD" ? isRateOpen : undefined}
            title={
              currency === "USD"
                ? "Tap again to view or change the exchange rate"
                : "Show amounts in US dollars"
            }
          >
            USD
            {/* Phones only — see the .currency-caret rules. It appears once USD
                is selected, since that is when the second tap does something. A
                chevron on an inactive button would promise a menu that is not
                there yet. */}
            {currency === "USD" && (
              <span className={rate.isStale ? "currency-caret stale" : "currency-caret"}>
                <IconChevronDown />
              </span>
            )}
          </button>

          {/*
            The rate itself, on wide screens only.

            It is a sibling of the currency buttons rather than text inside one:
            a button cannot be nested in a button, and as its own segment it
            opens the rate in a single click without first switching the display
            to dollars. On a phone it is hidden and the second tap on USD is the
            way in, which is what keeps that header narrow.
          */}
          <button
            type="button"
            className={rate.isStale ? "currency-rate stale" : "currency-rate"}
            onClick={() => setRateOpen((open) => !open)}
            aria-expanded={isRateOpen}
            title="View or change the exchange rate"
          >
            <span className="currency-rate-value">L. {formatRate(rate.rate)}</span>
            <IconChevronDown />
          </button>
        </div>

        <MenuSurface
          isOpen={isRateOpen}
          title="Exchange rate"
          onClose={() => setRateOpen(false)}
          className="rate-popover"
        >
          <RatePanel
            rate={rate}
            canEdit={canEditRate}
            onChanged={onRateChanged}
            onDone={() => setRateOpen(false)}
          />
        </MenuSurface>
      </div>

      <button
        className="btn-primary"
        type="button"
        onClick={onPrimaryAction}
        disabled={!onPrimaryAction}
        // Narrow screens show only the "+", so the label also lives here: read
        // aloud by a screen reader and shown as a tooltip on hover.
        aria-label={primaryActionLabel}
        title={primaryActionLabel}
      >
        <IconPlus />
        <span>{primaryActionLabel}</span>
      </button>

      <button className="icon-btn" aria-label="Notifications">
        <IconBell />
        <span className="dot-alert"></span>
      </button>
    </header>
  );
}
