import type { FormEvent } from "react";
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { IconClose } from "../../components/Icons";
import { AREA_UNITS, AREA_UNIT_INFO } from "../../lib/area";
import type { AreaUnit } from "../../lib/area";
import type { Project } from "../../types";

interface ProjectFormDialogProps {
  /** `null` creates a new project; a project edits that one. */
  project: Project | null;
  onCancel: () => void;
  onSave: (draft: { name: string; areaUnit: AreaUnit }) => Promise<void>;
}

/**
 * Create or edit a project. One dialog for both, because the fields are
 * identical — the only difference is what it is called and what it starts with.
 */
export function ProjectFormDialog({ project, onCancel, onSave }: ProjectFormDialogProps) {
  const [name, setName] = useState(project?.name ?? "");
  const [areaUnit, setAreaUnit] = useState<AreaUnit>(project?.areaUnit ?? "m2");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const isEditing = project !== null;
  const unitChanged = isEditing && areaUnit !== project.areaUnit;
  const isDirty = name !== (project?.name ?? "") || areaUnit !== (project?.areaUnit ?? "m2");

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Project name is required.");
      return;
    }

    setSaving(true);

    try {
      await onSave({ name: name.trim(), areaUnit });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save the project.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      ariaLabel={isEditing ? `Edit ${project.name}` : "New project"}
      dismissible={!isDirty && !isSaving}
      onClose={onCancel}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="modal-eyebrow">{isEditing ? "Edit project" : "New project"}</p>
            <h2>{name.trim() || "No name"}</h2>
            <p className="modal-description">
              This unit determines how lot areas are entered and displayed.
            </p>
          </div>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div className="modal-form-grid">
          <div className="form-field full-width">
            <label htmlFor="project-name">Name</label>
            <input
              id="project-name"
              value={name}
              placeholder="e.g. Lindero Village"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="form-field full-width">
            <label htmlFor="project-unit">Area unit</label>
            <select
              id="project-unit"
              value={areaUnit}
              onChange={(event) => setAreaUnit(event.target.value as AreaUnit)}
            >
              {AREA_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {AREA_UNIT_INFO[unit].label}
                </option>
              ))}
            </select>
            <span className="field-hint">
              Lots in this project are entered and displayed in this unit.
            </span>
          </div>

          {unitChanged && (
            <p className="form-blocked full-width">
              Changing the unit does not change the size of any lot. Areas are always stored in
              square meters; only how they're displayed changes—the{" "}
              {project.lotCount} lote{project.lotCount === 1 ? "" : "s"} de {project.name}{" "}
              will remain exactly the same size.
            </p>
          )}

          {error && <p className="form-error full-width">{error}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSaving}>
            Cancel
          </button>
          <button type="submit" className="btn-primary modal-submit" disabled={isSaving}>
            <span>
              {isSaving ? "Saving…" : isEditing ? "Save changes" : "Create project"}
            </span>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
