/**
 * Registers happy-dom window/document globals on globalThis.
 *
 * Kept as a separate module so it is evaluated BEFORE @testing-library/react
 * is imported: @testing-library/dom binds `screen` to document.body at module
 * load time and falls back to permanently-throwing stubs if `document` is
 * missing at that point.
 *
 * Note: happy-dom v20 moved the registrator out of the core package into
 * @happy-dom/global-registrator (the old "happy-dom/GlobalRegistrator" path).
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
