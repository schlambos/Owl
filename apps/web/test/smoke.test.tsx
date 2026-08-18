import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((c) => c + 1)}>
      Clicked {count} times
    </button>
  );
}

describe("web smoke test", () => {
  test("renders a React component and responds to clicks", () => {
    render(<Counter />);

    const button = screen.getByText("Clicked 0 times");
    expect(button).toBeDefined();

    fireEvent.click(button);
    expect(screen.getByText("Clicked 1 times")).toBeDefined();

    fireEvent.click(button);
    expect(screen.getByText("Clicked 2 times")).toBeDefined();
  });
});
