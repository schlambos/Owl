import type {
  ConfigWriteScope,
  ResolvedProperty,
} from "@omo/shared";

export type DestKind = "preset" | "root-agent";

export interface EditState {
  path: string;
  exists: boolean;
  hash: string | null;
}

export interface EditStateResponse {
  preset?: string;
  user: EditState;
  project: EditState;
}

export type ProvenanceLookup =
  | { found: true; property: ResolvedProperty }
  | { found: false; suggestions?: string[] };

export interface ChainEntryState {
  key: number;
  mode: "catalog" | "manual";
  providerId: string;
  modelId: string;
  /** Full "provider/model" raw id; used in manual mode */
  manualId: string;
  /** Per-entry ("entry") variant */
  variant: string;
}

export interface ProbeCandidate {
  providerId: string;
  modelId: string;
}

export interface DestinationChoice {
  scope: ConfigWriteScope;
  kind: DestKind;
}

export const VARIANT_DATALIST_ID = "agent-edit-variant-suggestions";

/**
 * Write-precedence ranks mirroring load-time resolve orders
 * (user-config 10 < project-config 20 < preset 40 < root-agent 50).
 */
export const STAGE_RANK: Record<string, number> = {
  builtin: 0,
  merged: 5,
  "user-config": 10,
  "project-config": 20,
  preset: 40,
  "root-agent": 50,
  env: 60,
  "runtime-preset": 60,
};
