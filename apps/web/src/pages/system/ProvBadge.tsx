/**
 * Provenance pill shared by the System sections. Accepts the loose
 * structural shape used across the globals/companion/interview/multiplexer
 * DTOs (all carry winner.stage/sourceLabel/sourcePath when resolved).
 */
export interface ProvLike {
  winner?: { stage?: string; sourceLabel?: string; sourcePath?: string };
}

export function ProvBadge({
  properties,
  path,
}: {
  properties: Record<string, ProvLike>;
  path: string;
}) {
  const p = properties[path];
  const stage = p?.winner?.stage ?? "builtin";
  const cls =
    stage === "user-config" ? "ok" : stage === "project-config" ? "warn" : "";
  const label = p?.winner?.sourceLabel ?? (stage === "builtin" ? "OMO default" : stage);
  return (
    <span
      className={`pill${cls ? ` ${cls}` : ""}`}
      title={p?.winner?.sourcePath ?? (p?.winner?.sourceLabel ?? "")}
    >
      {label}
    </span>
  );
}
