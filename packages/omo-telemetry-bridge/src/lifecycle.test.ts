/**
 * Permanent TB-OWN-* ownership regression tests (Phase 2).
 *
 * Traceability to the original scenarios:
 * - TB-OWN-01: one init → one serve/listener/refcount 1.
 * - TB-OWN-02: two sequential actual resolution+identity+acquire paths,
 *   distinct pluginInstanceIds, exact same runtime key → one serve/ref2/reuse.
 * - TB-OWN-03: deterministic stallable async factory — Starting published,
 *   first serve blocked by an explicit test gate, second joins; release the
 *   gate; one serve, same epoch, two settled leases. No sleep.
 * - TB-OWN-04: same PID/realm earlier active owner is reused, never rebound.
 * - TB-OWN-05: every incompatible key dimension / missing managed identity →
 *   typed reject; zero bind/refcount/stop/adopt.
 * - TB-OWN-06: one of two disposals keeps active/ref1/no stop.
 * - TB-OWN-07: final/repeat/stale/out-of-order disposal; stop exactly once;
 *   stop failure fenced (failed-stop rejects new acquisitions/rebinds).
 * - TB-OWN-08: activation absent/partial/malformed/missing origin and exact
 *   nonce/runtime identity — zero bind unless complete (resolution level).
 * - TB-OWN-09: bind/publication failure explicit; all waiters settle; no
 *   successful unbound hook/fallback/retry/adopt.
 * - TB-OWN-10: clean stop/restart reclaims the exact same port, new epoch and
 *   new pluginInstanceId, exact fingerprint/origin, no alternate port.
 *
 * Auxiliary:
 * - TB-OWN-AUX-01: import-path registry equivalence (separate module
 *   evaluation shares the Symbol.for registry).
 * - TB-OWN-AUX-02: same-PID Worker realm classification (no live listener):
 *   proves the registry is realm-local, not cross-realm.
 * - TB-OWN-AUX-03: cooperative foreign listener on fixed test port 18788 →
 *   real factory produces a typed EADDRINUSE loser; foreign listener
 *   untouched; no adoption.
 *
 * All tests use fake factories except AUX-03, which uses a cooperative
 * node:net holder plus the real Bun.serve factory on the test-only port
 * 18788 (never a managed/production port).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import {
  __acquireBridgeWithTestPortForTests,
  __bridgeActiveForTests,
  __bridgeOwnerEpochForTests,
  __bridgeRefcountForTests,
  __bridgeRegistryStateForTests,
  __failNextPoisonReadsForTests,
  __failNextPoisonWritesForTests,
  __failNextRegistryReadsForTests,
  __failNextRegistryWritesForTests,
  __realmPoisonForTests,
  __releaseLeaseForTests,
  __resetBridgeRegistryForTests,
  acquireBridge,
  BridgeActivationError,
  BRIDGE_REGISTRY_SYMBOL,
  type BridgeFetchHandler,
  type BridgeLease,
  type BridgeServerFactory,
  type BridgeServerHandle,
} from "./lifecycle";
import { resolveBridgeActivation, type BridgeActivation } from "./options";
import { captureBridgeIdentity, type BridgeIdentity } from "./stores";

const noopFetch: BridgeFetchHandler = () => new Response("ok");
const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);
const ORIGIN = "http://127.0.0.1:4096";

function makeActivation(port: number, fingerprint: string = FP_A): BridgeActivation {
  return { host: "127.0.0.1", port, channel: "env", nonceFingerprint: fingerprint };
}

function makeIdentity(id: string, overrides: Partial<BridgeIdentity> = {}): BridgeIdentity {
  return {
    pluginInstanceId: id,
    startupTimestamp: 1000,
    canonicalOrigin: ORIGIN,
    transportMode: "loopback-http",
    schemaVersion: 3,
    capturedAt: 1000,
    nonceFingerprint: FP_A,
    ...overrides,
  };
}

class FakeServer implements BridgeServerHandle {
  readonly hostname: string;
  readonly port: number;
  stopped = false;
  stopCalls = 0;
  failStop = false;
  /** Optional synchronous hook invoked inside stop() (reentrancy tests). */
  onStop: (() => void) | undefined;
  /** When set, stop() awaits this latch before resolving (async gate). */
  stopGate: { promise: Promise<void>; release: () => void } | undefined;
  constructor(hostname: string, port: number) {
    this.hostname = hostname;
    this.port = port;
  }
  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.onStop?.();
    if (this.stopGate) await this.stopGate.promise;
    if (this.failStop) throw new Error("stop failed");
    this.stopped = true;
  }
}

class FakeFactory implements BridgeServerFactory {
  readonly servers: FakeServer[] = [];
  failWith: Error | undefined;
  /** When set, serve returns a promise gated on this latch. */
  gate: { promise: Promise<void>; release: () => void } | undefined;
  /** Optional synchronous hook invoked inside serve() (reentrancy tests). */
  onServe: (() => void) | undefined;
  /** When true, every created server rejects its stop() (async). */
  failStopServers = false;
  /** When set, every created server's stop() awaits this latch first. */
  stopGateForServers: { promise: Promise<void>; release: () => void } | undefined;

  serve(opts: {
    hostname: string;
    port: number;
    fetch: BridgeFetchHandler;
  }): BridgeServerHandle | Promise<BridgeServerHandle> {
    const make = () => {
      if (this.failWith) throw this.failWith;
      this.onServe?.();
      const server = new FakeServer(opts.hostname, opts.port);
      server.failStop = this.failStopServers;
      server.stopGate = this.stopGateForServers;
      this.servers.push(server);
      return server;
    };
    if (this.gate) {
      return this.gate.promise.then(make);
    }
    return make();
  }
}

function makeGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

afterEach(async () => {
  await __resetBridgeRegistryForTests();
});

/* ------------------------------------------------------------------ */

describe("TB-OWN-01: one init → one serve/listener/refcount 1", () => {
  test("single acquire binds once with refcount 1 and a fresh epoch", async () => {
    const factory = new FakeFactory();
    const lease = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-1"),
      factory,
      noopFetch,
    );
    expect(lease.reused).toBe(false);
    expect(lease.epoch).toBe(__bridgeOwnerEpochForTests() as string);
    expect(factory.servers.length).toBe(1);
    expect(factory.servers[0]!.port).toBe(8788);
    expect(__bridgeRegistryStateForTests()).toBe("active");
    expect(__bridgeRefcountForTests()).toBe(1);
  });
});

describe("TB-OWN-02: two sequential full init paths share one epoch", () => {
  test("distinct pluginInstanceIds, exact same key → one serve, ref2, reuse", async () => {
    const factory = new FakeFactory();
    const env = {
      OMO_BRIDGE_PORT: "8788",
      OMO_BRIDGE_ACTIVATION_NONCE: "shared-managed-nonce-0001",
    };

    // First actual init path: resolve → identity → acquire.
    const r1 = await resolveBridgeActivation(undefined, env);
    expect(r1.kind).toBe("active");
    if (r1.kind !== "active") return;
    const id1 = await captureBridgeIdentity({
      serverUrl: ORIGIN,
      nonceFingerprint: r1.activation.nonceFingerprint,
    });
    const lease1 = await acquireBridge(r1.activation, id1, factory, noopFetch);

    // Second actual init path (fresh identity → distinct pluginInstanceId).
    const r2 = await resolveBridgeActivation(undefined, env);
    if (r2.kind !== "active") throw new Error("unreachable");
    const id2 = await captureBridgeIdentity({
      serverUrl: ORIGIN,
      nonceFingerprint: r2.activation.nonceFingerprint,
    });
    const lease2 = await acquireBridge(r2.activation, id2, factory, noopFetch);

    expect(id1.pluginInstanceId).not.toBe(id2.pluginInstanceId);
    expect(lease2.reused).toBe(true);
    expect(lease2.epoch).toBe(lease1.epoch);
    expect(lease2.identity.pluginInstanceId).toBe(id1.pluginInstanceId);
    expect(factory.servers.length).toBe(1);
    expect(__bridgeRefcountForTests()).toBe(2);
  });
});

