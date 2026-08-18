/**
 * FocusTrapDialog — portal-based true-modal primitive.
 *
 * Used by the AgentDetailDrawer (side-sheet variant) and AgentEditModal
 * (centered modal variant). Guarantees:
 *
 *  - role="dialog" + aria-modal="true" + aria-labelledby on the panel.
 *  - The rest of the document (every other <body> child) gets `inert` +
 *    aria-hidden="true" while open; both are restored exactly on close.
 *    The background stays VISIBLE but inert — the drawer variant uses a
 *    transparent backdrop so the assignment list remains readable.
 *  - Initial focus lands on the heading (tabIndex={-1}, id = labelledBy).
 *  - Tab / Shift+Tab cycle within the panel (focus trap).
 *  - Escape closes. A click directly on the backdrop closes; clicks inside
 *    the panel never do.
 *  - Focus returns on close: to `returnFocus` when given, else to the
 *    element that was focused when the dialog opened.
 *
 * Only ONE dialog may be open at a time — the page closes the drawer before
 * opening the editor. Agent, capability, model, and batch dialogs all use
 * this primitive.
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE_SELECTOR =
  'a[href], area[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface InertRecord {
  el: HTMLElement;
  hadInert: boolean;
  ariaHidden: string | null;
}

export function FocusTrapDialog(props: {
  /** "sheet" = right-docked side-sheet (transparent backdrop); "modal" = centered (dimmed backdrop). */
  variant: "sheet" | "modal";
  /** id of the heading inside `children` that labels + receives initial focus. */
  labelledBy: string;
  onClose: () => void;
  /** Explicit focus-return target (or getter). Defaults to the pre-open focus. */
  returnFocus?: HTMLElement | null | (() => HTMLElement | null);
  /** Extra class for the panel element (e.g. "drawer" / "modal"). */
  className?: string;
  /** Extra class for the backdrop element. */
  backdropClassName?: string;
  children: ReactNode;
}) {
  const portalRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  if (portalRef.current === null && typeof document !== "undefined") {
    const el = document.createElement("div");
    el.setAttribute("data-focus-trap-portal", "");
    portalRef.current = el;
  }

  // Keep latest onClose/returnFocus in refs so the mount-only effect and the
  // keydown handler never go stale.
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const returnFocusRef = useRef(props.returnFocus);
  returnFocusRef.current = props.returnFocus;

  useEffect(() => {
    const portal = portalRef.current;
    if (!portal) return;
    document.body.appendChild(portal);

    const previousFocus = document.activeElement as HTMLElement | null;

    // Inert + hide every other top-level element (the app root in
    // production, the test render container under RTL). Restored below.
    const inerted: InertRecord[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child === portal) continue;
      const el = child as HTMLElement;
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK") continue;
      inerted.push({
        el,
        hadInert: el.hasAttribute("inert"),
        ariaHidden: el.getAttribute("aria-hidden"),
      });
      el.setAttribute("inert", "");
      el.setAttribute("aria-hidden", "true");
    }

    // Initial focus: the labelling heading (falls back to the panel).
    const panel = panelRef.current;
    const heading = panel?.querySelector<HTMLElement>(
      `[id="${props.labelledBy}"]`,
    );
    (heading ?? panel)?.focus();

    return () => {
      for (const rec of inerted) {
        if (!rec.hadInert) rec.el.removeAttribute("inert");
        if (rec.ariaHidden === null) rec.el.removeAttribute("aria-hidden");
        else rec.el.setAttribute("aria-hidden", rec.ariaHidden);
      }
      portal.remove();
      const rf = returnFocusRef.current;
      const target =
        (typeof rf === "function" ? rf() : (rf ?? null)) ?? previousFocus;
      // Focus return happens after inert is lifted so the target is
      // focusable again.
      target?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(
      panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((el) => el.getAttribute("aria-hidden") !== "true");
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    // -1 = focus is on the panel/heading (programmatic-only) or outside.
    const idx = active ? items.indexOf(active) : -1;
    if (e.shiftKey) {
      if (idx <= 0) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (idx === -1 || idx === items.length - 1) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const onBackdropClick = (e: React.MouseEvent) => {
    // Direct backdrop clicks only — clicks inside the panel bubble with a
    // different target and must not close.
    if (e.target === e.currentTarget) onCloseRef.current();
  };

  const dialog = (
    <div
      className={`ftd-backdrop ftd-${props.variant} ${props.backdropClassName ?? ""}`}
      onClick={onBackdropClick}
      onKeyDown={onKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.labelledBy}
        className={props.className}
        tabIndex={-1}
      >
        {props.children}
      </div>
    </div>
  );

  return portalRef.current
    ? createPortal(dialog, portalRef.current)
    : null;
}
