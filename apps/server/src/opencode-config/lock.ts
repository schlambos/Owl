/**
 * In-process mutex covering ALL opencode.json / opencode.jsonc writes.
 *
 * The provider-management writer (opencode-config/writer.ts) acquires this
 * lock for every write, and the telemetry BridgeService writer is adapted
 * to acquire the very same lock — two writers never interleave temp →
 * reread → rename sequences on the same files.
 */

let chain: Promise<void> = Promise.resolve();

export async function withOpenCodeConfigLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = chain;
  let release!: () => void;
  chain = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Never let a rejected holder poison the chain for subsequent acquirers.
  chain.catch(() => {});
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}
