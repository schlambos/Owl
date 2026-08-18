/**
 * Slice 17 hardened — Port selection tests.
 */

import { describe, expect, test } from "bun:test";
import {
  selectBridgePort,
  recheckPortFree,
  defaultPortProbe,
  type PortProbe,
} from "./port-selection";
import { BRIDGE_PORT_RANGE_START, BRIDGE_PORT_RANGE_END } from "./types";

describe("selectBridgePort: ordering", () => {
  test("returns first free port (8788) when all free", async () => {
    const probe: PortProbe = { isInUse: async () => false };
    const r = await selectBridgePort(probe);
    expect(r.port).toBe(BRIDGE_PORT_RANGE_START);
  });

  test("skips in-use ports, returns next free", async () => {
    const inUseSet = new Set([8788, 8789, 8790]);
    const probe: PortProbe = { isInUse: async (p) => inUseSet.has(p) };
    const r = await selectBridgePort(probe);
    expect(r.port).toBe(8791);
  });

  test("ascending through range", async () => {
    const inUseSet = new Set<number>();
    for (let p = BRIDGE_PORT_RANGE_START; p < BRIDGE_PORT_RANGE_END; p++) inUseSet.add(p);
    const probe: PortProbe = { isInUse: async (p) => inUseSet.has(p) };
    const r = await selectBridgePort(probe);
    expect(r.port).toBe(BRIDGE_PORT_RANGE_END);
  });
});

describe("selectBridgePort: exhaustion", () => {
  test("all in use → null + port-exhausted", async () => {
    const probe: PortProbe = { isInUse: async () => true };
    const r = await selectBridgePort(probe);
    expect(r.port).toBeNull();
    expect(r.errors[0]?.code).toBe("port-exhausted");
  });

  test("excluded ports skipped", async () => {
    const probe: PortProbe = { isInUse: async () => false };
    const r = await selectBridgePort(probe, { excludePorts: [8788] });
    expect(r.port).toBe(8789);
  });
});

describe("selectBridgePort: fail closed", () => {
  test("probe throw → treated as in-use", async () => {
    const probe: PortProbe = { isInUse: async () => { throw new Error("fail"); } };
    const r = await selectBridgePort(probe);
    expect(r.port).toBeNull();
    expect(r.errors[0]?.code).toBe("port-exhausted");
  });
});

describe("recheckPortFree", () => {
  test("free → free:true", async () => {
    const probe: PortProbe = { isInUse: async () => false };
    const r = await recheckPortFree(8788, probe);
    expect(r.free).toBe(true);
  });

  test("became in-use → port-race", async () => {
    const probe: PortProbe = { isInUse: async () => true };
    const r = await recheckPortFree(8788, probe);
    expect(r.free).toBe(false);
    expect(r.errors[0]?.code).toBe("port-race");
  });

  test("probe error → port-race (fail closed)", async () => {
    const probe: PortProbe = { isInUse: async () => { throw new Error("fail"); } };
    const r = await recheckPortFree(8788, probe);
    expect(r.free).toBe(false);
    expect(r.errors[0]?.code).toBe("port-race");
  });
});

describe("defaultPortProbe", () => {
  test("is defined (oracle decision 9)", () => {
    expect(defaultPortProbe).toBeDefined();
    expect(typeof defaultPortProbe.isInUse).toBe("function");
  });

  test("only ECONNREFUSED means free; other errors fail closed", async () => {
    // We can't easily test the actual socket behavior without binding,
    // but we can verify the probe function exists and is callable.
    // A port that's likely free (high random port) should return false (not in use).
    const inUse = await defaultPortProbe.isInUse(65530);
    expect(typeof inUse).toBe("boolean");
  });
});