describe("TB-OWN-03: concurrent acquisitions join one starting epoch", () => {
  test("Starting published before serve; waiter joins; one serve; same epoch", async () => {
    const factory = new FakeFactory();
    factory.gate = makeGate();

    const p1 = acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch);
    // Let the creator reach the gated serve call (Starting already published).
    await Promise.resolve();
    await Promise.resolve();

    // Starting must be published BEFORE serve completes (and before it is
    // even released): the second acquisition sees and joins it.
    expect(__bridgeRegistryStateForTests()).toBe("starting");
    const startingEpoch = __bridgeOwnerEpochForTests();

    const p2 = acquireBridge(makeActivation(8788), makeIdentity("id-2"), factory, noopFetch);
    await Promise.resolve();
    // Still exactly one serve call — the waiter joined instead of binding.
    expect(factory.servers.length).toBe(0); // gated: not yet resolved
    expect(__bridgeRegistryStateForTests()).toBe("starting");

    factory.gate.release();
    const [lease1, lease2] = await Promise.all([p1, p2]);
    expect(factory.servers.length).toBe(1);
    expect(lease1.reused).toBe(false);
    expect(lease2.reused).toBe(true);
    expect(lease1.epoch).toBe(startingEpoch as string);
    expect(lease2.epoch).toBe(startingEpoch as string);
    expect(__bridgeRefcountForTests()).toBe(2);
  });

  test("synchronous serve reentrancy: incompatible nested rejects, compatible nested joins — no deadlock", async () => {
    // A realistic factory may synchronously trigger reentrant acquisitions
    // inside serve() (e.g. a callback that itself initializes a plugin). The
    // nested calls must NOT deadlock: an incompatible key rejects
    // immediately (typed), a compatible key joins the in-flight starting
    // epoch and settles after the creator completes.
    const factory = new FakeFactory();
    let nestedIncompatible: Promise<unknown> | undefined;
    let nestedCompatible: Promise<unknown> | undefined;
    factory.onServe = () => {
      // Incompatible nested acquisition (different port): synchronous prefix
      // observes the Starting record and rejects typed — no bind attempted.
      nestedIncompatible = acquireBridge(
        makeActivation(8790),
        makeIdentity("id-nested-incompat"),
        factory,
        noopFetch,
      ).then(
        () => "resolved",
        (e: unknown) => e,
      );
      // Compatible nested acquisition joins the starting epoch (async join,
      // settles when the creator finishes — serve() itself never blocks).
      nestedCompatible = acquireBridge(
        makeActivation(8788),
        makeIdentity("id-nested-compat"),
        factory,
        noopFetch,
      );
    };

    const creator = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-creator"),
      factory,
      noopFetch,
    );
    expect(creator.reused).toBe(false);

    const incompat = await nestedIncompatible!;
    expect(incompat).toBeInstanceOf(BridgeActivationError);
    expect((incompat as BridgeActivationError).code).toBe("activation-incompatible");

    const nested = (await nestedCompatible!) as BridgeLease;
    expect(nested.epoch).toBe(creator.epoch);
    expect(nested.reused).toBe(true);
    // Exactly one serve happened for three acquisitions.
    expect(factory.servers.length).toBe(1);
    expect(__bridgeRefcountForTests()).toBe(2);
  });

  test("failed start settles every waiter with the same typed error", async () => {
    const factory = new FakeFactory();
    factory.gate = makeGate();
    factory.failWith = new Error("listen EADDRINUSE 127.0.0.1:8788");

    const p1 = acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch);
    await Promise.resolve();
    await Promise.resolve();
    const p2 = acquireBridge(makeActivation(8788), makeIdentity("id-2"), factory, noopFetch);

    factory.gate.release();
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("rejected");
    const e1 = (r1 as PromiseRejectedResult).reason as BridgeActivationError;
    const e2 = (r2 as PromiseRejectedResult).reason as BridgeActivationError;
    expect(e1).toBeInstanceOf(BridgeActivationError);
    expect(e1.code).toBe("activation-start-failed");
    expect(e1.detail).toBe("EADDRINUSE");
    expect(e2.code).toBe("activation-start-failed");
    // Waiter receives the same typed error (settled, not hanging).
    expect(e2.detail).toBe("EADDRINUSE");
    // No raw error message text leaks into the typed error.
    expect(e1.message).not.toContain("listen EADDRINUSE 127.0.0.1");
    // Slot returns to Absent after a failed start.
    expect(__bridgeRegistryStateForTests()).toBe("absent");
  });
});

describe("TB-OWN-04: same-realm active owner is reused, never rebound", () => {
  test("sequential acquisitions reuse the active epoch without new serve", async () => {
    const factory = new FakeFactory();
    const lease1 = await acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch);
    const lease2 = await acquireBridge(makeActivation(8788), makeIdentity("id-2"), factory, noopFetch);
    const lease3 = await acquireBridge(makeActivation(8788), makeIdentity("id-3"), factory, noopFetch);
    expect(factory.servers.length).toBe(1);
    expect(lease2.epoch).toBe(lease1.epoch);
    expect(lease3.epoch).toBe(lease1.epoch);
    expect(__bridgeRefcountForTests()).toBe(3);
  });
});

describe("TB-OWN-05: incompatible/missing identity → typed reject, zero side effects", () => {
  async function expectIncompatible(
    name: string,
    activation: BridgeActivation,
    identity: BridgeIdentity,
  ): Promise<void> {
    const factory = new FakeFactory();
    await expect(acquireBridge(activation, identity, factory, noopFetch)).rejects.toMatchObject({
      code: "activation-incompatible",
    });
    expect(factory.servers.length).toBe(0);
    expect(__bridgeRefcountForTests()).toBe(0);
    void name;
  }

  test("each incompatible key dimension rejects against an active epoch", async () => {
    const factory = new FakeFactory();
    await acquireBridge(makeActivation(8788, FP_A), makeIdentity("id-owner"), factory, noopFetch);
    expect(__bridgeRefcountForTests()).toBe(1);

    // Different port.
    await expect(
      acquireBridge(makeActivation(8789, FP_A), makeIdentity("id-x"), factory, noopFetch),
    ).rejects.toMatchObject({ code: "activation-incompatible" });
    // Different nonce fingerprint.
    await expect(
      acquireBridge(
        makeActivation(8788, FP_B),
        makeIdentity("id-x", { nonceFingerprint: FP_B }),
        factory,
        noopFetch,
      ),
    ).rejects.toMatchObject({ code: "activation-incompatible" });
    // Different canonical origin.
    await expect(
      acquireBridge(
        makeActivation(8788, FP_A),
        makeIdentity("id-x", { canonicalOrigin: "http://localhost:4096" }),
        factory,
        noopFetch,
      ),
    ).rejects.toMatchObject({ code: "activation-incompatible" });
    // Different schema version.
    await expect(
      acquireBridge(
        makeActivation(8788, FP_A),
        makeIdentity("id-x", { schemaVersion: 2 }),
        factory,
        noopFetch,
      ),
    ).rejects.toMatchObject({ code: "activation-incompatible" });

    // Zero side effects from every rejection.
    expect(factory.servers.length).toBe(1);
    expect(__bridgeRefcountForTests()).toBe(1);
    expect(__bridgeRegistryStateForTests()).toBe("active");
  });

  test("missing managed identity fields reject before any bind", async () => {
    await expectIncompatible(
      "missing origin",
      makeActivation(8788),
      makeIdentity("id-x", { canonicalOrigin: undefined }),
    );
    await expectIncompatible(
      "missing identity fingerprint",
      makeActivation(8788),
      makeIdentity("id-x", { nonceFingerprint: undefined }),
    );
    await expectIncompatible(
      "wrong schema version",
      makeActivation(8788),
      makeIdentity("id-x", { schemaVersion: 99 }),
    );
  });
});

