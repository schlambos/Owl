import { SegmentedControl } from "../ui/SegmentedControl";
import { NAV_GROUPS, isGroupActive, type NavGroup } from "./nav";

export function PrimaryNav(props: {
  pathname: string;
  groups?: readonly NavGroup[];
}) {
  const groups = props.groups ?? NAV_GROUPS;
  return (
    <SegmentedControl
      ariaLabel="Primary"
      items={groups.map((group) => ({
        to: group.to,
        label: group.label,
        active: isGroupActive(group, props.pathname),
        end: group.to === "/",
      }))}
    />
  );
}
