import type { Ref } from "react";

import { getInitials } from "../lib/initials";
import type { User } from "../lib/permissions";
import { ROLE_LABELS, can } from "../lib/permissions";
import type { TabId } from "../types";
import {
  IconBrand,
  IconCollapse,
  IconHistory,
  IconSignOut,
  IconContracts,
  IconCustomers,
  IconDashboard,
  IconLots,
  IconPermissions,
  IconProjects,
  IconReceipts,
  IconUsers,
} from "./Icons";

/**
 * The navigation is described as DATA, not as repeated markup. Adding a screen
 * later means adding one object to this array.
 */
interface NavItem {
  id: TabId;
  label: string;
  icon: () => React.JSX.Element;
  badge?: string;
}

/**
 * The navigation, built for the signed-in user. The Historial group only exists
 * for roles that can read the change history — the server refuses the request
 * either way, so this is about not showing a door that will not open.
 */
function buildNavGroups(user: User): Array<{ label: string; items: NavItem[] }> {
  const groups: Array<{ label: string; items: NavItem[] }> = [
    {
      label: "Home",
      items: [
        { id: "home" as const, label: "Home", icon: IconDashboard },
        { id: "dashboard" as const, label: "Dashboard", icon: IconDashboard },
      ],
    },
    {
      label: "Operations",
      items: [
        { id: "projects" as const, label: "Projects", icon: IconProjects },
        { id: "lots" as const, label: "Lots", icon: IconLots },
        { id: "contracts" as const, label: "Contracts", icon: IconContracts },
        { id: "customers" as const, label: "Customers", icon: IconCustomers },
        { id: "receipts" as const, label: "Receipts", icon: IconReceipts },
      ],
    },
  ];

  const control: NavItem[] = [];

  if (can(user, "audit:view")) {
    control.push({ id: "audit" as const, label: "History", icon: IconHistory });
  }

  if (can(user, "permission:manage")) {
    control.push({ id: "permissions" as const, label: "Permissions", icon: IconPermissions });
  }

  // Who exists, as opposed to what the associate role may do. Both are locked
  // to the supervisor and cannot be granted away — see LOCKED_CAPABILITIES in
  // backend/src/lib/permissions.ts.
  if (can(user, "user:manage")) {
    control.push({ id: "users" as const, label: "Users", icon: IconUsers });
  }

  if (control.length > 0) {
    groups.push({ label: "Control", items: control });
  }

  return groups;
}

interface SidebarProps {
  activeTab: TabId;
  /** Called when the user picks a screen. The parent owns the state. */
  onSelectTab: (tab: TabId) => void;
  /** Called by the close button in the header. */
  onClose: () => void;
  /** Whether the sidebar is currently showing. */
  isOpen: boolean;
  /** The signed-in user, as reported by the server. */
  user: User;
  onSignOut: () => void;
  /**
   * Lets App measure where the sidebar is, so a click elsewhere on the page can
   * be recognised as a click *outside* it.
   */
  ref?: Ref<HTMLElement>;
}

export function Sidebar({
  activeTab,
  onSelectTab,
  onClose,
  isOpen,
  user,
  onSignOut,
  ref,
}: SidebarProps) {
  return (
    <aside ref={ref} className={isOpen ? "sidebar open" : "sidebar"}>
      <div className="brand">
        <div className="brand-mark">
          <IconBrand />
        </div>
        <div>
          <div className="brand-name">Lindero</div>
          <div className="brand-sub">Lot management</div>
        </div>

        <button type="button" className="sidebar-close" onClick={onClose} aria-label="Hide menu">
          <IconCollapse />
        </button>
      </div>

      <nav className="nav">
        {buildNavGroups(user).map((group) => (
          // React needs a stable `key` on every item in a list so it knows which
          // element is which when the list changes.
          <div key={group.label} style={{ display: "contents" }}>
            <div className="nav-group-label">{group.label}</div>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === activeTab ? "nav-item active" : "nav-item"}
                  onClick={() => onSelectTab(item.id)}
                >
                  <Icon />
                  {item.label}
                  {item.badge !== undefined && <span className="nav-badge">{item.badge}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <div className="avatar">{getInitials(user.name)}</div>
        <div className="who">
          {user.name}
          <span>{ROLE_LABELS[user.role]}</span>
        </div>
        <button type="button" className="sign-out" onClick={onSignOut} aria-label="Sign out" title="Sign out">
          <IconSignOut />
        </button>
      </div>
    </aside>
  );
}
