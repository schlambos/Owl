/**
 * Catalog + manage composition for OpenCode provider management.
 *
 * Catalog: slim GET /provider all[] / GET /config/providers through the
 * EXISTING normalizeProvider stripping (client.providers()), mapped to the
 * strict DTO allowlist { id, name?, source, modelCount?, connected }.
 * Never key, env, options, models map, or headers.
 *
 * Manage: filesystem Desired (user-level config-dir) + secret-free
 * Effective overlay + Live join. Project-root configs are read for overlay
 * flags ONLY (same allowlist) and are never written. Raw GET /config and
 * Provider.key are never touched.
 */

import type {
  OpenCodeProviderCatalogDto,
  OpenCodeProviderCatalogEntry,
  OpenCodeProviderDesiredEntry,
  OpenCodeProviderLiveOverlay,
  OpenCodeProviderSourceKind,
  OpenCodeProvidersManageDto,
} from "@omo/shared";
import { resolveSourceCandidates } from "../opencode-bridge/resolver";
import { extractDesiredProviderState, providerIdsOfConfig } from "../opencode-config/sanitizer";
import type { ClientProvider, LiveProviderJoin } from "./types";

export interface CompositionPaths {
  opencodeConfigDir: string;
  projectDirectory: string;
  owlInstallDirectory: string;
  authorizedRoots: string[];
}

const SOURCE_KINDS: readonly OpenCodeProviderSourceKind[] = ["env", "config", "custom", "api"];

function sourceKind(v: unknown): OpenCodeProviderSourceKind {
  return SOURCE_KINDS.includes(v as OpenCodeProviderSourceKind)
    ? (v as OpenCodeProviderSourceKind)
    : "config";
}

// ── Live join (best-effort, secret-free) ────────────────────────────────

async function fetchLiveJoin(getClient: ClientProvider): Promise<LiveProviderJoin | undefined> {
  try {
    const client = getClient();
    const { providers, connected } = await client.providers();
    const authority = client.getProviderAuthority();
    return { providers, connected, defaults: authority?.defaults ?? {} };
  } catch {
    return undefined;
  }
}

// ── Catalog ────────────────────────────────────────────────────────────

export async function buildCatalog(
  getClient: ClientProvider,
): Promise<OpenCodeProviderCatalogDto> {
  const live = await fetchLiveJoin(getClient);
  if (!live) {
    return {
      providers: [],
      connected: [],
      fetchedAt: new Date().toISOString(),
      issue: "Live provider catalog unavailable (OpenCode backend not active).",
    };
  }
  const connectedSet = new Set(live.connected);
  const providers: OpenCodeProviderCatalogEntry[] = live.providers.map((p) => ({
    id: p.id,
    name: p.name !== p.id ? p.name : undefined,
    source: sourceKind(p.source),
    modelCount: p.modelCount,
    connected: connectedSet.has(p.id) || p.connected,
  }));
  return {
    providers,
    connected: [...connectedSet],
    fetchedAt: new Date().toISOString(),
  };
}

/** Slim catalog id set (used for add-custom collision rejection). */
export async function slimCatalogIds(getClient: ClientProvider): Promise<Set<string>> {
  const catalog = await buildCatalog(getClient);
  return new Set(catalog.providers.map((p) => p.id));
}

// ── Manage ─────────────────────────────────────────────────────────────

export async function buildManage(
  paths: CompositionPaths,
  getClient: ClientProvider,
): Promise<OpenCodeProvidersManageDto> {
  const survey = resolveSourceCandidates(paths);

  // Filesystem Desired: user-level config-dir candidates only.
  const configDirCand = survey.candidates.find((c) => c.kind === "opencode-config-dir");
  const projectCand = survey.candidates.find((c) => c.kind === "project-root");

  // Project-masked overlay flags: project config is READ for flags only
  // (same allowlist via providerIdsOfConfig) and is NEVER a write target.
  const projectIds = projectCand ? providerIdsOfConfig(projectCand.text) : [];
  const projectMaskedSet = new Set(projectIds);

  let desired: OpenCodeProviderDesiredEntry[] = [];
  if (configDirCand) {
    desired = extractDesiredProviderState(configDirCand.text, projectMaskedSet).providers;
  }

  // Live join: normalized /config/providers + cached /provider connected.
  const live = await fetchLiveJoin(getClient);
  const connectedSet = new Set(live?.connected ?? []);
  const liveOverlay: OpenCodeProviderLiveOverlay[] = (live?.providers ?? []).map((p) => ({
    id: p.id,
    present: true,
    name: p.name !== p.id ? p.name : undefined,
    modelCount: p.modelCount,
    connected: connectedSet.has(p.id) || p.connected,
    source: sourceKind(p.source),
  }));

  // Write-target descriptor (filesystem view; authoritative gate per write).
  let writeTarget: OpenCodeProvidersManageDto["writeTarget"];
  if (configDirCand) {
    writeTarget = {
      kind: "opencode-config-dir",
      path: configDirCand.path,
      sourceHash: configDirCand.hash,
    };
  } else if (projectCand) {
    writeTarget = {
      kind: "project-masked",
      reason: "Project-root config masks user-level provider writes.",
    };
  } else if (survey.errors.length > 0) {
    writeTarget = { kind: "blocked", reason: "Candidate errors block write targeting." };
  } else {
    writeTarget = {
      kind: "create",
      path: `${paths.opencodeConfigDir.replace(/\/$/, "")}/opencode.jsonc`,
    };
  }

  return {
    desired,
    live: liveOverlay,
    projectMaskedProviders: projectIds,
    writeTarget,
    fetchedAt: new Date().toISOString(),
    ...(live === undefined
      ? { liveIssue: "Live provider overlay unavailable (OpenCode backend not active)." }
      : {}),
  };
}
