/**
 * Area handling for Lindero.
 *
 * RULE: area is ALWAYS stored and passed around as square metres, in
 * `Lot.areaM2`. The unit is a property of the PROJECT and affects only how a
 * number is typed in and read back.
 *
 * The reason is the same one behind centavos in money.ts: one canonical unit
 * means two lots can always be compared, totalled and priced without first
 * asking which unit each one is in. Land here is sold by the manzana and the
 * vara cuadrada as often as by the metre, so people must be able to work in
 * those — but the moment two lots are STORED in different units, every sum in
 * the app needs a conversion table to be trusted.
 */

export const AREA_UNITS = ["m2", "vara2", "manzana", "hectarea", "km2"] as const;

export type AreaUnit = (typeof AREA_UNITS)[number];

interface AreaUnitInfo {
  /** Short form shown in tables, e.g. "mz". */
  symbol: string;
  /** Full name for labels and dropdowns. */
  label: string;
  /** How many square metres one of this unit is. */
  squareMetres: number;
  /** Decimals to show. Big units need more; a manzana is a lot of ground. */
  decimals: number;
}

/**
 * The vara used in Honduras is the Spanish vara of 0.8359 m, giving a vara
 * cuadrada of 0.69873 m². The manzana is defined as 10,000 varas cuadradas —
 * so it is derived here rather than typed as a rounded 7,000 m², which is the
 * approximation people quote in conversation but not the legal figure.
 */
const VARA_METRES = 0.8359;
const VARA2_M2 = VARA_METRES * VARA_METRES;

export const AREA_UNIT_INFO: Record<AreaUnit, AreaUnitInfo> = {
  m2: { symbol: "m²", label: "Square meters (m²)", squareMetres: 1, decimals: 2 },
  vara2: { symbol: "v²", label: "Square varas (v²)", squareMetres: VARA2_M2, decimals: 2 },
  manzana: {
    symbol: "mz",
    label: "Manzanas (mz)",
    squareMetres: VARA2_M2 * 10_000,
    decimals: 4,
  },
  hectarea: { symbol: "ha", label: "Hectares (ha)", squareMetres: 10_000, decimals: 4 },
  km2: { symbol: "km²", label: "Square kilometers (km²)", squareMetres: 1_000_000, decimals: 6 },
};

export function isAreaUnit(value: string): value is AreaUnit {
  return (AREA_UNITS as readonly string[]).includes(value);
}

/** A unit coming back from the server, falling back to metres if unrecognised. */
export function toAreaUnit(value: string): AreaUnit {
  return isAreaUnit(value) ? value : "m2";
}

/** Convert an amount the user typed in `unit` into the square metres we store. */
export function toSquareMetres(value: number, unit: AreaUnit): number {
  return value * AREA_UNIT_INFO[unit].squareMetres;
}

/** Convert stored square metres into `unit`, for display or for editing. */
export function fromSquareMetres(areaM2: number, unit: AreaUnit): number {
  return areaM2 / AREA_UNIT_INFO[unit].squareMetres;
}

const areaFormats = new Map<number, Intl.NumberFormat>();

function areaFormat(decimals: number): Intl.NumberFormat {
  let format = areaFormats.get(decimals);

  if (!format) {
    format = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals,
    });
    areaFormats.set(decimals, format);
  }

  return format;
}

/**
 * Format stored square metres in a project's unit, with its symbol separate so
 * the UI can style the unit differently from the number — the same split
 * `formatMoneyParts` makes for currency symbols.
 */
export function formatAreaParts(areaM2: number, unit: AreaUnit): { value: string; symbol: string } {
  const info = AREA_UNIT_INFO[unit];

  return {
    value: areaFormat(info.decimals).format(fromSquareMetres(areaM2, unit)),
    symbol: info.symbol,
  };
}

export function formatArea(areaM2: number, unit: AreaUnit): string {
  const parts = formatAreaParts(areaM2, unit);
  return `${parts.value} ${parts.symbol}`;
}

/**
 * The value to put in an edit field: the stored area in the project's unit,
 * with trailing zeros trimmed so "300" does not become "300.0000".
 */
export function toAreaInput(areaM2: number, unit: AreaUnit): string {
  const info = AREA_UNIT_INFO[unit];
  return String(Number(fromSquareMetres(areaM2, unit).toFixed(info.decimals)));
}
