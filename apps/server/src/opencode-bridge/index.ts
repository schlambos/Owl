/**
 * Slice 17 hardened — OpenCode config/source/revision foundation barrel.
 *
 * Exposes the managed bridge plugin lane foundation for future route
 * wiring. Does NOT modify index.ts; route wiring is the lifecycle/API
 * lane's responsibility.
 *
 * NOT exported from this barrel (oracle decision 4/8):
 *  - launch-boundary.ts (internal, imported directly by future sdk-adapter)
 *  - getRawCommittedNonce (internal method on BridgeRevisionStore)
 */

export * from "./types";
export * from "./canonical";
export * from "./extractor";
export * from "./resolver";
export * from "./port-selection";
export * from "./override";
export * from "./watcher";
export * from "./revisions-bridge";
export * from "./byte-patch";
export * from "./service";