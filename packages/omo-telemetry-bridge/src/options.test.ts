/**
 * Tests for typed bridge activation resolution (Phase 2 ownership fix).
 *
 * REGISTRATION IS NOT ACTIVATION:
 * - No tuple fields and no env fields → inactive (activation-absent).
 * - Exactly one complete channel (tuple OR env) → active.
 * - Partial or mixed channels, invalid port/nonce, fingerprint failure →
 *   invalid (fail closed). No legacy default, no silent channel mixing.
 * - Raw nonce never appears in any result.
 */

import { describe, expect, test } from "bun:test";
import {
  resolveBridgeActivation,
  MANAGED_PORT_MAX,
  MANAGED_PORT_MIN,
  type BridgeActivationInvalidDetail,
  type BridgeActivationResult,
} from "./options";

const VALID_NONCE = "activation-nonce-0123456789";
const VALID_PORT = 8789;

async function resolve(
  options?: unknown,
  env: Record<string, string | undefined> = {},
): Promise<BridgeActivationResult> {
  return resolveBridgeActivation(options, env);
}

describe("activation-absent (inactive)", () => {
  test("no options and no env → inactive", async () => {
    const r = await resolve(undefined, {});
    expect(r).toEqual({ kind: "inactive", reason: "activation-absent" });
  });

  test("empty options object and empty env → inactive", async () => {
    const r = await resolve({}, {});
    expect(r.kind).toBe("inactive");
  });

  test("explicit empty/whitespace env values are INVALID, not inactive", async () => {
    const r = await resolve(undefined, {
      OMO_BRIDGE_PORT: "",
      OMO_BRIDGE_ACTIVATION_NONCE: "   ",
    });
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.error.reason).toBe("activation-incomplete");
    expect(r.error.field).toBe("port");
  });

  test("explicit empty env port with valid env nonce → invalid (present, not absent)", async () => {
    const r = await resolve(undefined, {
      OMO_BRIDGE_PORT: "",
      OMO_BRIDGE_ACTIVATION_NONCE: VALID_NONCE,
    });
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.error.detail).toBe("port-not-numeric");
  });

  test("explicit whitespace env nonce is hashed untrimmed, never treated absent", async () => {
    const padded = "  padded-nonce-16+chars  ";
    const r = await resolve(undefined, {
      OMO_BRIDGE_PORT: String(VALID_PORT),
      OMO_BRIDGE_ACTIVATION_NONCE: padded,
    });
    expect(r.kind).toBe("active");
    if (r.kind !== "active") return;
    // Fingerprint must cover the EXACT bytes (no trimming).
    const expected = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(padded)),
      ),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(r.activation.nonceFingerprint).toBe(expected);
  });

  test("there is no legacy default port result", async () => {
    const r = await resolve(undefined, {});
    if (r.kind === "active") throw new Error("must not activate bare");
    expect(r.kind).not.toBe("active");
  });
});

describe("complete single-channel activation (active)", () => {
  test("complete tuple channel → active with fingerprint, no raw nonce", async () => {
    const r = await resolve({ port: VALID_PORT, activationNonce: VALID_NONCE }, {});
    expect(r.kind).toBe("active");
    if (r.kind !== "active") return;
    expect(r.activation.port).toBe(VALID_PORT);
    expect(r.activation.channel).toBe("options");
    expect(r.activation.host).toBe("127.0.0.1");
    expect(r.activation.nonceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r)).not.toContain(VALID_NONCE);
  });

  test("complete env channel → active", async () => {
    const r = await resolve(undefined, {
      OMO_BRIDGE_PORT: String(VALID_PORT),
      OMO_BRIDGE_ACTIVATION_NONCE: VALID_NONCE,
    });
    expect(r.kind).toBe("active");
    if (r.kind !== "active") return;
    expect(r.activation.port).toBe(VALID_PORT);
    expect(r.activation.channel).toBe("env");
  });

  test("both channels complete → tuple wins (existing precedence)", async () => {
    const r = await resolve(
      { port: VALID_PORT, activationNonce: VALID_NONCE },
      {
        OMO_BRIDGE_PORT: "8799",
        OMO_BRIDGE_ACTIVATION_NONCE: "env-nonce-0123456789abcd",
      },
    );
    expect(r.kind).toBe("active");
    if (r.kind !== "active") return;
    expect(r.activation.channel).toBe("options");
    expect(r.activation.port).toBe(VALID_PORT);
  });

  test("managed range bounds are inclusive", async () => {
    for (const port of [MANAGED_PORT_MIN, MANAGED_PORT_MAX]) {
      const r = await resolve({ port, activationNonce: VALID_NONCE }, {});
      expect(r.kind).toBe("active");
    }
  });
});

describe("partial/mixed channels → activation-incomplete (fail closed)", () => {
  test("tuple port only → port-without-nonce", async () => {
    const r = await resolve({ port: VALID_PORT }, {});
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.error.reason).toBe("activation-incomplete");
    expect(r.error.detail).toBe("port-without-nonce");
  });

  test("tuple nonce only → nonce-without-port", async () => {
    const r = await resolve({ activationNonce: VALID_NONCE }, {});
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.error.detail).toBe("nonce-without-port");
  });

  test("env port only → port-without-nonce", async () => {
    const r = await resolve(undefined, { OMO_BRIDGE_PORT: String(VALID_PORT) });
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.error.detail).toBe("port-without-nonce");
  });

  test("env nonce only → nonce-without-port", async () => {
    const r = await resolve(undefined, { OMO_BRIDGE_ACTIVATION_NONCE: VALID_NONCE });
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.error.detail).toBe("nonce-without-port");
  });

  test("tuple port + env nonce → mixed-activation-channels", async () => {
    const r = await resolve(
      { port: VALID_PORT },
      { OMO_BRIDGE_ACTIVATION_NONCE: VALID_NONCE },
    );
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.error.detail).toBe("mixed-activation-channels");
  });

  test("env port + tuple nonce → mixed-activation-channels", async () => {
    const r = await resolve(
      { activationNonce: VALID_NONCE },
      { OMO_BRIDGE_PORT: String(VALID_PORT) },
    );
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.error.detail).toBe("mixed-activation-channels");
  });
});

