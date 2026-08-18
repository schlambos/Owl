import { SegmentedControl } from "../ui/SegmentedControl";
import { groupForPath, isChildActive } from "./nav";

export function ContextNav(props: { pathname: string }) {
  const group = groupForPath(props.pathname);
  const children = group?.children;
  if (!group || !children?.length) return null;

  return (
    <div className="omo-contextbar">
      <div className="omo-contextbar-inner">
        <span className="omo-contextbar-label" id="omo-context-label">
          {group.label}
        </span>
        <div className="omo-context-scroll">
          <SegmentedControl
            ariaLabel={`${group.label} pages`}
            variant="secondary"
            items={children.map((child) => ({
              to: child.to,
              label: child.label,
              active: isChildActive(child.to, props.pathname),
            }))}
          />
        </div>
      </div>
    </div>
  );
}
