import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export function Surface(
  props: HTMLAttributes<HTMLDivElement> & {
    padding?: "sm" | "md" | "lg";
    children: ReactNode;
  },
) {
  const { padding = "md", className, ...rest } = props;
  return (
    <div
      className={cx("omo-surface", `omo-surface-${padding}`, className)}
      {...rest}
    />
  );
}
