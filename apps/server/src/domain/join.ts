import type {
  AgentRow,
  AgentsDto,
  DesiredOmoConfig,
  EffectiveConfig,
  LiveAgent,
  LiveSession,
  LiveSnapshot,
  OverviewDto,
  SessionsDto,
} from "@omo/shared";
import { BUILTIN_OMO_AGENTS } from "@omo/shared";
import type { LoadedOmo } from "../omo/loader";
import { desiredModelForAgent } from "../omo/loader";

function liveModelString(a: LiveAgent): string | undefined {
  if (!a.model) return undefined;
  const { providerID, modelID } = a.model;
  if (!providerID && !modelID) return undefined;
  return providerID ? `${providerID}/${modelID}` : modelID;
}

function norm(s?: string): string | undefined {
  return s?.trim() || undefined;
}

function modelsDiffer(a?: string, b?: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na && !nb) return false;
  if (!na || !nb) return true;
  return na !== nb;
}

export function buildOverview(
  live: LiveSnapshot,
  omo: LoadedOmo,
  packageHint?: string,
): OverviewDto {
  // Control-plane probe sessions never count toward session totals.
  const sessions = live.sessions.filter((s) => s.controlPlaneProbe !== true);
  const flatSessions = flattenSessions(sessions).filter(
    (s) => s.controlPlaneProbe !== true,
  );
  const rootCount = sessions.length;
  const childCount = flatSessions.length - rootCount;

  return {
    controlPlane: { name: "omo-control-plane", version: "0.1.0" },
    opencode: {
      healthy: live.health.healthy,
      version: live.health.version,
      baseUrl: live.baseUrl,
      error: live.health.error,
      directory: live.path?.directory,
      configDir: live.path?.config,
    },
    connection: live.connection,
    omo: {
      packageHint,
      preset: omo.effective.preset,
      userConfigPath: omo.userConfigPath,
      projectConfigPath: omo.projectConfigPath,
      agentCount: Object.keys(omo.effective.agents).length,
      customAgentCount: Object.values(omo.effective.agents).filter(
        (a) => a.kind === "custom",
      ).length,
      presetCount: Object.keys(omo.desired.presets).length,
      warnings: omo.effective.warnings,
    },
    providers: {
      connected: live.providers.filter((p) => p.connected).map((p) => p.id),
      connectedCount: live.providers.filter((p) => p.connected).length,
      totalKnown: live.providers.length,
    },
    sessions: {
      total: flatSessions.length,
      roots: rootCount,
      children: Math.max(0, childCount),
    },
    mcp: live.mcp,
    permissions: live.permissions ?? [],
    fetchedAt: live.fetchedAt,
  };
}

export function flattenSessions(tree: LiveSession[]): LiveSession[] {
  const out: LiveSession[] = [];
  const walk = (nodes: LiveSession[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

export function buildAgentsDto(
  live: LiveSnapshot,
  omo: LoadedOmo,
): AgentsDto {
  // Control-plane probe sessions never inflate per-agent session counts.
  const flat = flattenSessions(live.sessions).filter(
    (s) => s.controlPlaneProbe !== true,
  );
  const sessionCountByAgent = new Map<string, number>();
  for (const s of flat) {
    if (!s.agent) continue;
    sessionCountByAgent.set(s.agent, (sessionCountByAgent.get(s.agent) ?? 0) + 1);
  }

  const liveByName = new Map(live.agents.map((a) => [a.name, a]));
  const names = new Set<string>([
    ...BUILTIN_OMO_AGENTS,
    ...Object.keys(omo.effective.agents),
    ...Object.keys(omo.desired.agents),
    ...live.agents.filter((a) => !a.native).map((a) => a.name),
  ]);

  const rows: AgentRow[] = [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const eff = omo.effective.agents[name];
      const liveA = liveByName.get(name);
      const desiredModel = desiredModelForAgent(
        omo.desired,
        omo.effective.preset,
        name,
      );
      const effectiveModel = eff?.modelPrimary;
      const liveModel = liveA ? liveModelString(liveA) : undefined;
      const kind =
        eff?.kind ??
        (liveA?.native
          ? "native"
          : (BUILTIN_OMO_AGENTS as readonly string[]).includes(name)
            ? "builtin"
            : liveA
              ? "custom"
              : "unknown");

      const modelProv = eff?.fieldProvenance?.model;
      const provenanceSummary = modelProv
        ? `${modelProv.winner.stage}: ${modelProv.winner.sourcePath}`
        : eff?.provenance[0]?.reason;

      return {
        name,
        kind,
        enabled: eff?.enabled ?? !liveA?.hidden,
        desiredModel,
        effectiveModel,
        effectiveVariant: eff?.variant,
        liveModel,
        liveVariant: liveA?.variant,
        liveMode: liveA?.mode,
        sessionCount: sessionCountByAgent.get(name) ?? 0,
        provenanceSummary,
        modelSourceStage: modelProv?.winner.stage,
        drift: {
          desiredVsEffective: modelsDiffer(desiredModel, effectiveModel),
          effectiveVsLive: modelsDiffer(effectiveModel, liveModel),
        },
      };
    });

  return {
    rows,
    desired: omo.desired,
    effective: omo.effective,
    liveAgents: live.agents,
  };
}

export function buildSessionsDto(
  live: LiveSnapshot,
  opts: { includeControlPlaneProbes?: boolean } = {},
): SessionsDto {
  const visible = (s: LiveSession) =>
    opts.includeControlPlaneProbes === true || s.controlPlaneProbe !== true;
  const roots = live.sessions.filter(visible);
  const flat = flattenSessions(roots)
    .filter(visible)
    .map((s) => {
      const { children: _c, ...rest } = s;
      return rest;
    });
  return {
    roots,
    flat,
    total: flat.length,
  };
}

export type { DesiredOmoConfig, EffectiveConfig };
