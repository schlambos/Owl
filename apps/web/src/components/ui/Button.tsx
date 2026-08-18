import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "ghost";
    size?: "sm" | "md";
    children: ReactNode;
  },
) {
  const { variant = "secondary", size = "md", className, type, ...rest } =
    props;
  return (
    <button
      type={type ?? "button"}
      className={cx(
        "omo-btn",
        `omo-btn-${variant}`,
        `omo-btn-${size}`,
        className,
      )}
      {...rest}
    />
  );
}