describe("invalid values → activation-incomplete (fail closed, redacted)", () => {
  const cases: Array<
    [string, unknown, BridgeActivationInvalidDetail, "port" | "activationNonce"]
  > = [
    ["port below range", { port: 8787, activationNonce: VALID_NONCE }, "port-out-of-range", "port"],
    ["port above range", { port: 8804, activationNonce: VALID_NONCE }, "port-out-of-range", "port"],
    ["port non-integer", { port: 8788.5, activationNonce: VALID_NONCE }, "port-not-integer", "port"],
    ["port non-numeric", { port: "abc", activationNonce: VALID_NONCE }, "port-not-numeric", "port"],
    ["port wrong type", { port: true, activationNonce: VALID_NONCE }, "port-wrong-type", "port"],
    ["nonce too short", { port: VALID_PORT, activationNonce: "short" }, "nonce-too-short", "activationNonce"],
    ["nonce too long", { port: VALID_PORT, activationNonce: "x".repeat(257) }, "nonce-too-long", "activationNonce"],
    ["nonce wrong type", { port: VALID_PORT, activationNonce: 42 }, "nonce-wrong-type", "activationNonce"],
    ["nonce empty", { port: VALID_PORT, activationNonce: "" }, "nonce-empty", "activationNonce"],
  ];
  for (const [name, opts, detail, field] of cases) {
    test(`${name} → ${detail}`, async () => {
      const r = await resolve(opts, {});
      expect(r.kind).toBe("invalid");
      if (r.kind !== "invalid") return;
      expect(r.error.reason).toBe("activation-incomplete");
      expect(r.error.detail).toBe(detail);
      expect(r.error.field).toBe(field);
    });
  }

  test("invalid explicit tuple fails closed even when env channel is complete", async () => {
    const r = await resolve(
      { port: 1, activationNonce: VALID_NONCE },
      { OMO_BRIDGE_PORT: String(VALID_PORT), OMO_BRIDGE_ACTIVATION_NONCE: VALID_NONCE },
    );
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.error.detail).toBe("port-out-of-range");
  });

  test("error messages contain no raw invalid values", async () => {
    const secretish = "raw-value-sentinel-nonce-abcdef";
    const r = await resolve({ port: VALID_PORT, activationNonce: secretish }, {});
    // A too-short nonce is invalid; its raw value must not appear anywhere.
    const bad = await resolve(
      { port: VALID_PORT, activationNonce: "raw-sentinel" },
      {},
    );
    expect(bad.kind).toBe("invalid");
    if (bad.kind === "invalid") {
      expect(bad.error.detail).toBe("nonce-too-short");
      expect(JSON.stringify(bad.error)).not.toContain("raw-sentinel");
    }
    expect(JSON.stringify(r)).not.toContain(secretish);
  });
});

describe("fingerprint-unavailable", () => {
  test("digest failure → typed fingerprint-unavailable", async () => {
    const r = await resolveBridgeActivation(
      { port: VALID_PORT, activationNonce: VALID_NONCE },
      {},
      async () => undefined,
    );
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.error.reason).toBe("fingerprint-unavailable");
    expect(r.error.detail).toBe("fingerprint-failed");
  });

  test("digest throw → typed fingerprint-unavailable, no raw output", async () => {
    const r = await resolveBridgeActivation(
      { port: VALID_PORT, activationNonce: VALID_NONCE },
      {},
      async () => {
        throw new Error(`boom ${VALID_NONCE}`);
      },
    );
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.error.detail).toBe("fingerprint-failed");
    expect(JSON.stringify(r)).not.toContain(VALID_NONCE);
  });

  test("malformed digest output → fingerprint-malformed", async () => {
    const r = await resolveBridgeActivation(
      { port: VALID_PORT, activationNonce: VALID_NONCE },
      {},
      async () => "not-hex-output",
    );
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.error.detail).toBe("fingerprint-malformed");
  });

  test("equal-to-raw digest output → fingerprint-malformed (raw never propagates)", async () => {
    const hexNonce = "a".repeat(64);
    const r = await resolveBridgeActivation(
      { port: VALID_PORT, activationNonce: hexNonce },
      {},
      async (nonce) => nonce, // broken seam returns the raw nonce
    );
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.error.detail).toBe("fingerprint-malformed");
    // The result must not carry the raw value as a fingerprint.
    expect(JSON.stringify(r)).not.toContain(`"nonceFingerprint":"${hexNonce}"`);
  });
});

describe("whitespace-only nonce (Gate 2 attempt 2)", () => {
  test("valid port + 16+ spaces nonce → invalid, zero bind path", async () => {
    const r = await resolveBridgeActivation(undefined, {
      OMO_BRIDGE_PORT: "8790",
      OMO_BRIDGE_ACTIVATION_NONCE: " ".repeat(20),
    });
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.error.reason).toBe("activation-incomplete");
    expect(r.error.detail).toBe("nonce-empty");
    expect(r.error.field).toBe("activationNonce");
  });

  test("whitespace-only tuple nonce → nonce-empty invalid", async () => {
    const r = await resolveBridgeActivation(
      { port: 8790, activationNonce: " ".repeat(16) },
      {},
    );
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(r.error.detail).toBe("nonce-empty");
  });
});
