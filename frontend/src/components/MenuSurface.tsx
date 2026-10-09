import type { ReactNode } from "react";

import { Dialog } from "./Dialog";
import { IconClose } from "./Icons";
import { useIsMobile } from "../lib/viewport";

interface MenuSurfaceProps {
  isOpen: boolean;
  /** Shown as the sheet's heading on a phone; used as the accessible name. */
  title: string;
  onClose: () => void;
  /** Extra class for the desktop popover, e.g. to widen it. */
  className?: string;
  children: ReactNode;
  /** Actions pinned to the bottom. On a phone they sit in the sheet's footer. */
  footer?: ReactNode;
}

/**
 * A menu that is a popover on a desktop and a full-screen sheet on a phone.
 *
 * A popover anchored to a button works when there is room beside it. On a phone
 * there is not: the panel runs past the edge of the screen, and the page scrolls
 * sideways to reveal it — which is how the toolbar's filter panel broke the
 * layout. Rather than squeezing the panel until it fits, the phone gets the same
 * treatment as every other form in the app: it takes over the screen, locks the
 * page behind it, and closes on the backdrop or Escape.
 */
export function MenuSurface({
  isOpen,
  title,
  onClose,
  className,
  children,
  footer,
}: MenuSurfaceProps) {
  const isMobile = useIsMobile();

  if (!isOpen) {
    return null;
  }

  if (isMobile) {
    return (
      <Dialog ariaLabel={title} onClose={onClose}>
        <div className="modal-header">
          <div>
            <h2>{title}</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>

        <div className="sheet-body">{children}</div>

        {footer && <div className="modal-actions sheet-actions">{footer}</div>}
      </Dialog>
    );
  }

  return (
    <div className={className ? `menu-popover ${className}` : "menu-popover"} role="dialog" aria-label={title}>
      {children}
      {footer && <div className="filter-foot">{footer}</div>}
    </div>
  );
}
