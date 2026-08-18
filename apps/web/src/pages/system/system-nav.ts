/**
 * System workspace navigation hierarchy.
 *
 * URL contract: every original `?section=` slug stays addressable. Groups are
 * derived from the current section and never appear in the query string.
 * Default (Overview) continues to omit `section` from the URL.
 */

export const SECTIONS = [
  "Overview",
  "OpenCode Backend",
  "Global Availability",
  "Background Jobs",
  "Failure Handling",
  "Routing",
  "Startup / UI",
  "Companion",
  "Interview",
  "Multiplexer",
  "Telemetry Bridge",
  "Environment",
  "Option Coverage",
  "Schema",
] as const;

export type Section = (typeof SECTIONS)[number];

/** URL slugs for the section query (?section=multiplexer etc.). */
export const SECTION_SLUGS: Record<Section, string> = {
  Overview: "overview",
  "OpenCode Backend": "opencode-backend",
  "Global Availability": "global-availability",
  "Background Jobs": "background-jobs",
  "Failure Handling": "failure-handling",
  Routing: "routing",
  "Startup / UI": "startup-ui",
  Companion: "companion",
  Interview: "interview",
  Multiplexer: "multiplexer",
  "Telemetry Bridge": "telemetry-bridge",
  Environment: "environment",
  "Option Coverage": "option-coverage",
  Schema: "schema",
};

export const SYSTEM_GROUPS = [
  "OpenCode",
  "Orchestration",
  "Workstation",
  "Advanced",
] as const;

export type SystemGroup = (typeof SYSTEM_GROUPS)[number];

export const GROUP_SECTIONS: Record<SystemGroup, readonly Section[]> = {
  OpenCode: ["Overview", "OpenCode Backend", "Telemetry Bridge"],
  Orchestration: [
    "Global Availability",
    "Background Jobs",
    "Failure Handling",
    "Routing",
  ],
  Workstation: ["Startup / UI", "Companion", "Interview", "Multiplexer"],
  Advanced: ["Environment", "Option Coverage", "Schema"],
};

const SECTION_GROUP = Object.fromEntries(
  SYSTEM_GROUPS.flatMap((group) =>
    GROUP_SECTIONS[group].map((section) => [section, group] as const),
  ),
) as Record<Section, SystemGroup>;

export function parseSection(raw: string | null): Section {
  if (!raw) return "Overview";
  for (const s of SECTIONS) {
    if (SECTION_SLUGS[s] === raw) return s;
  }
  return "Overview";
}

export function groupForSection(section: Section): SystemGroup {
  return SECTION_GROUP[section];
}

export function defaultSectionForGroup(group: SystemGroup): Section {
  // Array index access is `Section | undefined` under noUncheckedIndexedAccess.
  // Every group list is statically non-empty; fall back deterministically.
  return GROUP_SECTIONS[group][0] ?? "Overview";
}

export function writeSectionParam(
  prev: URLSearchParams,
  section: Section,
): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (section === "Overview") next.delete("section");
  else next.set("section", SECTION_SLUGS[section]);
  return next;
}