describe("TB-OWN-06: intermediate dispose preserves the listener", () => {
  test("one of two disposals keeps active/ref1/no stop", async () => {
    const factory = new FakeFactory();
    const lease1 = await acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch);
    const lease2 = await acquireBridge(makeActivation(8788), makeIdentity("id-2"), factory, noopFetch);
    const server = factory.servers[0]!;

    expect(await lease1.dispose()).toBe(false);
    expect(__bridgeRefcountForTests()).toBe(1);
    expect(__bridgeRegistryStateForTests()).toBe("active");
    expect(server.stopCalls).toBe(0);
    expect(server.stopped).toBe(false);

    expect(await lease2.dispose()).toBe(true);
    expect(server.stopCalls).toBe(1);
    expect(__bridgeRegistryStateForTests()).toBe("absent");
  });
});

describe("TB-OWN-07: disposal ordering, idempotence, epoch fencing, stop fence", () => {
  test("repeated dispose on one lease never double-decrements", async () => {
    const factory = new FakeFactory();
    const lease1 = await acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch);
    await acquireBridge(makeActivation(8788), makeIdentity("id-2"), factory, noopFetch);
    expect(await lease1.dispose()).toBe(false);
    expect(await lease1.dispose()).toBe(false);
    expect(__bridgeRefcountForTests()).toBe(1);
    expect(factory.servers[0]!.stopCalls).toBe(0);
  });

  test("final dispose stops exactly once; later disposals are no-ops", async () => {
    const factory = new FakeFactory();
    const lease = await acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch);
    expect(await lease.dispose()).toBe(true);
    expect(factory.servers[0]!.stopCalls).toBe(1);
    expect(await lease.dispose()).toBe(false);
    expect(factory.servers[0]!.stopCalls).toBe(1);
    expect(__bridgeRegistryStateForTests()).toBe("absent");
  });

  test("stale epoch release reaches the epoch-mismatch branch and cannot affect a newer epoch", async () => {
    const factory = new FakeFactory();
    const oldLease = await acquireBridge(makeActivation(8788), makeIdentity("id-old"), factory, noopFetch);
    const oldEpoch = oldLease.epoch;
    await oldLease.dispose(); // epoch 1 ends; server 1 stopped once.
    expect(factory.servers[0]!.stopCalls).toBe(1);

    const newLease = await acquireBridge(makeActivation(8788), makeIdentity("id-new"), factory, noopFetch);
    expect(newLease.epoch).not.toBe(oldEpoch);
    expect(__bridgeRefcountForTests()).toBe(1);

    // Repeated dispose is stopped by the local idempotent guard.
    expect(await oldLease.dispose()).toBe(false);
    // A truly stale release (bypassing the guard via the test seam) reaches
    // the epoch-mismatch branch and must not touch the new epoch.
    expect(await __releaseLeaseForTests(oldEpoch)).toBe(false);
    expect(__bridgeRefcountForTests()).toBe(1);
    expect(factory.servers[1]!.stopCalls).toBe(0);
    expect(__bridgeRegistryStateForTests()).toBe("active");
    // A release for a never-existent epoch is equally inert.
    expect(await __releaseLeaseForTests("no-such-epoch")).toBe(false);
    expect(__bridgeRefcountForTests()).toBe(1);
  });

  test("out-of-order disposal: second lease disposed first still stops exactly once at zero", async () => {
    const factory = new FakeFactory();
    const lease1 = await acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch);
    const lease2 = await acquireBridge(makeActivation(8788), makeIdentity("id-2"), factory, noopFetch);
    expect(await lease2.dispose()).toBe(false);
    expect(__bridgeRefcountForTests()).toBe(1);
    expect(await lease1.dispose()).toBe(true);
    expect(factory.servers[0]!.stopCalls).toBe(1);
    expect(__bridgeRegistryStateForTests()).toBe("absent");
  });

  test("stop failure fences the registry: no rebind, no new acquisition", async () => {
    const factory = new FakeFactory();
    const lease = await acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch);
    factory.servers[0]!.failStop = true;

    expect(await lease.dispose()).toBe(true); // final release performed
    expect(__bridgeRegistryStateForTests()).toBe("failed-stop");

    // Fenced: every new acquisition rejects typed, even with the same key.
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-2"), factory, noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced", detail: "stop-failed" });
    // No new serve call, no second stop attempt, server record retained.
    expect(factory.servers.length).toBe(1);
    expect(factory.servers[0]!.stopCalls).toBe(1);
    expect(factory.servers[0]!.stopped).toBe(false);
  });
});

describe("TB-OWN-08: activation resolution gates binding (resolution level)", () => {
  test("absent/partial/mixed/malformed activations never reach acquire", async () => {
    // Absent.
    expect((await resolveBridgeActivation(undefined, {})).kind).toBe("inactive");
    // Partial (env port only).
    expect(
      (await resolveBridgeActivation(undefined, { OMO_BRIDGE_PORT: "8788" })).kind,
    ).toBe("invalid");
    // Mixed channels.
    expect(
      (
        await resolveBridgeActivation(
          { port: 8788 },
          { OMO_BRIDGE_ACTIVATION_NONCE: "env-nonce-0123456789ab" },
        )
      ).kind,
    ).toBe("invalid");
    // Malformed nonce.
    expect(
      (await resolveBridgeActivation({ port: 8788, activationNonce: "short" }, {})).kind,
    ).toBe("invalid");
    // Complete env channel activates with exact identity.
    const ok = await resolveBridgeActivation(undefined, {
      OMO_BRIDGE_PORT: "8788",
      OMO_BRIDGE_ACTIVATION_NONCE: "env-nonce-0123456789ab",
    });
    expect(ok.kind).toBe("active");
    if (ok.kind === "active") {
      expect(ok.activation.port).toBe(8788);
      expect(ok.activation.nonceFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(ok)).not.toContain("env-nonce-0123456789ab");
    }
  });

  test("missing canonical origin is rejected before acquire/bind", async () => {
    const factory = new FakeFactory();
    const identity = await captureBridgeIdentity({
      serverUrl: undefined,
      nonceFingerprint: FP_A,
    });
    expect(identity.canonicalOrigin).toBeUndefined();
    await expect(
      acquireBridge(makeActivation(8788), identity, factory, noopFetch),
    ).rejects.toMatchObject({ code: "activation-incompatible" });
    expect(factory.servers.length).toBe(0);
  });
});

