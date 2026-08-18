import { Link } from "react-router-dom";
import { cx } from "./cx";

export interface SegmentedItem {
  to: string;
  label: string;
  active: boolean;
  end?: boolean;
}

export function SegmentedControl(props: {
  ariaLabel: string;
  items: SegmentedItem[];
  variant?: "primary" | "secondary" | "vertical";
  className?: string;
}) {
  return (
    <nav
      className={cx(
        "omo-seg",
        props.variant === "secondary" && "omo-seg-secondary",
        props.variant === "vertical" && "omo-seg-vertical",
        props.className,
      )}
      aria-label={props.ariaLabel}
    >
      {props.items.map((item) => (
        <Link
          key={item.to + item.label}
          to={item.to}
          className="omo-seg-item"
          aria-current={item.active ? "page" : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
