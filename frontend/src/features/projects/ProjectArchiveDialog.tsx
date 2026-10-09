import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import type { Project } from "../../types";

const MINIMUM_REASON_LENGTH = 10;

interface ProjectArchiveDialogProps {
  project: Project;
  onCancel: () => void;
  /** Rejects when the server refuses; the message is shown in the dialog. */
  onConfirm: (reason: string) => Promise<void>;
}

/**
 * Archiving a project, not deleting it.
 *
 * A project owns lots, which own contracts, which own payments. Deleting one
 * would cut years of financial history loose from the place it happened, so
 * Lindero hides the project and keeps every row readable. It is also the one
 * archive in the app that can be undone, precisely because nothing was
 * destroyed.
 */
export function ProjectArchiveDialog({
  project,
  onCancel,
  onConfirm,
}: ProjectArchiveDialogProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isArchiving, setArchiving] = useState(false);

  // Hiding a project with live inventory would take lots that are still for
  // sale off every screen at once. Its lots have to be archived first, one by
  // one, deliberately. The server refuses this too.
  const isBlocked = project.lotCount > 0;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (reason.trim().length < MINIMUM_REASON_LENGTH) {
      setError(`Please provide a reason with at least ${MINIMUM_REASON_LENGTH} characters.`);
      return;
    }

    setArchiving(true);

    try {
      await onConfirm(reason.trim());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to archive the project.");
    } finally {
      setArchiving(false);
    }
  };

  return (
    <Dialog ariaLabel={`Archive ${project.name}`} onClose={onCancel}>
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow danger-eyebrow">Archive project</p>
            <h2>{project.name}</h2>
            <p className="modal-description">
              The project will no longer appear when creating lots, but its history is kept and
              you can restore it at any time. Nothing is deleted.
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          {isBlocked ? (
            <p className="form-blocked full-width">
              {project.name} still has {project.lotCount} active lot
              {project.lotCount === 1 ? "" : "s"}. Archive the lots first so none disappear from
              inventory without someone choosing to do so.
            </p>
          ) : (
            <div className="form-field full-width">
              <label htmlFor="project-archive-reason">
                Reason<span className="required-mark" aria-hidden="true"> *</span>
              </label>
              <textarea
                id="project-archive-reason"
                rows={3}
                value={reason}
                placeholder="e.g. Project fully sold in August 2026."
                onChange={(event) => setReason(event.target.value)}
              />
              <span className="field-hint">
                This will be saved in the history with your name and the date.
              </span>
            </div>
          )}

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isArchiving}>
            Cancel
          </button>
          <button type="submit" className="btn-danger" disabled={isBlocked || isArchiving}>
            {isArchiving ? "Archiving…" : "Archive project"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
