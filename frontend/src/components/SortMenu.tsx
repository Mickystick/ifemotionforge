import type { ReactNode } from "react";

import type { SortDirection, SortRule } from "../lib/sortRules";
import { addLevel, promoteField, removeLevel, setLevelField, toggleLevelDirection } from "../lib/sortRules";
import { IconClose } from "./Icons";

export interface SortOption<Field extends string> {
  field: Field;
  label: string;
  ascLabel: string;
  descLabel: string;
}

interface SortMenuProps<Field extends string> {
  options: ReadonlyArray<SortOption<Field>>;
  /**
   * Never empty in practice — every screen's `DEFAULT_SORT` is a one-rule
   * list — but nothing here relies on that; see `sortRules.ts`.
   */
  rules: ReadonlyArray<SortRule<Field>>;
  onChange: (rules: SortRule<Field>[]) => void;
  /**
   * The direction a newly chosen field should start in. Defaults to "asc" for
   * every field; a screen only needs this when one of its fields reads
   * backwards by default — "atrasados primero" for payment health, "más
   * recientes primero" for a date — the same rule the primary list already
   * used before there could be more than one.
   */
  defaultDirection?: (field: Field) => SortDirection;
  /** Rendered at the foot of the menu, where the old single-field tip went. */
  hint?: ReactNode;
}

/**
 * The sort picker every screen's toolbar opens: one PRIMARY field, chosen from
 * the full list exactly as before — click a row to sort by it, click the
 * chosen row again to flip its direction — plus any number of secondary
 * levels added underneath, each its own field and direction.
 *
 * The primary list staying a plain click-to-choose list (rather than folding
 * it into the same field+direction row the secondary levels use) is
 * deliberate: it is what every screen already trained people on, and changing
 * it to save one component would make the common case — "just sort by X" —
 * clumsier so that the rare case — "X, then Y" — could share more code.
 *
 * A field already in use, at any level, does not reappear in another level's
 * choices; sorting by the same field twice has no meaning and Airtable hides
 * it for the same reason.
 */
export function SortMenu<Field extends string>({
  options,
  rules,
  onChange,
  defaultDirection = () => "asc",
  hint,
}: SortMenuProps<Field>) {
  // Guaranteed non-empty by every caller's DEFAULT_SORT — see the prop doc.
  const primary = rules[0]!;
  const secondary = rules.slice(1);
  const usedFields = new Set(rules.map((rule) => rule.field));
  const unusedOptions = options.filter((option) => !usedFields.has(option.field));

  return (
    <>
      <p className="menu-title desktop-only">Sort by</p>
      {options.map((option) => {
        const isCurrent = option.field === primary.field;

        return (
          <button
            key={option.field}
            type="button"
            aria-checked={isCurrent}
            role="menuitemradio"
            className={isCurrent ? "menu-item selected" : "menu-item"}
            onClick={() => onChange(promoteField(rules, option.field, defaultDirection))}
          >
            <span>{option.label}</span>
            <span className="menu-item-detail">
              {isCurrent ? (primary.direction === "asc" ? option.ascLabel : option.descLabel) : ""}
            </span>
          </button>
        );
      })}

      {secondary.map((rule, index) => {
        const level = index + 1;
        const current = options.find((option) => option.field === rule.field);
        // This level's own field stays choosable even though it counts as
        // "used" — otherwise picking a field would remove itself from its own
        // dropdown the instant it was chosen.
        const choices = options.filter(
          (option) => option.field === rule.field || !usedFields.has(option.field),
        );

        return (
          <div key={level} className="sort-rule-row">
            <span className="sort-rule-then">then</span>
            <select
              className="sort-rule-field"
              aria-label="Also sort by"
              value={rule.field}
              onChange={(event) =>
                onChange(setLevelField(rules, level, event.target.value as Field, defaultDirection))
              }
            >
              {choices.map((choice) => (
                <option key={choice.field} value={choice.field}>
                  {choice.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="sort-rule-direction"
              onClick={() => onChange(toggleLevelDirection(rules, level))}
              title="Reverse this sort order"
            >
              {current ? (rule.direction === "asc" ? current.ascLabel : current.descLabel) : ""}
            </button>
            <button
              type="button"
              className="sort-rule-remove"
              onClick={() => onChange(removeLevel(rules, level))}
              aria-label="Remove this sort order"
              title="Remove this sort order"
            >
              <IconClose />
            </button>
          </div>
        );
      })}

      {unusedOptions.length > 0 && (
        <button
          type="button"
          className="sort-rule-add"
          onClick={() => onChange(addLevel(rules, options, defaultDirection))}
        >
          + Add another sort order
        </button>
      )}

      {hint && <p className="menu-foot">{hint}</p>}
    </>
  );
}