describe("TB-OWN-09: bind/publication failures are explicit typed rejections", () => {
  test("bind failure: typed EADDRINUSE, no unbound success, slot cleared", async () => {
    const factory = new FakeFactory();
    factory.failWith = new Error("listen EADDRINUSE 127.0.0.1:8788");
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch),
    ).rejects.toMatchObject({
      code: "activation-start-failed",
      detail: "EADDRINUSE",
    });
    expect(__bridgeRegistryStateForTests()).toBe("absent");
    expect(__bridgeRefcountForTests()).toBe(0);
  });

  test("non-EADDRINUSE serve failure classifies as serve-failed", async () => {
    const factory = new FakeFactory();
    factory.failWith = new Error("some other bind problem with raw details");
    const err = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-1"),
      factory,
      noopFetch,
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    if (!(err instanceof BridgeActivationError)) {
      throw new Error("expected typed rejection");
    }
    expect(err.code).toBe("activation-start-failed");
    expect(err.detail).toBe("serve-failed");
    expect(err.message).not.toContain("raw details");
  });

  test("starting publication failure → zero serve calls, typed reject", async () => {
    const factory = new FakeFactory();
    __failNextRegistryWritesForTests(1);
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch),
    ).rejects.toMatchObject({
      code: "activation-registry-failed",
      detail: "registry-write-failed",
    });
    expect(factory.servers.length).toBe(0);
    expect(__bridgeRegistryStateForTests()).toBe("absent");
  });

  test("active-transition publication failure → owned handle stopped exactly once, blocking record left", async () => {
    const factory = new FakeFactory();
    // acquireBridge runs synchronously up to the serve await, so the Starting
    // record is already published when the call returns. Arming one failed
    // write now deterministically fails the Active transition write.
    const p = acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch);
    expect(__bridgeRegistryStateForTests()).toBe("starting");
    __failNextRegistryWritesForTests(1);
    await expect(p).rejects.toMatchObject({
      code: "activation-registry-failed",
      detail: "registry-write-failed",
    });
    expect(factory.servers.length).toBe(1);
    expect(factory.servers[0]!.stopCalls).toBe(1); // stopped exactly once
    // Cleanup could not be proven → an explicit BLOCKING failed-start record
    // is left; it is never reusable and rejects new acquisitions.
    expect(__bridgeRegistryStateForTests()).toBe("failed-start");
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-2"), new FakeFactory(), noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced" });
  });

  test("active-transition publication failure with failing stop → failed-stop fence, never rebound", async () => {
    class FailStopFactory implements BridgeServerFactory {
      readonly server = new FakeServer("127.0.0.1", 8788);
      serve(): BridgeServerHandle {
        this.server.failStop = true;
        return this.server;
      }
    }
    const failStopFactory = new FailStopFactory();
    const p = acquireBridge(makeActivation(8788), makeIdentity("id-1"), failStopFactory, noopFetch);
    expect(__bridgeRegistryStateForTests()).toBe("starting");
    __failNextRegistryWritesForTests(1); // fail the Active write
    await expect(p).rejects.toMatchObject({
      code: "activation-registry-failed",
      detail: "stop-failed",
    });
    expect(failStopFactory.server.stopCalls).toBe(1);
    expect(__bridgeRegistryStateForTests()).toBe("failed-stop");
    // Fenced: no rebind, no new serve call.
    const factory = new FakeFactory();
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-2"), factory, noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced" });
    expect(factory.servers.length).toBe(0);
  });

  test("a later fresh attempt after a failed start may succeed (Absent again)", async () => {
    const factory = new FakeFactory();
    factory.failWith = new Error("EADDRINUSE");
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch),
    ).rejects.toMatchObject({ code: "activation-start-failed" });
    factory.failWith = undefined;
    const lease = await acquireBridge(makeActivation(8788), makeIdentity("id-2"), factory, noopFetch);
    expect(lease.reused).toBe(false);
    expect(__bridgeRegistryStateForTests()).toBe("active");
  });
});

describe("TB-OWN-10: clean stop/restart reclaims the same port with a new epoch", () => {
  test("restart re-acquires 8788, new epoch + new owner identity, exact key", async () => {
    const factory = new FakeFactory();
    const lease1 = await acquireBridge(
      makeActivation(8788, FP_A),
      makeIdentity("id-first"),
      factory,
      noopFetch,
    );
    const epoch1 = lease1.epoch;
    expect(await lease1.dispose()).toBe(true);
    expect(factory.servers[0]!.stopCalls).toBe(1);
    expect(__bridgeRegistryStateForTests()).toBe("absent");

    const lease2 = await acquireBridge(
      makeActivation(8788, FP_A),
      makeIdentity("id-second"),
      factory,
      noopFetch,
    );
    expect(lease2.reused).toBe(false);
    expect(lease2.epoch).not.toBe(epoch1);
    expect(lease2.identity.pluginInstanceId).toBe("id-second");
    expect(factory.servers.length).toBe(2);
    // Exact same port reclaimed — no alternate port anywhere.
    expect(factory.servers[0]!.port).toBe(8788);
    expect(factory.servers[1]!.port).toBe(8788);
    expect(__bridgeRefcountForTests()).toBe(1);
  });
});

describe("TB-OWN-07b: stopping state and stop reentrancy", () => {
  test("acquire observing stopping rejects typed; nested acquire during stop gets no lease/bind", async () => {
    const factory = new FakeFactory();
    const lease = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-1"),
      factory,
      noopFetch,
    );
    const server = factory.servers[0]!;

    let nestedResult: unknown;
    server.onStop = () => {
      // Synchronous reentrant acquisition DURING stop: the registry holds
      // the stopping record; the nested acquire must reject typed, never
      // reuse/refcount/rebind.
      nestedResult = acquireBridge(
        makeActivation(8788),
        makeIdentity("id-nested"),
        new FakeFactory(),
        noopFetch,
      ).then(
        () => "resolved",
        (e: unknown) => e,
      );
    };

    expect(await lease.dispose()).toBe(true);
    const nested = await nestedResult;
    expect(nested).toBeInstanceOf(BridgeActivationError);
    expect((nested as BridgeActivationError).code).toBe("activation-fenced");
    // Stop completed exactly once; slot cleared by the exact stopping epoch.
    expect(server.stopCalls).toBe(1);
    expect(__bridgeRegistryStateForTests()).toBe("absent");
  });

  test("outer cleanup cannot clear a replacement that appeared during stop", async () => {
    const factory = new FakeFactory();
    const lease = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-1"),
      factory,
      noopFetch,
    );
    const server = factory.servers[0]!;

    // Simulate a replacement record appearing in the slot during stop()
    // (e.g. adversarial reentrancy). The final clear must NOT remove it.
    const replacement = {
      state: "active",
      epoch: "replacement-epoch",
      key: {
        canonicalOrigin: ORIGIN,
        host: "127.0.0.1",
        port: 8788,
        transportMode: "loopback-http",
        schemaVersion: 3,
        nonceFingerprint: FP_A,
      },
      identity: makeIdentity("id-replacement"),
      server: new FakeServer("127.0.0.1", 8788),
      refcount: 1,
    };
    server.onStop = () => {
      (globalThis as unknown as Record<symbol, unknown>)[BRIDGE_REGISTRY_SYMBOL] =
        replacement;
    };

    expect(await lease.dispose()).toBe(true);
    // The replacement survived: the stopping epoch's clear was compare-and-
    // transition guarded and did not clobber it.
    expect(__bridgeRegistryStateForTests()).toBe("active");
    expect(__bridgeOwnerEpochForTests()).toBe("replacement-epoch");
    expect((replacement.server as FakeServer).stopCalls).toBe(0);
  });
});

