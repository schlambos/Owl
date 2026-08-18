import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { SegmentedControl } from "../ui/SegmentedControl";
import {
  NAV_GROUPS,
  groupForPath,
  isChildActive,
  isGroupActive,
} from "./nav";

export function NavigateMenu(props: { pathname: string }) {
  const group = groupForPath(props.pathname);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const label = group?.label ?? "Navigate";

  useEffect(() => {
    const el = detailsRef.current;
    if (!el) return;
    const close = () => {
      el.open = false;
      setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!el.open) return;
      if (event.target instanceof Node && el.contains(event.target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && el.open) {
        close();
        el.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <details
      ref={detailsRef}
      className="omo-navigate"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary aria-label={`Navigate, ${label}`}>
        {label}
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      {open ? (
        <div
          className="omo-navigate-panel"
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest("a")) {
              if (detailsRef.current) detailsRef.current.open = false;
              setOpen(false);
            }
          }}
        >
          <div className="omo-navigate-group">
            <div className="omo-navigate-kicker">Workspaces</div>
            <SegmentedControl
              ariaLabel="Primary"
              variant="vertical"
              items={NAV_GROUPS.map((item) => ({
                to: item.to,
                label: item.label,
                active: isGroupActive(item, props.pathname),
                end: item.to === "/",
              }))}
            />
          </div>
          {group?.children?.length ? (
            <div className="omo-navigate-group">
              <div className="omo-navigate-kicker">{group.label}</div>
              <SegmentedControl
                ariaLabel={`${group.label} pages`}
                variant="vertical"
                items={group.children.map((child) => ({
                  to: child.to,
                  label: child.label,
                  active: isChildActive(child.to, props.pathname),
                }))}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
