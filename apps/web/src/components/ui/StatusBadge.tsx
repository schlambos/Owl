import type { ReactNode } from "react";
import { cx } from "./cx";
import { StatusDot, type StatusTone } from "./StatusDot";

export function StatusBadge(props: {
  tone?: StatusTone;
  children: ReactNode;
  className?: string;
  title?: string;
  testId?: string;
}) {
  const tone = props.tone ?? "neutral";
  return (
    <span
      className={cx(
        "omo-badge",
        tone !== "neutral" && `omo-badge-${tone}`,
        props.className,
      )}
      title={props.title}
      data-testid={props.testId}
    >
      <StatusDot tone={tone} />
      {props.children}
    </span>
  );
}