describe("TB-OWN-09b: deterministic registry failure injection (fail closed)", () => {
  test("registry read failure → typed reject, zero serve", async () => {
    const factory = new FakeFactory();
    __failNextRegistryReadsForTests(1);
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch),
    ).rejects.toMatchObject({
      code: "activation-registry-failed",
      detail: "registry-read-failed",
    });
    expect(factory.servers.length).toBe(0);
    expect(__bridgeRegistryStateForTests()).toBe("absent");
  });

  test("failed-start cleanup failure leaves a blocking failed-start record", async () => {
    const factory = new FakeFactory();
    factory.failWith = new Error("EADDRINUSE");
    // Writes: 1=Starting publish (ok), 2=failed-start clear (FAIL),
    // 3=blocking failed-start record (ok).
    __failNextRegistryWritesForTests(1, 1);
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch),
    ).rejects.toMatchObject({ code: "activation-start-failed", detail: "EADDRINUSE" });
    expect(__bridgeRegistryStateForTests()).toBe("failed-start");
    // Blocking: new acquisitions reject fenced, zero new serve.
    const factory2 = new FakeFactory();
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-2"), factory2, noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced" });
    expect(factory2.servers.length).toBe(0);
  });

  test("active publication lost to a replacement → own handle stopped once, replacement intact", async () => {
    const factory = new FakeFactory();
    factory.gate = makeGate();
    const p = acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch);
    await Promise.resolve();
    expect(__bridgeRegistryStateForTests()).toBe("starting");

    // A replacement takes the slot while our serve is in flight.
    const replacement = {
      state: "active",
      epoch: "replacement-epoch",
      key: {
        canonicalOrigin: ORIGIN,
        host: "127.0.0.1",
        port: 8788,
        transportMode: "loopback-http",
        schemaVersion: 3,
        nonceFingerprint: FP_A,
      },
      identity: makeIdentity("id-replacement"),
      server: new FakeServer("127.0.0.1", 8788),
      refcount: 1,
    };
    (globalThis as unknown as Record<symbol, unknown>)[BRIDGE_REGISTRY_SYMBOL] =
      replacement;

    factory.gate.release();
    await expect(p).rejects.toMatchObject({
      code: "activation-registry-failed",
      detail: "registry-write-failed",
    });
    // Our just-created handle was stopped exactly once; the replacement was
    // never stopped or clobbered.
    expect(factory.servers[0]!.stopCalls).toBe(1);
    expect((replacement.server as FakeServer).stopCalls).toBe(0);
    expect(__bridgeRegistryStateForTests()).toBe("active");
    expect(__bridgeOwnerEpochForTests()).toBe("replacement-epoch");
  });

  test("stop-success clear failure leaves a blocking cleanup-failed record", async () => {
    const factory = new FakeFactory();
    const lease = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-1"),
      factory,
      noopFetch,
    );
    // Dispose writes: 1=Active→Stopping transition (ok, skipped),
    // 2=Stopping→Absent clear (FAIL), 3=blocking cleanup-failed record (ok).
    __failNextRegistryWritesForTests(1, 1);
    expect(await lease.dispose()).toBe(true);
    expect(factory.servers[0]!.stopCalls).toBe(1); // stopped exactly once
    expect(__bridgeRegistryStateForTests()).toBe("cleanup-failed");
    // Blocking: never reusable, no rebind.
    const factory2 = new FakeFactory();
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-2"), factory2, noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced" });
    expect(factory2.servers.length).toBe(0);
  });

  test("stop failure + fence-write failure still fences the stopping object in place", async () => {
    const factory = new FakeFactory();
    const lease = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-1"),
      factory,
      noopFetch,
    );
    factory.servers[0]!.failStop = true;
    // Dispose writes: 1=Active→Stopping (ok, skipped), 2=Stopping→failed-stop
    // fence (FAIL) → in-place mutation of the stopping object fences it.
    __failNextRegistryWritesForTests(1, 1);
    expect(await lease.dispose()).toBe(true);
    expect(__bridgeRegistryStateForTests()).toBe("failed-stop");
    const factory2 = new FakeFactory();
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-2"), factory2, noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced", detail: "stop-failed" });
    expect(factory2.servers.length).toBe(0);
  });

  test("refcount mutation failure (frozen record) rejects typed and returns no lease", async () => {
    const factory = new FakeFactory();
    await acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch);
    expect(__bridgeRefcountForTests()).toBe(1);
    // Freeze the active record: the refcount transition throws in strict mode.
    const g = globalThis as unknown as Record<symbol, unknown>;
    Object.freeze(g[BRIDGE_REGISTRY_SYMBOL] as object);
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-2"), factory, noopFetch),
    ).rejects.toMatchObject({ code: "activation-registry-failed" });
    // No new serve, refcount untouched.
    expect(factory.servers.length).toBe(1);
    expect(__bridgeRefcountForTests()).toBe(1);
  });
});

describe("TB-OWN-07c: async stop contract (Promise stop)", () => {
  test("Promise-resolving gated stop: stopping visible while awaiting; acquires reject; exact-epoch clear after resolve", async () => {
    const factory = new FakeFactory();
    const lease = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-1"),
      factory,
      noopFetch,
    );
    const server = factory.servers[0]!;
    server.stopGate = makeGate();

    // The dispose prefix (transition to stopping + stop invocation) is
    // synchronous; the stop resolution is awaited.
    const disposing = lease.dispose();
    expect(__bridgeRegistryStateForTests()).toBe("stopping");

    // An acquisition while stopping rejects typed — sync interleave…
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-2"), new FakeFactory(), noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced" });
    // …and after an async gap (still gated, still stopping).
    await Promise.resolve();
    expect(__bridgeRegistryStateForTests()).toBe("stopping");
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-3"), new FakeFactory(), noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced" });

    server.stopGate.release();
    await expect(disposing).resolves.toBe(true);
    expect(server.stopCalls).toBe(1);
    expect(__bridgeRegistryStateForTests()).toBe("absent");

    // A fresh acquisition after the exact-epoch clear succeeds normally.
    const next = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-4"),
      new FakeFactory(),
      noopFetch,
    );
    expect(next.reused).toBe(false);
    expect(next.epoch).not.toBe(lease.epoch);
  });

  test("Promise-rejecting stop fences the exact epoch; acquisitions reject fenced", async () => {
    const factory = new FakeFactory();
    const lease = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-1"),
      factory,
      noopFetch,
    );
    const server = factory.servers[0]!;
    server.stopGate = makeGate();
    server.failStop = true;

    const disposing = lease.dispose();
    expect(__bridgeRegistryStateForTests()).toBe("stopping");
    // While the (about-to-reject) stop is in flight, acquisitions reject fenced via transient poison.
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-2"), new FakeFactory(), noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced" });
    server.stopGate.release();
    await expect(disposing).resolves.toBe(true); // final release performed
    expect(__bridgeRegistryStateForTests()).toBe("failed-stop");
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-3"), new FakeFactory(), noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced", detail: "stop-failed" });
    expect(server.stopCalls).toBe(1);
  });
});

describe("TB-OWN-07d: failed release accounting (retryable same-lease)", () => {
  test("release read failure leaves the lease undisposed; retry succeeds with exact accounting", async () => {
    const factory = new FakeFactory();
    const lease = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-1"),
      factory,
      noopFetch,
    );
    const server = factory.servers[0]!;

    // First dispose: registry read fails → typed retryable REJECTION, no
    // stop, lease NOT settled.
    __failNextRegistryReadsForTests(1);
    await expect(lease.dispose()).rejects.toMatchObject({
      code: "activation-registry-failed",
      detail: "registry-read-failed",
    });
    expect(server.stopCalls).toBe(0);
    expect(__bridgeRefcountForTests()).toBe(1);
    expect(__bridgeRegistryStateForTests()).toBe("active");

    // Retry the SAME lease: succeeds, exactly one final stop.
    await expect(lease.dispose()).resolves.toBe(true);
    expect(server.stopCalls).toBe(1);
    expect(__bridgeRegistryStateForTests()).toBe("absent");
    // A third dispose is the idempotent no-op (already settled).
    await expect(lease.dispose()).resolves.toBe(false);
    expect(server.stopCalls).toBe(1);
  });

  test("Active→Stopping transition write failure is retryable; no phantom ref; one final stop", async () => {
    const factory = new FakeFactory();
    const lease1 = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-1"),
      factory,
      noopFetch,
    );
    const lease2 = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-2"),
      factory,
      noopFetch,
    );
    expect(__bridgeRefcountForTests()).toBe(2);

    // lease2's dispose decrements (2→1, consumed). lease1's first dispose
    // hits an injected transition-write failure → retryable, NOT disposed.
    await expect(lease2.dispose()).resolves.toBe(false);
    expect(__bridgeRefcountForTests()).toBe(1);

    __failNextRegistryWritesForTests(1); // fail the Active→Stopping write
    await expect(lease1.dispose()).rejects.toMatchObject({
      code: "activation-registry-failed",
      detail: "registry-write-failed",
    });
    const server = factory.servers[0]!;
    expect(server.stopCalls).toBe(0); // no stop attempted
    expect(__bridgeRefcountForTests()).toBe(1); // no phantom ref
    expect(__bridgeRegistryStateForTests()).toBe("active");

    // Retry the SAME lease: transitions, stops exactly once, clears.
    await expect(lease1.dispose()).resolves.toBe(true);
    expect(server.stopCalls).toBe(1);
    expect(__bridgeRegistryStateForTests()).toBe("absent");
  });
});

