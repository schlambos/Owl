import { useRef, type KeyboardEvent } from "react";
import {
  GROUP_SECTIONS,
  SYSTEM_GROUPS,
  defaultSectionForGroup,
  groupForSection,
  type Section,
  type SystemGroup,
} from "./system-nav";

function moveIndex(length: number, current: number, key: string): number | null {
  if (length <= 0 || current < 0) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % length;
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + length) % length;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  return null;
}

function useRovingButtons<T extends string>(
  items: readonly T[],
  selected: T,
  onSelect: (item: T) => void,
) {
  const refs = useRef(new Map<T, HTMLButtonElement>());

  const focus = (item: T) => {
    refs.current.get(item)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const i = items.indexOf(selected);
    const next = moveIndex(items.length, i, e.key);
    if (next == null) return;
    e.preventDefault();
    const target = items[next]!;
    onSelect(target);
    queueMicrotask(() => focus(target));
  };

  const setRef = (item: T) => (el: HTMLButtonElement | null) => {
    if (el) refs.current.set(item, el);
    else refs.current.delete(item);
  };

  return { onKeyDown, setRef };
}

export function SystemGroupTrack(props: {
  section: Section;
  onSectionChange: (section: Section) => void;
}) {
  const group = groupForSection(props.section);
  const selectGroup = (next: SystemGroup) => {
    if (next === group) return;
    props.onSectionChange(defaultSectionForGroup(next));
  };
  const roving = useRovingButtons(SYSTEM_GROUPS, group, selectGroup);

  return (
    <nav
      className="omo-sys-nav"
      aria-label="System groups"
      data-testid="system-groups"
      onKeyDown={roving.onKeyDown}
    >
      {SYSTEM_GROUPS.map((g) => {
        const selected = g === group;
        return (
          <button
            key={g}
            type="button"
            className="omo-sys-nav-item"
            data-testid={`system-group-${g.toLowerCase()}`}
            aria-current={selected ? "page" : undefined}
            tabIndex={selected ? 0 : -1}
            ref={roving.setRef(g)}
            onClick={() => selectGroup(g)}
          >
            {g}
          </button>
        );
      })}
    </nav>
  );
}

export function SystemSectionIndex(props: {
  section: Section;
  onSectionChange: (section: Section) => void;
}) {
  const group = groupForSection(props.section);
  const groupSections = GROUP_SECTIONS[group];
  const roving = useRovingButtons(groupSections, props.section, props.onSectionChange);

  return (
    <nav
      className="omo-sys-index"
      aria-label="System sections"
      data-testid="system-sections"
      onKeyDown={roving.onKeyDown}
    >
      <span className="omo-sys-index-label" id="system-sections-label">
        Sections
      </span>
      <div className="omo-sys-index-track">
        {groupSections.map((s) => {
          const selected = s === props.section;
          return (
            <button
              key={s}
              type="button"
              className="omo-sys-index-item"
              data-testid={`system-section-${s}`}
              aria-current={selected ? "page" : undefined}
              tabIndex={selected ? 0 : -1}
              ref={roving.setRef(s)}
              onClick={() => props.onSectionChange(s)}
            >
              {s}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
