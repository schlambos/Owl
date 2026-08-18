import type { ReactNode } from "react";
import { cx } from "../../components/ui/cx";

export function SettingRow(props: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  testId?: string;
  stacked?: boolean;
}) {
  return (
    <div
      className={cx("omo-sys-row", props.stacked && "omo-sys-row-stacked")}
      data-testid={props.testId}
    >
      <div className="omo-sys-row-copy">
        <div className="omo-sys-row-title">{props.title}</div>
        {props.description ? (
          <div className="omo-sys-row-desc">{props.description}</div>
        ) : null}
      </div>
      {props.control ? (
        <div className="omo-sys-row-control">{props.control}</div>
      ) : null}
    </div>
  );
}

export function Switch(props: {
  checked: boolean;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  label: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      data-testid={props.testId}
      className={cx("omo-sys-switch", props.checked && "is-on")}
      onClick={() => {
        if (props.disabled) return;
        props.onChange?.(!props.checked);
      }}
    >
      <span className="omo-sys-switch-thumb" aria-hidden="true" />
    </button>
  );
}

export function ServiceHeader(props: {
  title: string;
  description?: ReactNode;
  badges?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="omo-sys-service">
      <div className="omo-sys-service-copy">
        <div className="omo-sys-service-title-row">
          <h2 className="omo-sys-service-title">{props.title}</h2>
          {props.badges ? (
            <div className="omo-sys-service-badges">{props.badges}</div>
          ) : null}
        </div>
        {props.description ? (
          <p className="omo-sys-service-desc">{props.description}</p>
        ) : null}
        {props.meta ? <div className="omo-sys-service-meta">{props.meta}</div> : null}
      </div>
      {props.actions ? (
        <div className="omo-sys-service-actions">{props.actions}</div>
      ) : null}
    </header>
  );
}

export function SectionIntro(props: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="omo-sys-intro">
      <div className="omo-sys-intro-copy">
        <h2 className="omo-sys-intro-title">{props.title}</h2>
        {props.description ? (
          <p className="omo-sys-intro-desc">{props.description}</p>
        ) : null}
      </div>
      {props.actions ? (
        <div className="omo-sys-intro-actions">{props.actions}</div>
      ) : null}
    </div>
  );
}

export function ActionBar(props: { children: ReactNode }) {
  return <div className="omo-sys-actions">{props.children}</div>;
}

export function Group(props: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  testId?: string;
  technical?: boolean;
}) {
  return (
    <section
      className={cx("omo-sys-group", props.technical && "omo-sys-group-tech")}
      data-testid={props.testId}
    >
      {props.title ? (
        <div className="omo-sys-group-head">
          <h3 className="omo-sys-group-title">{props.title}</h3>
          {props.description ? (
            <p className="omo-sys-group-desc">{props.description}</p>
          ) : null}
        </div>
      ) : null}
      <div className="omo-sys-group-body">{props.children}</div>
    </section>
  );
}

export function TechDetails(props: {
  summary: string;
  children: ReactNode;
}) {
  return (
    <details className="omo-sys-tech">
      <summary>{props.summary}</summary>
      <div className="omo-sys-tech-body">{props.children}</div>
    </details>
  );
}