describe("TB-OWN-09c: readback fault injection (write applied, readback failed)", () => {
  test("active publication readback failure poisons the next record and the realm", async () => {
    const factory = new FakeFactory();
    // acquire prefix is synchronous through Starting publish+readback. Arm a
    // read failure hitting exactly the Active-transition readback:
    // reads after this point = CAS before-read (skip 1), CAS after-read (fail).
    const p = acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch);
    expect(__bridgeRegistryStateForTests()).toBe("starting");
    __failNextRegistryReadsForTests(1, 1);

    await expect(p).rejects.toMatchObject({
      code: "activation-registry-failed",
      detail: "registry-write-failed",
    });
    // The just-created handle was stopped exactly once…
    expect(factory.servers[0]!.stopCalls).toBe(1);
    // …the realm is poisoned (write may have applied; state unknowable)…
    const poison = __realmPoisonForTests();
    expect(poison?.reason).toBe("active-publish-unknown");
    // …and every subsequent acquisition rejects fenced with zero new bind.
    const factory2 = new FakeFactory();
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-2"), factory2, noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced" });
    expect(factory2.servers.length).toBe(0);
  });

  test("stop-success clear readback failure leaves cleanup-failed + realm poison", async () => {
    const factory = new FakeFactory();
    const lease = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-1"),
      factory,
      noopFetch,
    );
    const server = factory.servers[0]!;
    // Dispose reads: 1 release read, 2 transition before, 3 transition after,
    // 4 clear before → fail read 5 (clear readback).
    __failNextRegistryReadsForTests(1, 4);
    await expect(lease.dispose()).resolves.toBe(true); // final release performed
    expect(server.stopCalls).toBe(1);
    // The clear write MAY have applied (readback unknowable by design): the
    // slot is either absent or a blocking cleanup-failed record — never a
    // reusable active record — and the realm is poisoned either way.
    expect(["absent", "cleanup-failed"]).toContain(__bridgeRegistryStateForTests());
    expect(__realmPoisonForTests()?.reason).toBe("stop-clear-unknown");
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-2"), new FakeFactory(), noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced" });
  });
});

describe("TB-OWN-09d: replacement + rejected cleanup stop → realm orphan fence", () => {
  test("poison retains orphan metadata; reentrant acquire rejects; replacement intact; zero new bind", async () => {
    const factory = new FakeFactory();
    factory.gate = makeGate();
    const p = acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch);
    await Promise.resolve();
    expect(__bridgeRegistryStateForTests()).toBe("starting");

    // Replacement takes the slot while our serve is in flight.
    const replacement = {
      state: "active",
      epoch: "replacement-epoch",
      key: {
        canonicalOrigin: ORIGIN,
        host: "127.0.0.1",
        port: 8788,
        transportMode: "loopback-http",
        schemaVersion: 3,
        nonceFingerprint: FP_A,
      },
      identity: makeIdentity("id-replacement"),
      server: new FakeServer("127.0.0.1", 8788),
      refcount: 1,
    };
    (globalThis as unknown as Record<symbol, unknown>)[BRIDGE_REGISTRY_SYMBOL] =
      replacement;

    // Our cleanup stop REJECTS (async) — flagged before the gate releases
    // so the created server deterministically rejects its stop().
    factory.failStopServers = true;
    factory.gate.release();
    await expect(p).rejects.toMatchObject({
      code: "activation-registry-failed",
      detail: "stop-failed",
    });

    // Orphan fence: realm poison retains the failed-to-stop handle metadata.
    const poison = __realmPoisonForTests();
    expect(poison?.reason).toBe("active-publish-lost-cleanup-pending");
    expect(poison?.orphanPort).toBe(8788);
    expect(typeof poison?.epoch).toBe("string");
    // The failed handle is retained privately, never adopted.
    expect(poison?.orphanHandle).toBe(factory.servers[0]);
    // Replacement never stopped/clobbered.
    expect((replacement.server as FakeServer).stopCalls).toBe(0);
    expect(__bridgeRegistryStateForTests()).toBe("active");
    expect(__bridgeOwnerEpochForTests()).toBe("replacement-epoch");
    // Reentrant/subsequent acquire: fenced, zero new bind or reuse.
    const factory2 = new FakeFactory();
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-2"), factory2, noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced" });
    expect(factory2.servers.length).toBe(0);
    expect((replacement.server as FakeServer).stopCalls).toBe(0);
  });
});

describe("TB-OWN-07e: single-flight dispose", () => {
  test("two unawaited dispose calls same tick share one release; no double decrement", async () => {
    const factory = new FakeFactory();
    const lease1 = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-1"),
      factory,
      noopFetch,
    );
    const lease2 = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-2"),
      factory,
      noopFetch,
    );
    expect(__bridgeRefcountForTests()).toBe(2);

    // Two concurrent/unawaited dispose calls on the SAME lease: single-flight
    // — one decrement only, no stop, both callers observe the same outcome.
    const d1 = lease1.dispose();
    const d2 = lease1.dispose();
    const [r1, r2] = await Promise.all([d1, d2]);
    expect(r1).toBe(false); // consumed (intermediate)
    expect(r2).toBe(false);
    expect(__bridgeRefcountForTests()).toBe(1);
    expect(factory.servers[0]!.stopCalls).toBe(0);
    expect(__bridgeRegistryStateForTests()).toBe("active");

    // A third call after settlement is a settled no-op.
    await expect(lease1.dispose()).resolves.toBe(false);
    expect(__bridgeRefcountForTests()).toBe(1);

    // The other lease final-disposes exactly once.
    await expect(lease2.dispose()).resolves.toBe(true);
    expect(factory.servers[0]!.stopCalls).toBe(1);
    expect(__bridgeRegistryStateForTests()).toBe("absent");
  });
});

describe("TB-OWN-09e: Active→Stopping post-write readback failure", () => {
  test("readback-unknown fences both candidates, stops once under verified poison, acquisitions reject", async () => {
    const factory = new FakeFactory();
    const lease = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-1"),
      factory,
      noopFetch,
    );
    const server = factory.servers[0]!;
    // Release reads: 1 release read, 2 transition before-read → fail read 3
    // (transition readback): the Stopping write MAY have applied.
    __failNextRegistryReadsForTests(1, 2);
    await expect(lease.dispose()).resolves.toBe(true); // terminal stop performed
    expect(server.stopCalls).toBe(1); // stopped exactly once
    // Whichever candidate the slot holds was fenced in place — never a
    // reusable active, never a stranded live stopping state.
    expect(__bridgeRegistryStateForTests()).toBe("failed-stop");
    // Verified cleanup-pending poison retains the (stopped) handle privately.
    const poison = __realmPoisonForTests();
    expect(poison?.reason).toBe("release-transition-cleanup-pending");
    expect(poison?.orphanHandle).toBe(server);
    // Acquisitions during/after reject typed.
    const factory2 = new FakeFactory();
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-2"), factory2, noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced" });
    expect(factory2.servers.length).toBe(0);
  });

  test("readback-unknown with unverifiable poison typed-fails but retains in-place fence", async () => {
    const factory = new FakeFactory();
    const lease = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-1"),
      factory,
      noopFetch,
    );
    const server = factory.servers[0]!;
    __failNextRegistryReadsForTests(1, 2); // transition readback fails
    __failNextPoisonWritesForTests(1); // poison publish write fails
    await expect(lease.dispose()).rejects.toMatchObject({
      code: "activation-registry-failed",
      detail: "registry-write-failed",
    });
    // Stop was still attempted exactly once; the strongest in-place fence is
    // retained (slot record fenced failed-stop); acquisitions reject fenced
    // via the record even without a verified realm poison.
    expect(server.stopCalls).toBe(1);
    expect(__bridgeRegistryStateForTests()).toBe("failed-stop");
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-2"), new FakeFactory(), noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced" });
  });
});

