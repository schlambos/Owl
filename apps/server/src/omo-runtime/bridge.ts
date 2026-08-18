/**
 * OMO telemetry bridge client (optional lane-2 endpoint).
 *
 * The bridge plugin (packages/omo-telemetry-bridge, separate lane) exposes
 * GET /telemetry on loopback. Absence is NORMAL — default config leaves the
 * bridge disabled and every consumer must tolerate connected:false.
 *
 * Slice 17 v3: when the bridge emits schema v3, the client parses the
 * identity and capabilities fields for DISPLAY ONLY. The client NEVER
 * marks v3 authoritative (verified is ALWAYS false from the direct
 * client). Only TelemetryBridgeManager identity correlation (expected
 * fingerprint + canonical origin + health instance match) may produce
 * verified=true. Legacy v1/v2 are accepted for historical/unverified
 * display only (verified=false, no identity/capabilities).
 *
 * This client is the legacy direct-fetch path for configurations without a
 * TelemetryBridgeManager. When a manager is wired, OmoRuntimeStore uses the
 * manager as the bridge authority and skips this client's fetchTelemetry.
 */

import type {
  OmoBridgeCapabilities,
  OmoBridgeIdentity,
  OmoBridgeStatus,
} from "./types";
import {
  OMO_BRIDGE_SCHEMA_VERSION_V3,
  OMO_BRIDGE_LEGACY_SCHEMA_VERSIONS,
} from "./types";
import {
  parseTelemetryPayload,
  sanitizeBridgeStores,
  type ParsedTelemetry,
} from "./v3";

export const BRIDGE_FETCH_TIMEOUT_MS = 800;

export interface OmoBridgeClientOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class OmoBridgeClient {
  private cache: OmoBridgeStatus = { connected: false };
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    /** undefined → bridge disabled entirely (default). */
    public readonly baseUrl: string | undefined,
    opts: OmoBridgeClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? BRIDGE_FETCH_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  get configured(): boolean {
    return !!this.baseUrl;
  }

  /** Cached bridge status (never throws). */
  getBridgeStores(): OmoBridgeStatus {
    return { ...this.cache };
  }

  /**
   * Fetch GET /telemetry with hard timeout; cache lastGood on success,
   * mark connected:false on any error. Never throws.
   *
   * v3: parses identity+capabilities when present for DISPLAY ONLY. The
   * client NEVER marks verified=true — only TelemetryBridgeManager may
   * produce verified=true after full identity correlation. Legacy v1/v2
   * are accepted for display only (verified=false).
   */
  async fetchTelemetry(): Promise<OmoBridgeStatus> {
    if (!this.baseUrl) {
      this.cache = { connected: false };
      return this.getBridgeStores();
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const url = `${this.baseUrl.replace(/\/$/, "")}/telemetry`;
      const res = await this.fetchImpl(url, {
        signal: ctrl.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`bridge → ${res.status}`);
      const raw = (await res.json()) as Record<string, unknown>;
      this.cache = this.buildStatus(raw);
    } catch {
      this.cache = { ...this.cache, connected: false };
    } finally {
      clearTimeout(timer);
    }
    return this.getBridgeStores();
  }

  /**
   * Build a bridge status from a raw telemetry payload. v1/v2 are accepted
   * for display only (verified=false). v3 with valid identity+capabilities
   * populates identity/capabilities for display but is STILL verified=false
   * — the client NEVER marks v3 authoritative. Only TelemetryBridgeManager
   * identity correlation may produce verified=true. A malformed v3 fails
   * closed: the client returns connected:false (it does NOT silently
   * downgrade to legacy).
   */
  private buildStatus(raw: Record<string, unknown>): OmoBridgeStatus {
    const schemaVersion =
      typeof raw["telemetrySchemaVersion"] === "number"
        ? raw["telemetrySchemaVersion"]
        : undefined;

    // Legacy v1/v2: display only.
    if (
      schemaVersion !== undefined &&
      OMO_BRIDGE_LEGACY_SCHEMA_VERSIONS.has(schemaVersion)
    ) {
      return {
        connected: true,
        lastSeenAt: this.now(),
        schemaVersion,
        stores: sanitizeBridgeStores(raw["stores"]),
        verified: false,
      };
    }

    // v3: parse identity + capabilities for DISPLAY ONLY. Malformed v3
    // fails closed. verified is ALWAYS false from the direct client.
    if (schemaVersion === OMO_BRIDGE_SCHEMA_VERSION_V3) {
      let parsed: ParsedTelemetry;
      try {
        parsed = parseTelemetryPayload(raw);
      } catch {
        // Malformed v3 → fail closed (do not silently downgrade).
        return { connected: false, verified: false };
      }
      if (parsed.isV3 && parsed.identity && parsed.capabilities) {
        const identity: OmoBridgeIdentity = parsed.identity;
        const capabilities: OmoBridgeCapabilities = parsed.capabilities;
        return {
          connected: true,
          lastSeenAt: this.now(),
          schemaVersion: OMO_BRIDGE_SCHEMA_VERSION_V3,
          stores: sanitizeBridgeStores(parsed.stores),
          identity,
          capabilities,
          ...(identity.bridgePackageVersion
            ? { bridgePackageVersion: identity.bridgePackageVersion }
            : {}),
          // NEVER verified=true from the direct client. Only the manager
          // may produce verified=true after full identity correlation.
          verified: false,
        };
      }
      // v3 payload parsed but missing identity/capabilities → fail closed.
      return { connected: false, verified: false };
    }

    // Unknown schema version → fail closed.
    return { connected: false, verified: false };
  }
}
