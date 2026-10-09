import { useMemo } from "react";
import { useRememberedState } from "../../lib/viewMemory";

import { IconArchive, IconEdit, IconRestore } from "../../components/Icons";
import { formatAreaParts } from "../../lib/area";
import type { MoneyView } from "../../lib/money";
import { formatMoneyParts } from "../../lib/money";
import type { User } from "../../lib/permissions";
import { can } from "../../lib/permissions";
import { buildProjectAccents } from "../../lib/projectAccent";
import type { Project } from "../../types";

interface ProjectsPageProps {
  projects: Project[];
  money: MoneyView;
  user: User;
  onEdit: (project: Project) => void;
  onArchive: (project: Project) => void;
  onRestore: (project: Project) => void;
}

/**
 * The Proyectos screen: one card per project, showing what it contains.
 *
 * This answers "what is this project" — how much land, how many lots, how much
 * of it is still for sale. It deliberately does NOT show earnings, arrears or
 * anything over time; that is the Panel General's question, and duplicating it
 * here would mean two places computing money that can disagree.
 */
export function ProjectsPage({
  projects,
  money,
  user,
  onEdit,
  onArchive,
  onRestore,
}: ProjectsPageProps) {
  const canEdit = can(user, "project:edit");
  const canArchive = can(user, "project:archive");

  // Archived projects are kept off the working screen by default, exactly like
  // archived lots — but they are one click away, since restoring one is a
  // normal thing to want.
  const [showArchived, setShowArchived] = useRememberedState("projects.showArchived", false);

  const active = projects.filter((project) => project.archivedAt === null);
  const archived = projects.filter((project) => project.archivedAt !== null);
  const visible = showArchived ? archived : active;

  const accents = useMemo(
    () => buildProjectAccents(projects.map((project) => project.name)),
    [projects],
  );

  return (
    <section className="panel active">
      <div className="toolbar">
        <button
          type="button"
          className={showArchived ? "chip" : "chip active"}
          onClick={() => setShowArchived(false)}
        >
          Active ({active.length})
        </button>
        <button
          type="button"
          className={showArchived ? "chip active" : "chip"}
          onClick={() => setShowArchived(true)}
        >
          Archived ({archived.length})
        </button>
      </div>

      {visible.length === 0 && (
        <div className="card">
          <p className="state-message">
            {showArchived
              ? "No archived projects."
              : "No projects yet. Create one to start recording lots."}
          </p>
        </div>
      )}

      <div className="project-grid">
        {visible.map((project) => {
          const inventory = formatMoneyParts(project.inventoryValue, money);
          const area = formatAreaParts(project.areaM2, project.areaUnit);

          return (
            <article key={project.id} className="card project-card">
              <header className="project-card-head">
                <span className={`cell-project ${accents.get(project.name) ?? ""}`}>
                  <span className="project-dot" />
                  <h3>{project.name}</h3>
                </span>

                <div className="project-card-actions">
                  {project.archivedAt === null ? (
                    <>
                      {canEdit && (
                        <button
                          type="button"
                          className="icon-btn"
                          title={`Edit ${project.name}`}
                          aria-label={`Edit ${project.name}`}
                          onClick={() => onEdit(project)}
                        >
                          <IconEdit />
                        </button>
                      )}
                      {canArchive && (
                        <button
                          type="button"
                          className="icon-btn"
                          title={`Archive ${project.name}`}
                          aria-label={`Archive ${project.name}`}
                          onClick={() => onArchive(project)}
                        >
                          <IconArchive />
                        </button>
                      )}
                    </>
                  ) : (
                    canArchive && (
                      <button
                        type="button"
                        className="icon-btn"
                        title={`Restore ${project.name}`}
                        aria-label={`Restore ${project.name}`}
                        onClick={() => onRestore(project)}
                      >
                        <IconRestore />
                      </button>
                    )
                  )}
                </div>
              </header>

              {project.archivedAt !== null && <span className="stamp neutral">Archived</span>}

              <div className="project-stats">
                <div className="project-stat">
                  <span className="project-stat-value">{project.lotCount}</span>
                  <span className="project-stat-label">
                    Lot{project.lotCount === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="project-stat">
                  <span className="project-stat-value">
                    {area.value}
                    <span className="unit">{area.symbol}</span>
                  </span>
                  <span className="project-stat-label">Total area</span>
                </div>
                <div className="project-stat">
                  <span className="project-stat-value">
                    <span className="currency-symbol">{inventory.symbol}</span>
                    {inventory.value}
                  </span>
                  <span className="project-stat-label">Inventario</span>
                </div>
              </div>

              {/* The same statuses as the Lotes tab, counted by the server
                  from the very same contracts — so the two screens cannot tell
                  different stories about what is sold. "Financiados" is kept
                  apart from "vendidos" for the reason it is on the Lotes tab:
                  those lots are being paid for, not gone.

                  Donations are shown only when there are any. Most projects
                  have none, and a permanent "0 donados" would take up a line
                  to say nothing. */}
              <div className="project-status-row">
                <span className="stamp success">{project.availableCount} available</span>
                <span className="stamp warning">{project.reservedCount} reserved</span>
                <span className="stamp clay">{project.financedCount} financed</span>
                <span className="stamp neutral">{project.soldCount} sold</span>
                {project.donatedCount > 0 && (
                  <span className="stamp neutral">{project.donatedCount} donated</span>
                )}
              </div>

              {/* Only worth saying when the two differ — "áreas en m², guardadas
                  en m²" is noise on the projects sold by the metre. */}
              {project.areaUnit !== "m2" && (
                <footer className="project-card-foot">
                  <span className="field-hint">
                    Areas in {area.symbol} · always stored in m²
                  </span>
                </footer>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
