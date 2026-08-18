/**
 * Minimal ambient types for the OpenCode plugin contract
 * (`@opencode-ai/plugin`).
 *
 * The real package ships with OpenCode itself (it lives under
 * `~/.config/opencode/node_modules`, not in this workspace) and is not an
 * installable workspace dependency. The bridge only needs the type-level
 * contract, and only via `import type` — nothing from this module is ever
 * required at runtime.
 *
 * Shapes below mirror `@opencode-ai/plugin@1.18.14` (`dist/index.d.ts`) for
 * the subset this plugin uses:
 *
 * - `Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>`
 * - `PluginInput` fields: client, project, directory, worktree,
 *   experimental_workspace, serverUrl, $ (typed as `unknown` here because
 *   they come from `@opencode-ai/sdk`, which this package does not depend
 *   on; the bridge reads none of them except `serverUrl` for identity).
 * - `PluginOptions = Record<string, unknown>` — the second plugin argument.
 *   The installed `Config.plugin` type (`dist/index.d.ts:48-50`) allows
 *   `Array<string | [string, PluginOptions]>`, i.e. tuple plugin specs with
 *   options are source-verifiable in the installed type declarations. The
 *   bridge consumes `options.port` and `options.activationNonce` when
 *   supplied as the tuple's second element.
 * - `Hooks.dispose?: () => Promise<void>` (the only hook this plugin uses).
 *
 * If the real package types ever become resolvable in this workspace, delete
 * this shim — the real declarations take precedence and are the source of
 * truth.
 */
declare module "@opencode-ai/plugin" {
  /** Input handed to every plugin at startup (fields unused by the bridge). */
  export interface PluginInput {
    readonly client: unknown;
    readonly project: unknown;
    readonly directory: string;
    readonly worktree: string;
    readonly experimental_workspace: unknown;
    readonly serverUrl: URL;
    readonly $: unknown;
  }

  /** Optional plugin options record (unused by the bridge). */
  export type PluginOptions = Record<string, unknown>;

  /**
   * Hook surface. OpenCode defines many optional hooks (event, config, tool,
   * chat.*, permission.*, ...); the bridge is read-only and deliberately
   * registers none of them, so only `dispose` is declared here.
   */
  export interface Hooks {
    dispose?: () => Promise<void>;
  }

  /** Plugin entry-point signature. */
  export type Plugin = (
    input: PluginInput,
    options?: PluginOptions,
  ) => Promise<Hooks>;
}
