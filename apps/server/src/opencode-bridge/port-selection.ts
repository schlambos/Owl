/**
 * Slice 17 hardened — Passive deterministic port selection.
 *
 * Oracle decision 9: use defaultPortProbe when no probe injected.
 * Treat only ECONNREFUSED as free; other socket errors fail closed.
 */

import { createConnection } from "node:net";
import type { BridgeError, PortSelectionResult } from "./types";
import { BRIDGE_PORT_RANGE_START, BRIDGE_PORT_RANGE_END } from "./types";

export interface PortProbe {
  isInUse(port: number): Promise<boolean>;
}

/**
 * Default TCP connect probe (loopback only, 250ms timeout).
 * Oracle decision 9: only ECONNREFUSED means free; other errors fail closed.
 */
export const defaultPortProbe: PortProbe = {
  async isInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const socket = createConnection(
        { host: "127.0.0.1", port, timeout: 250 },
        () => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(true); // connection succeeded → in use
        },
      );
      socket.on("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        // Only ECONNREFUSED means the port is free.
        // All other errors (timeout, EACCES, etc.) fail closed → in use.
        if (err.code === "ECONNREFUSED") {
          resolve(false);
        } else {
          resolve(true);
        }
      });
      socket.on("timeout", () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(true); // timeout → ambiguous → fail closed
      });
    });
  },
};

export async function selectBridgePort(
  probe: PortProbe = defaultPortProbe,
  opts?: { excludePorts?: number[] },
): Promise<PortSelectionResult> {
  const errors: BridgeError[] = [];
  const probed: number[] = [];
  const exclude = new Set(opts?.excludePorts ?? []);

  for (let port = BRIDGE_PORT_RANGE_START; port <= BRIDGE_PORT_RANGE_END; port++) {
    if (exclude.has(port)) continue;
    probed.push(port);
    let inUse: boolean;
    try {
      inUse = await probe.isInUse(port);
    } catch {
      inUse = true; // fail closed
    }
    if (!inUse) {
      return { port, errors: [], probed };
    }
  }

  errors.push({
    code: "port-exhausted",
    message: `All bridge ports ${BRIDGE_PORT_RANGE_START}-${BRIDGE_PORT_RANGE_END} are in use or excluded.`,
  });
  return { port: null, errors, probed };
}

export async function recheckPortFree(
  port: number,
  probe: PortProbe = defaultPortProbe,
): Promise<{ free: boolean; errors: BridgeError[] }> {
  try {
    const inUse = await probe.isInUse(port);
    if (inUse) {
      return {
        free: false,
        errors: [{ code: "port-race", message: `Port ${port} became in-use. Re-preview required.` }],
      };
    }
    return { free: true, errors: [] };
  } catch {
    return {
      free: false,
      errors: [{ code: "port-race", message: `Port ${port} probe failed during recheck.` }],
    };
  }
}