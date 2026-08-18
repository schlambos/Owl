/**
 * Test setup preloaded by bunfig.toml for every `bun test` run in apps/web.
 *
 * happy-dom globals are registered via the static ./setup-dom import (which
 * runs before this module body). @testing-library/react is then imported
 * DYNAMICALLY in the module body: bun does not guarantee static import
 * evaluation order matches source order, and @testing-library/dom binds
 * `screen` to document.body at module-evaluation time — if it loads before
 * the DOM globals are registered, every screen query permanently throws
 * "a global document has to be available". Importing it here (after
 * registration) guarantees `screen` binds to a real document.body.
 *
 * cleanup() is wired into bun:test's afterEach explicitly so teardown is
 * deterministic regardless of RTL's auto-cleanup detection (double-cleanup
 * is harmless/idempotent if auto-cleanup also engages).
 */
import "./setup-dom";
import { afterEach } from "bun:test";

const { cleanup } = await import("@testing-library/react");

afterEach(() => {
  cleanup();
});
