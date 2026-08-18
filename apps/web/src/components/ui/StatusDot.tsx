import { cx } from "./cx";

export type StatusTone = "ok" | "warn" | "bad" | "neutral";

export function StatusDot(props: { tone?: StatusTone; className?: string }) {
  const tone = props.tone ?? "neutral";
  return (
    <span
      className={cx(
        "omo-dot",
        tone !== "neutral" && `omo-dot-${tone}`,
        props.className,
      )}
      aria-hidden="true"
    />
  );
}
