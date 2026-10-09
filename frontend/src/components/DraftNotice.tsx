import { draftAge } from "../lib/formDrafts";

interface DraftNoticeProps {
  savedAt: string;
  /** What will NOT come back — a scan, a comprobante. Omitted when nothing. */
  missing?: string | null;
  onRestore: () => void;
  onDiscard: () => void;
}

/**
 * "You were in the middle of this. Carry on, or start over?"
 *
 * At the top of the form rather than as a dialog over it, deliberately. A
 * prompt that has to be answered before the form can be seen forces a decision
 * about something the user cannot look at yet; here the choice sits above the
 * fields it refers to and can simply be ignored by somebody who would rather
 * start typing.
 *
 * `missing` is the part that matters most. A draft restores text and numbers
 * and cannot restore files — see lib/formDrafts.ts — and a form that comes back
 * looking complete with its scan quietly absent is worse than no recovery at
 * all, because the contract gets saved that way.
 */
export function DraftNotice({ savedAt, missing, onRestore, onDiscard }: DraftNoticeProps) {
  return (
    <div className="draft-notice full-width">
      <div className="draft-notice-text">
        <p className="draft-notice-title">You left a draft unfinished {draftAge(savedAt)}.</p>
        {missing && <p className="draft-notice-missing">{missing}</p>}
      </div>

      <div className="draft-notice-actions">
        <button type="button" className="btn-secondary" onClick={onRestore}>
          Continue
        </button>
        <button type="button" className="link-btn" onClick={onDiscard}>
          Start over
        </button>
      </div>
    </div>
  );
}
