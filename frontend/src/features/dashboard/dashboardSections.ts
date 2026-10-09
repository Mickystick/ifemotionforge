/**
 * Which bands the Panel General is made of, and what order they come in.
 *
 * The whole customisation feature rests on one decision made here: the page is
 * a ONE-DIMENSIONAL list of self-contained bands, and rearranging it is
 * rearranging that list. Nothing else about the layout is a preference.
 *
 * That is what makes it impossible to break. A free-form grid — drag anything
 * anywhere, resize it — has to answer what happens when two things overlap,
 * when a row has a hole in it, when a wide card is dropped into a narrow
 * column, and what any of it means on a phone. A list has none of those
 * questions: any permutation of it is a valid page, because each band still
 * lays ITSELF out exactly as it always did. The reader chooses the running
 * order; the code keeps the typography, the grids and the breakpoints.
 *
 * The second decision is here too: an arrangement is stored as a list of IDS,
 * never as positions or indexes. Indexes are a promise that the set of bands
 * will never change, and it changed twice while this screen was being built.
 */

/** Every band, in the order somebody sees before they have chosen anything. */
export const DEFAULT_SECTION_ORDER = [
  "income",
  "history",
  "composition",
  "collections",
  "worklist",
  "projects",
  "projection",
  "attention",
  "control",
] as const;

export type SectionId = (typeof DEFAULT_SECTION_ORDER)[number];

/**
 * What each band is called while it is being moved.
 *
 * The titles on the cards themselves are written in the JSX where they belong.
 * These are the labels for the editor's own list, and a couple of them are
 * deliberately different: the first band has no heading of its own on screen,
 * and "Avisos" covers three small cards that travel together.
 */
export const SECTION_LABELS: Record<SectionId, string> = {
  income: "Monthly summary",
  history: "Monthly collections",
  composition: "Where the money came from",
  collections: "Collections",
  worklist: "Who to call first",
  projects: "By project",
  projection: "Coming up",
  attention: "Alerts: reservations, contracts nearing completion, and down payments",
  control: "Oversight",
};

/** One person's arrangement, as it travels to and from the server. */
export interface DashboardLayout {
  order: SectionId[];
  hidden: SectionId[];
}

const isSectionId = (value: string): value is SectionId =>
  (DEFAULT_SECTION_ORDER as readonly string[]).includes(value);

/**
 * The arrangement to actually render, given whatever was stored.
 *
 * This function is the reason a saved layout cannot break the page, and it is
 * worth reading in full, because every rule in it corresponds to a way this
 * feature goes wrong in other apps:
 *
 *  - **Ids the code no longer has are dropped.** A band removed in a later
 *    release must not leave a hole, an "undefined" card, or a crash in the
 *    layout of everybody who had saved one.
 *  - **Bands the stored order has never heard of are ADDED.** This is the one
 *    people forget. Ship a new band, and every existing user has a saved order
 *    without it — so unless it is put back, the new feature is invisible to
 *    exactly the users engaged enough to have customised their screen. It is
 *    inserted next to the neighbour it ships beside, rather than at the end,
 *    so a band that belongs under the chart arrives under the chart.
 *  - **Hidden is filtered the same way**, so a stale id cannot hide a band that
 *    now means something else.
 *
 * `null` — nobody has chosen — returns the default, and so does a stored order
 * that reconciles to nothing.
 */
export function resolveLayout(stored: DashboardLayout | null): DashboardLayout {
  const fallback: DashboardLayout = {
    order: [...DEFAULT_SECTION_ORDER],
    hidden: [],
  };

  if (!stored) {
    return fallback;
  }

  // Known ids only, and each at most once: a duplicate would render one band
  // twice and give two elements the same React key.
  const seen = new Set<SectionId>();
  const order: SectionId[] = [];

  for (const id of stored.order) {
    if (isSectionId(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }

  if (order.length === 0) {
    return fallback;
  }

  // Anything shipped since this arrangement was saved, put back beside the band
  // it follows by default.
  for (const [index, id] of DEFAULT_SECTION_ORDER.entries()) {
    if (seen.has(id)) {
      continue;
    }

    const previous = DEFAULT_SECTION_ORDER[index - 1];
    const after = previous ? order.indexOf(previous) : -1;

    order.splice(after === -1 ? 0 : after + 1, 0, id);
    seen.add(id);
  }

  return {
    order,
    hidden: [...new Set(stored.hidden.filter(isSectionId))],
  };
}

/** The same list with one band moved by one place. Returns a new array. */
export function moveSection(
  order: SectionId[],
  id: SectionId,
  direction: -1 | 1,
): SectionId[] {
  const from = order.indexOf(id);
  const to = from + direction;

  // Already at the end it is being pushed towards. Returning the input
  // unchanged lets the caller treat every move the same way.
  if (from === -1 || to < 0 || to >= order.length) {
    return order;
  }

  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);

  return next;
}

/** The same list with one band lifted out and dropped in front of another. */
export function dropSection(
  order: SectionId[],
  dragged: SectionId,
  target: SectionId,
): SectionId[] {
  if (dragged === target) {
    return order;
  }

  const without = order.filter((id) => id !== dragged);
  const at = without.indexOf(target);

  if (at === -1) {
    return order;
  }

  const next = [...without];
  next.splice(at, 0, dragged);

  return next;
}

/** Is this arrangement the one somebody gets without choosing anything? */
export function isDefaultLayout(layout: DashboardLayout): boolean {
  return (
    layout.hidden.length === 0 &&
    layout.order.length === DEFAULT_SECTION_ORDER.length &&
    layout.order.every((id, index) => id === DEFAULT_SECTION_ORDER[index])
  );
}
