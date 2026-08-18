import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export function IconButton(
  props: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> & {
    label: string;
    children: ReactNode;
  },
) {
  const { label, className, type, children, ...rest } = props;
  return (
    <button
      type={type ?? "button"}
      aria-label={label}
      title={label}
      className={cx("omo-btn", "omo-btn-ghost", "omo-icon-btn", className)}
      {...rest}
    >
      {children}
    </button>
  );
}
