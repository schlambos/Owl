export type NavGroupId = "overview" | "team" | "runtime" | "policy" | "system";

export interface NavChild {
  to: string;
  label: string;
}

export interface NavGroup {
  id: NavGroupId;
  label: string;
  to: string;
  children?: NavChild[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  { id: "overview", label: "Overview", to: "/" },
  {
    // Doc 34: the Team segmented control is exactly the three route-backed
    // topology views. /council and /acp remain standalone routes reached via
    // in-page ownership/dependency links only.
    id: "team",
    label: "Team",
    to: "/agents",
    children: [
      { to: "/agents", label: "Agents" },
      { to: "/models", label: "Models" },
      { to: "/providers", label: "Providers" },
    ],
  },
  {
    id: "runtime",
    label: "Runtime",
    to: "/sessions",
    children: [
      { to: "/sessions", label: "Sessions" },
      { to: "/doctor", label: "Doctor" },
    ],
  },
  {
    id: "policy",
    label: "Policy",
    to: "/presets",
    children: [
      { to: "/presets", label: "Presets" },
      { to: "/capabilities", label: "Capabilities" },
      { to: "/prompts", label: "Prompts" },
      { to: "/config", label: "Config" },
    ],
  },
  { id: "system", label: "System", to: "/system" },
];

const PATH_TO_GROUP = new Map<string, NavGroupId>();
for (const group of NAV_GROUPS) {
  PATH_TO_GROUP.set(group.to, group.id);
  for (const child of group.children ?? []) {
    PATH_TO_GROUP.set(child.to, group.id);
  }
}

export function pathnameOf(path: string): string {
  const q = path.indexOf("?");
  const h = path.indexOf("#");
  let end = path.length;
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  const raw = path.slice(0, end) || "/";
  if (raw.length > 1 && raw.endsWith("/")) return raw.slice(0, -1);
  return raw;
}

export function groupForPath(pathname: string): NavGroup | undefined {
  return NAV_GROUPS.find((g) => g.id === PATH_TO_GROUP.get(pathnameOf(pathname)));
}

export function isGroupActive(group: NavGroup, pathname: string): boolean {
  return groupForPath(pathname)?.id === group.id;
}

export function isChildActive(to: string, pathname: string): boolean {
  return pathnameOf(pathname) === pathnameOf(to);
}
