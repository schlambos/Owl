/**
 * FocusTrapDialog — the portal true-modal primitive behind the agent detail
 * drawer (sheet) and the agent editor (modal). Covers: dialog semantics,
 * initial heading focus, Tab/Shift+Tab trap, Escape, direct backdrop close,
 * background inert + aria-hidden (and their restoration), and focus return.
 */
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { FocusTrapDialog } from "../src/components/FocusTrapDialog";

function Harness(props: {
  variant?: "sheet" | "modal";
  returnFocus?: () => HTMLElement | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        data-testid="open"
        onClick={(e) => {
          e.currentTarget.focus();
          setOpen(true);
        }}
      >
        Open
      </button>
      <button type="button" data-testid="elsewhere">
        Elsewhere
      </button>
      {open ? (
        <FocusTrapDialog
          variant={props.variant ?? "sheet"}
          labelledBy="ftd-title"
          onClose={() => setOpen(false)}
          returnFocus={props.returnFocus}
          className="drawer"
        >
          <h2 id="ftd-title" tabIndex={-1}>
            Detail panel
          </h2>
          <button type="button" data-testid="first">
            First
          </button>
          <button type="button" data-testid="second">
            Second
          </button>
        </FocusTrapDialog>
      ) : null}
    </div>
  );
}

/** The single non-portal body child = the RTL render container. */
function appContainer(): HTMLElement {
  const els = Array.from(document.body.children).filter(
    (el) => !(el as HTMLElement).hasAttribute("data-focus-trap-portal"),
  );
  if (els.length !== 1) throw new Error("expected exactly one app container");
  return els[0] as HTMLElement;
}

async function openDialog() {
  fireEvent.click(screen.getByTestId("open"));
  await screen.findByRole("dialog");
}

describe("FocusTrapDialog", () => {
  test("dialog semantics: role, aria-modal, aria-labelledby", async () => {
    render(<Harness />);
    await openDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("ftd-title");
  });

  test("initial focus lands on the labelling heading", async () => {
    render(<Harness />);
    await openDialog();
    expect(document.activeElement).toBe(document.getElementById("ftd-title"));
  });

  test("background gets inert + aria-hidden while open; restored on close", async () => {
    render(<Harness />);
    expect(appContainer().hasAttribute("inert")).toBe(false);
    await openDialog();
    expect(appContainer().hasAttribute("inert")).toBe(true);
    expect(appContainer().getAttribute("aria-hidden")).toBe("true");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(appContainer().hasAttribute("inert")).toBe(false);
    expect(appContainer().hasAttribute("aria-hidden")).toBe(false);
  });

  test("Tab on the last control wraps to the first; Shift+Tab on the first wraps to the last", async () => {
    render(<Harness />);
    await openDialog();
    const first = screen.getByTestId("first");
    const second = screen.getByTestId("second");

    second.focus();
    fireEvent.keyDown(second, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(second);

    // Tab from a non-focusable position (the heading) moves into the trap.
    const heading = document.getElementById("ftd-title")!;
    heading.focus();
    fireEvent.keyDown(heading, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  test("Escape closes and returns focus to the pre-open element", async () => {
    render(<Harness />);
    const openBtn = screen.getByTestId("open");
    await openDialog();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(openBtn);
  });

  test("direct backdrop click closes; clicks inside the panel do not", async () => {
    render(<Harness />);
    await openDialog();
    const backdrop = document.querySelector(".ftd-backdrop") as HTMLElement;
    // Inside click: bubbles with a different target — must not close.
    fireEvent.click(screen.getByTestId("first"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Direct backdrop click closes.
    fireEvent.click(backdrop);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("explicit returnFocus getter wins over the pre-open element", async () => {
    render(
      <Harness returnFocus={() => screen.getByTestId("elsewhere")} />,
    );
    await openDialog();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("elsewhere"));
  });

  test("sheet variant uses a transparent backdrop class; modal uses the dimmed one", async () => {
    const { unmount } = render(<Harness variant="sheet" />);
    await openDialog();
    expect(document.querySelector(".ftd-backdrop.ftd-sheet")).toBeTruthy();
    unmount();

    render(<Harness variant="modal" />);
    await openDialog();
    expect(document.querySelector(".ftd-backdrop.ftd-modal")).toBeTruthy();
  });
});