describe("TB-OWN-09f: delayed cleanup stop under replacement (orphan fence completeness)", () => {
  test("poison verified before cleanup stop; acquisitions reject while pending; rejected stop retains orphan", async () => {
    const factory = new FakeFactory();
    factory.gate = makeGate();
    const p = acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch);
    await Promise.resolve();
    expect(__bridgeRegistryStateForTests()).toBe("starting");

    // Replacement takes the slot while our serve is in flight.
    const replacement = {
      state: "active",
      epoch: "replacement-epoch",
      key: {
        canonicalOrigin: ORIGIN,
        host: "127.0.0.1",
        port: 8788,
        transportMode: "loopback-http",
        schemaVersion: 3,
        nonceFingerprint: FP_A,
      },
      identity: makeIdentity("id-replacement"),
      server: new FakeServer("127.0.0.1", 8788),
      refcount: 1,
    };
    (globalThis as unknown as Record<symbol, unknown>)[BRIDGE_REGISTRY_SYMBOL] =
      replacement;

    // The cleanup stop is GATED and will REJECT after release.
    factory.stopGateForServers = makeGate();
    factory.failStopServers = true;
    factory.gate.release();

    // Wait (microtask-bounded, no timers) until the cleanup-pending poison
    // is published and the delayed stop is in flight.
    let poison = __realmPoisonForTests();
    for (let i = 0; i < 200 && poison === undefined; i++) {
      await Promise.resolve();
      poison = __realmPoisonForTests();
    }
    expect(poison?.reason).toBe("active-publish-lost-cleanup-pending");

    // While the cleanup stop is PENDING, all acquisitions reject via poison
    // — including a reentrant one — with zero new bind/reuse.
    const pendingFactory = new FakeFactory();
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-reentrant"), pendingFactory, noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced" });
    expect(pendingFactory.servers.length).toBe(0);

    // Release the stop gate → stop rejects → acquisition fails typed.
    factory.stopGateForServers.release();
    await expect(p).rejects.toMatchObject({
      code: "activation-registry-failed",
      detail: "stop-failed",
    });

    // Poison remains, retaining the failed handle privately; the replacement
    // was never stopped or clobbered; no new bind/reuse/adoption occurred.
    const after = __realmPoisonForTests();
    expect(after?.orphanHandle).toBe(factory.servers[0]);
    expect((replacement.server as FakeServer).stopCalls).toBe(0);
    expect(__bridgeRegistryStateForTests()).toBe("active");
    expect(__bridgeOwnerEpochForTests()).toBe("replacement-epoch");
    const lateFactory = new FakeFactory();
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-late"), lateFactory, noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced" });
    expect(lateFactory.servers.length).toBe(0);
  });
});

describe("TB-OWN-07f: synchronous reentrant dispose during release / server.stop callback", () => {
  test("synchronous dispose call from inside server.stop callback returns exact promise identity, single stop", async () => {
    const factory = new FakeFactory();
    const lease = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-1"),
      factory,
      noopFetch,
    );
    const server = factory.servers[0]!;
    let reentrantPromise: Promise<boolean> | undefined;

    // Inside the synchronous portion of server.stop(), call the same lease.dispose()
    server.onStop = () => {
      reentrantPromise = lease.dispose();
    };

    const outerPromise = lease.dispose();
    expect(reentrantPromise).toBeDefined();
    expect(reentrantPromise).toBe(outerPromise); // strict Promise identity

    const [outerResult, reentrantResult] = await Promise.all([
      outerPromise,
      reentrantPromise!,
    ]);
    expect(outerResult).toBe(true); // final release performed
    expect(reentrantResult).toBe(true);
    expect(server.stopCalls).toBe(1); // exactly one stop
    expect(__bridgeRegistryStateForTests()).toBe("absent");

    // Subsequent dispose is a settled no-op
    await expect(lease.dispose()).resolves.toBe(false);
    expect(server.stopCalls).toBe(1);
  });
});

describe("TB-OWN-09g: delayed normal final stop under replacement (transient poison fence)", () => {
  test("transient poison fences pending normal final stop; replacement is not reusable on stop reject", async () => {
    const factory = new FakeFactory();
    const lease = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-1"),
      factory,
      noopFetch,
    );
    const server1 = factory.servers[0]!;
    server1.stopGate = makeGate();
    server1.failStop = true; // will reject stop

    // Start disposal
    const disposePromise = lease.dispose();
    await Promise.resolve();

    // While stop is pending, transient poison is active and holds server1
    let poison = __realmPoisonForTests();
    for (let i = 0; i < 200 && poison === undefined; i++) {
      await Promise.resolve();
      poison = __realmPoisonForTests();
    }
    expect(poison).toBeDefined();
    expect(poison?.orphanHandle).toBe(server1);

    // Primary registry slot is replaced while stop is in flight
    const replacement = {
      state: "active" as const,
      epoch: "replacement-epoch-09g",
      key: {
        canonicalOrigin: ORIGIN,
        host: "127.0.0.1" as const,
        port: 8788,
        transportMode: "loopback-http" as const,
        schemaVersion: 3,
        nonceFingerprint: FP_A,
      },
      identity: makeIdentity("id-replacement-09g"),
      server: new FakeServer("127.0.0.1", 8788),
      refcount: 1,
    };
    (globalThis as unknown as Record<symbol, unknown>)[BRIDGE_REGISTRY_SYMBOL] =
      replacement;

    // Acquisition during pending stop rejects via poison with zero reuse/bind
    const pendingFactory = new FakeFactory();
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-pending"), pendingFactory, noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced" });
    expect(pendingFactory.servers.length).toBe(0);

    // Release stop gate → stop rejects
    server1.stopGate.release();
    await expect(disposePromise).resolves.toBe(true); // final stop attempt performed

    // Rejected stop leaves poison retaining failed handle; replacement was NOT clobbered or stopped
    const finalPoison = __realmPoisonForTests();
    expect(finalPoison?.orphanHandle).toBe(server1);
    expect((replacement.server as FakeServer).stopCalls).toBe(0);
    expect(__bridgeRegistryStateForTests()).toBe("active");
    expect(__bridgeOwnerEpochForTests()).toBe("replacement-epoch-09g");

    // Later acquisition still rejects because server1 failed to stop
    const lateFactory = new FakeFactory();
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-late"), lateFactory, noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced" });
    expect(lateFactory.servers.length).toBe(0);
    expect((replacement.server as FakeServer).stopCalls).toBe(0);
  });
});

describe("TB-OWN-09h: poison read failure and fallback fence fail-closed", () => {
  test("poison read failure rejects acquisition fail-closed with zero registry read/reuse/bind", async () => {
    const factory = new FakeFactory();
    // Injected poison read failure
    __failNextPoisonReadsForTests(1);
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch),
    ).rejects.toMatchObject({
      code: "activation-registry-failed",
      detail: "registry-read-failed",
    });
    expect(factory.servers.length).toBe(0);
    expect(__bridgeRegistryStateForTests()).toBe("absent");
  });

  test("poison write failure installs module fallback fence blocking acquisitions before stop", async () => {
    const factory = new FakeFactory();
    const lease = await acquireBridge(
      makeActivation(8788),
      makeIdentity("id-1"),
      factory,
      noopFetch,
    );
    const server = factory.servers[0]!;

    // Release: 1 release read, 2 transition before-read → fail read 3 (transition readback)
    __failNextRegistryReadsForTests(1, 2);
    // Fail global poison write
    __failNextPoisonWritesForTests(1);

    // Dispose attempts stop under fallback fence
    await expect(lease.dispose()).rejects.toMatchObject({
      code: "activation-registry-failed",
      detail: "registry-write-failed",
    });

    // Fallback fence is installed and blocks acquisitions
    const fallback = __realmPoisonForTests();
    expect(fallback).toBeDefined();
    expect(fallback?.orphanHandle).toBe(server);

    const factory2 = new FakeFactory();
    await expect(
      acquireBridge(makeActivation(8788), makeIdentity("id-2"), factory2, noopFetch),
    ).rejects.toMatchObject({ code: "activation-fenced" });
    expect(factory2.servers.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Auxiliary                                                           */
/* ------------------------------------------------------------------ */

describe("TB-OWN-AUX-01: import-path registry equivalence (module reference)", () => {
  // NARROW CLAIM: the Symbol.for registry slot is reachable identically
  // through a re-imported module reference (same realm). This test does NOT
  // claim a separate module evaluation occurred — whether the runtime
  // dedups the specifier is implementation-defined; the registry slot is
  // realm-global either way.
  test("a re-imported module reference observes and reuses the same registry", async () => {
    const factory = new FakeFactory();
    const lease = await acquireBridge(makeActivation(8788), makeIdentity("id-1"), factory, noopFetch);

    const reimported = await import("./lifecycle");
    expect(reimported.BRIDGE_REGISTRY_SYMBOL).toBe(BRIDGE_REGISTRY_SYMBOL);
    expect(reimported.__bridgeRegistryStateForTests()).toBe("active");

    // Acquisition through the re-imported reference reuses the same epoch.
    const lease2 = await reimported.acquireBridge(
      makeActivation(8788),
      makeIdentity("id-2"),
      factory,
      noopFetch,
    );
    expect(lease2.epoch).toBe(lease.epoch);
    expect(factory.servers.length).toBe(1);
    expect(reimported.__bridgeRefcountForTests()).toBe(2);
  });
});

describe("TB-OWN-AUX-02: same-PID Worker realm classification (no live listener)", () => {
  test("a Worker in the SAME PID does NOT share the realm-global registry", async () => {
    const factory = new FakeFactory();
    await acquireBridge(makeActivation(8788), makeIdentity("id-main"), factory, noopFetch);
    expect(__bridgeRegistryStateForTests()).toBe("active");

    // Permanent realm-isolation marker: a value published under a Symbol.for
    // key in THIS realm. A truly separate realm (distinct global symbol
    // registry + distinct globalThis) must not observe it, and its own write
    // under the same key must not leak back into this realm.
    const MARKER_SYMBOL = Symbol.for("omo-telemetry-bridge.test.realm-marker");
    const mainMarker = `main-realm-${crypto.randomUUID()}`;
    const g = globalThis as unknown as Record<symbol, unknown>;
    g[MARKER_SYMBOL] = mainMarker;

    const dir = mkdtempSync(join(tmpdir(), "tb-own-worker-"));
    const workerPath = join(dir, "worker.ts");
    const srcDir = new URL(".", import.meta.url).pathname;
    const lifecyclePath = join(srcDir, "lifecycle.ts");
    writeFileSync(
      workerPath,
      `
      import { __bridgeRegistryStateForTests } from ${JSON.stringify(lifecyclePath)};
      declare const self: Worker;
      const marker = Symbol.for("omo-telemetry-bridge.test.realm-marker");
      const g = globalThis as unknown as Record<symbol, unknown>;
      const observedMainMarker = g[marker];
      g[marker] = "worker-realm-marker";
      self.postMessage({
        pid: process.pid,
        state: __bridgeRegistryStateForTests(),
        observedMainMarker: observedMainMarker === undefined ? undefined : String(observedMainMarker),
      });
      `,
    );
    try {
      const worker = new Worker(workerPath);
      const msg = await new Promise<{
        pid: number;
        state: string;
        observedMainMarker: string | undefined;
      }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker timeout")), 10_000);
        worker.onmessage = (evt: MessageEvent) => {
          clearTimeout(timer);
          resolve(
            evt.data as {
              pid: number;
              state: string;
              observedMainMarker: string | undefined;
            },
          );
        };
        worker.onerror = (e: Event) => {
          clearTimeout(timer);
          reject(new Error(`worker failed: ${String(e)}`));
        };
      });
      worker.terminate();
      // Same process…
      expect(msg.pid).toBe(process.pid);
      // …but a distinct realm: the Worker observed neither this realm's
      // Symbol.for marker nor this realm's active registry record…
      expect(msg.observedMainMarker).toBeUndefined();
      expect(msg.state).toBe("absent");
      // …and the Worker's own marker write under the same key did not leak
      // back into this realm.
      expect(g[MARKER_SYMBOL]).toBe(mainMarker);
      // Narrow claim: the registry is realm-local; cross-realm reuse is
      // impossible and a cross-realm duplicate bind surfaces as a typed loser.
      expect(__bridgeRegistryStateForTests()).toBe("active");
    } finally {
      delete g[MARKER_SYMBOL];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("TB-OWN-AUX-03: cooperative foreign listener → typed loser, no adoption", () => {
  test("real Bun.serve on held test-only port 18788 rejects typed EADDRINUSE", async () => {
    // Cooperative foreign holder on the test-only (non-managed) port 18788.
    // The unmanaged-port test seam (__acquireBridgeWithTestPortForTests) lets
    // the collision run through the REAL bind path; the production plugin
    // entry enforces the managed range and can never reach port 18788.
    const holder: Server = createServer();
    const held = await new Promise<boolean>((resolve) => {
      holder.once("error", () => resolve(false));
      holder.listen(18788, "127.0.0.1", () => resolve(true));
    });
    if (!held) {
      // Never silently pass and never choose another port: fail explicitly.
      throw new Error(
        "TB-OWN-AUX-03 fixture unavailable: could not hold 127.0.0.1:18788 for the collision test",
      );
    }
    try {
      const realFactory: BridgeServerFactory = {
        serve(opts): BridgeServerHandle {
          return Bun.serve({
            hostname: opts.hostname,
            port: opts.port,
            fetch: opts.fetch,
          }) as unknown as BridgeServerHandle;
        },
      };
      const err = await __acquireBridgeWithTestPortForTests(
        makeActivation(18788),
        makeIdentity("id-foreign-test"),
        realFactory,
        noopFetch,
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      if (!(err instanceof BridgeActivationError)) {
        throw new Error("expected typed rejection");
      }
      expect(err.code).toBe("activation-start-failed");
      expect(err.detail).toBe("EADDRINUSE");
      // Foreign listener untouched; no adoption, no rebind, slot cleared.
      expect(__bridgeRegistryStateForTests()).toBe("absent");
      const stillHeld = await new Promise<boolean>((resolve) => {
        const probe = createServer();
        probe.once("error", () => resolve(true)); // still held by holder
        probe.listen(18788, "127.0.0.1", () => {
          probe.close(() => resolve(false));
        });
      });
      expect(stillHeld).toBe(true);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  test("production acquireBridge never permits the unmanaged test port", async () => {
    // 18788 is outside the managed range: the production path rejects before
    // any serve call (zero bind), even with a willing factory.
    const factory = new FakeFactory();
    await expect(
      acquireBridge(makeActivation(18788), makeIdentity("id-x"), factory, noopFetch),
    ).rejects.toMatchObject({ code: "activation-incompatible" });
    expect(factory.servers.length).toBe(0);
  });
});
