/**
 * Prompt-file mutation: atomic text writes + revisions.
 * Paths derived server-side from scope/preset/agent/fileType.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  AgentPromptDetail,
  ConfigMutation,
  PromptFileSimulation,
  PromptSourceState,
} from "@omo/shared";
import { createHash } from "node:crypto";
import type { ServerConfig } from "../config";
import { assertAuthorizedPath } from "../config";
import { resolveProvenance } from "../omo/provenance";
import { hashContent } from "./jsonc-edit";
import type { RevisionStore } from "./revisions";

const PROMPTS_DIR = "oh-my-opencode-slim";

function shaShort(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function safeName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

export function promptFilePath(
  cfg: ServerConfig,
  opts: {
    scope: "user" | "project";
    preset?: string;
    agent: string;
    fileType: "replacement" | "append";
  },
): string {
  if (!safeName(opts.agent)) {
    throw new Error(`Unsafe agent name: ${opts.agent}`);
  }
  if (opts.preset && !safeName(opts.preset)) {
    throw new Error(`Unsafe preset name: ${opts.preset}`);
  }
  const file = `${opts.agent}${opts.fileType === "append" ? "_append" : ""}.md`;
  const baseDir =
    opts.scope === "user"
      ? join(cfg.opencodeConfigDir, PROMPTS_DIR)
      : join(cfg.projectDirectory, ".opencode", PROMPTS_DIR);
  const dir = opts.preset ? join(baseDir, opts.preset) : baseDir;
  const path = join(dir, file);
  assertAuthorizedPath(path, cfg.authorizedRoots);
  return path;
}

export function resolvePromptComposition(
  cfg: ServerConfig,
  agent: string,
  opts: { includeText?: boolean } = {},
): AgentPromptDetail {
  const bundle = resolveProvenance({
    opencodeConfigDir: cfg.opencodeConfigDir,
    projectDirectory: cfg.projectDirectory,
    authorizedRoots: cfg.authorizedRoots,
    includePromptText: opts.includeText,
  });

  const eff = bundle.prompts[agent];
  const preset = bundle.preset;
  const raw = bundle.rawMerged as {
    presets?: Record<string, Record<string, { prompt?: string }>>;
    agents?: Record<string, { prompt?: string }>;
  };
  const inline =
    raw.agents?.[agent]?.prompt ??
    (preset ? raw.presets?.[preset]?.[agent]?.prompt : undefined);

  const dirs: Array<{
    dir: string;
    scope: "user" | "project";
    preset?: string;
  }> = [];
  const safePreset = preset && /^[a-zA-Z0-9_-]+$/.test(preset) ? preset : undefined;
  if (safePreset) {
    dirs.push({
      dir: join(cfg.projectDirectory, ".opencode", PROMPTS_DIR, safePreset),
      scope: "project",
      preset: safePreset,
    });
  }
  dirs.push({
    dir: join(cfg.projectDirectory, ".opencode", PROMPTS_DIR),
    scope: "project",
  });
  if (safePreset) {
    dirs.push({
      dir: join(cfg.opencodeConfigDir, PROMPTS_DIR, safePreset),
      scope: "user",
      preset: safePreset,
    });
  }
  dirs.push({
    dir: join(cfg.opencodeConfigDir, PROMPTS_DIR),
    scope: "user",
  });

  const sources: PromptSourceState[] = [];
  const warnings: string[] = [];

  const inlineState: PromptSourceState = {
    id: "inline",
    kind: "inline",
    scope: "user",
    agent,
    exists: typeof inline === "string",
    active: typeof inline === "string",
    selectedAsBase: typeof inline === "string",
    chars: inline?.length,
    lines: inline ? inline.split(/\r?\n/).length : undefined,
    preview: inline ? inline.slice(0, 160) : undefined,
  };
  sources.push(inlineState);

  let baseSelected: PromptSourceState | null = inlineState.exists
    ? inlineState
    : null;
  let appendSelected: PromptSourceState | null = null;

  for (const d of dirs) {
    for (const fileType of ["replacement", "append"] as const) {
      const path = promptFilePath(cfg, {
        scope: d.scope,
        preset: d.preset,
        agent,
        fileType,
      });
      let exists = false;
      let content = "";
      try {
        assertAuthorizedPath(path, cfg.authorizedRoots);
        exists = existsSync(path);
        if (exists) content = readFileSync(path, "utf-8");
      } catch {
        continue;
      }
      const st: PromptSourceState = {
        id: `${fileType}:${path}`,
        kind: fileType === "replacement" ? "replacement" : "append",
        scope: d.scope,
        preset: d.preset,
        agent,
        path,
        exists,
        active: false,
        hash: exists ? shaShort(content) : undefined,
        mtimeMs: exists ? statSync(path).mtimeMs : undefined,
        chars: exists ? content.length : undefined,
        lines: exists ? content.split(/\r?\n/).length : undefined,
        preview: exists ? content.slice(0, 160) : undefined,
      };
      if (exists) {
        if (fileType === "replacement") {
          if (!baseSelected) {
            baseSelected = st;
            st.active = true;
            st.selectedAsBase = true;
            st.reason = "First replacement file in search order";
          } else if (baseSelected.kind === "inline") {
            st.active = false;
            st.shadowedBy = baseSelected.id;
            st.reason = "Inline prompt overrides replacement file";
          } else {
            st.active = false;
            st.shadowedBy = baseSelected.id;
            st.reason = "Shadowed by higher-priority replacement";
          }
        } else {
          if (!appendSelected) {
            appendSelected = st;
            st.active = true;
            st.selectedAsAppend = true;
            st.reason = "First append file in search order";
          } else {
            st.active = false;
            st.shadowedBy = appendSelected.id;
            st.reason = "Shadowed by higher-priority append";
          }
        }
      }
      sources.push(st);
    }
  }

  let base = baseSelected;
  if (!base) {
    base = {
      id: "builtin",
      kind: "builtin",
      agent,
      exists: true,
      active: true,
      selectedAsBase: true,
      reason: "Built-in OMO agent prompt",
    };
    sources.push(base);
  } else if (base.kind === "inline") {
    base.reason = "Inline prompt (wins over replacement)";
  }

  const bundlePromptText = eff?.effectiveText;
  const effectiveText =
    bundlePromptText ??
    undefined;

  const orphanFiles: AgentPromptDetail["orphanFiles"] = [];

  if (inlineState.exists && eff) {
    // warn about replacement shadowed
    for (const s of sources) {
      if (s.kind === "replacement" && s.exists && s.shadowedBy === "inline") {
        warnings.push(
          `Replacement ${s.path} inactive: inline prompt overrides`,
        );
      }
    }
  }

  return {
    agent,
    base,
    append: appendSelected ?? undefined,
    sources,
    effectiveText,
    effectiveChars: effectiveText?.length,
    effectiveLines: effectiveText ? effectiveText.split(/\r?\n/).length : undefined,
    compositionRule:
      "resolvePrompt: base = inline ?? replacement ?? builtin; append concatenated",
    orphanFiles,
    warnings,
  };
}

export function simulatePromptFileMutation(
  cfg: ServerConfig,
  m: Extract<ConfigMutation, { kind: "prompt-file" }>,
): PromptFileSimulation {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const path = promptFilePath(cfg, m);
    const exists = existsSync(path);
    const beforeContent = exists ? readFileSync(path, "utf-8") : "";
    const currentHash = hashContent(beforeContent);

    if (
      m.expectedSourceHash &&
      m.expectedSourceHash !== currentHash &&
      (exists || m.operation === "set")
    ) {
      return {
        ok: false,
        operation: m.operation,
        targetPath: path,
        createsFile: false,
        createsDir: false,
        currentHash,
        beforeComposition: {},
        afterComposition: {},
        shadowedAfter: [],
        activatedAfter: [],
        warnings: [],
        errors: ["PROMPT FILE CHANGED EXTERNALLY"],
      };
    }

    const createsDir = !existsSync(dirname(path));
    const createsFile = !exists && m.operation === "set";
    const candidate = m.operation === "set" ? (m.content ?? "") : "";

    // Composition before
    const beforeComp = resolvePromptComposition(cfg, m.agent, {
      includeText: false,
    });
    const beforeLabels = {
      base: labelSource(beforeComp.base),
      append: labelSource(beforeComp.append),
    };

    // Simulate by writing candidate to staging and re-resolving with override
    // Simple approach: compute expected new base/append from rules
    const sourcesAfter = beforeComp.sources.map((s) => ({ ...s }));
    const thisId = `${m.fileType}:${path}`;
    const targetIdx = sourcesAfter.findIndex((s) => s.id === thisId);
    if (m.operation === "set") {
      if (targetIdx >= 0) {
        sourcesAfter[targetIdx]!.exists = true;
      } else {
        sourcesAfter.push({
          id: thisId,
          kind: m.fileType === "replacement" ? "replacement" : "append",
          scope: m.scope,
          preset: m.preset,
          agent: m.agent,
          path,
          exists: true,
          active: false,
        });
      }
    } else {
      if (targetIdx >= 0) sourcesAfter[targetIdx]!.exists = false;
    }

    // Recompute winner among existing only
    const existingByKind = (kind: "replacement" | "append") =>
      sourcesAfter.filter((s) => s.kind === kind && s.exists);
    const repl = existingByKind("replacement").sort(
      (a, b) => searchRank(a) - searchRank(b),
    );
    const apps = existingByKind("append").sort(
      (a, b) => searchRank(a) - searchRank(b),
    );

    function searchRank(s: PromptSourceState): number {
      // project preset < project generic < user preset < user generic
      if (s.scope === "project" && s.preset) return 0;
      if (s.scope === "project") return 1;
      if (s.scope === "user" && s.preset) return 2;
      return 3;
    }

    const inlineActive = beforeComp.base?.kind === "inline";
    const afterBase = inlineActive
      ? beforeComp.base
      : repl[0] ?? beforeComp.base;
    const afterAppend = apps[0];

    const shadowedAfter: string[] = [];
    const activatedAfter: string[] = [];
    if (m.operation === "set" && m.fileType === "append") {
      if (
        beforeComp.append?.path &&
        beforeComp.append.path !== path &&
        afterAppend?.path === path
      ) {
        shadowedAfter.push(beforeComp.append.path);
      }
    }
    if (m.operation === "delete" && m.fileType === "append") {
      if (beforeComp.append?.path === path && afterAppend) {
        activatedAfter.push(afterAppend.path!);
      }
    }
    if (m.operation === "set" && m.fileType === "replacement" && inlineActive) {
      warnings.push(
        "This replacement will not affect effective prompt while inline prompt is configured",
      );
    }

    const textDiff =
      m.operation === "set"
        ? [
            `--- a/${exists ? "existing" : "none"}`,
            `+++ b/${path}`,
            ...(exists ? beforeContent.split("\n").map((l) => `-${l}`) : []),
            ...candidate.split("\n").map((l) => `+${l}`),
          ].join("\n")
        : [
            `--- a/${path}`,
            `+++ b/(deleted)`,
            ...beforeContent.split("\n").map((l) => `-${l}`),
          ].join("\n");

    return {
      ok: errors.length === 0,
      operation: m.operation,
      targetPath: path,
      createsFile,
      createsDir,
      currentHash: exists ? currentHash : undefined,
      textDiff,
      beforeComposition: {
        base: beforeLabels.base ?? undefined,
        append: beforeLabels.append ?? undefined,
      },
      afterComposition: {
        base: labelSource(afterBase) ?? undefined,
        append: labelSource(afterAppend) ?? undefined,
      },
      shadowedAfter,
      activatedAfter,
      warnings,
      errors,
      contentPreview: candidate.slice(0, 4000),
    };
  } catch (e) {
    return {
      ok: false,
      operation: m.operation,
      targetPath: "",
      createsFile: false,
      createsDir: false,
      beforeComposition: {},
      afterComposition: {},
      shadowedAfter: [],
      activatedAfter: [],
      warnings,
      errors: [e instanceof Error ? e.message : String(e)],
    };
  }
}

function labelSource(s?: PromptSourceState): string | null {
  if (!s) return null;
  if (s.kind === "inline") return "inline prompt";
  if (s.kind === "builtin") return "built-in";
  return s.path ?? s.id;
}

export function applyPromptFileMutation(
  cfg: ServerConfig,
  m: Extract<ConfigMutation, { kind: "prompt-file" }>,
  revisions: RevisionStore,
): { ok: boolean; revisionId?: string; errors: string[]; simulation?: PromptFileSimulation } {
  const sim = simulatePromptFileMutation(cfg, m);
  if (!sim.ok) {
    return { ok: false, errors: sim.errors, simulation: sim };
  }
  try {
    const path = sim.targetPath;
    assertAuthorizedPath(path, cfg.authorizedRoots);
    const dir = dirname(path);
    const exists = existsSync(path);
    const beforeContent = exists ? readFileSync(path, "utf-8") : "";
    const oldHash = hashContent(beforeContent);

    if (m.expectedSourceHash && m.expectedSourceHash !== oldHash && exists) {
      return {
        ok: false,
        errors: ["PROMPT FILE CHANGED EXTERNALLY"],
        simulation: sim,
      };
    }

    if (m.operation === "set") {
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.${path.split("/").pop()}.${process.pid}.${Date.now()}.tmp`);
      assertAuthorizedPath(tmp, cfg.authorizedRoots);
      const candidate = m.content ?? "";
      writeFileSync(tmp, candidate, "utf-8");
      const check = readFileSync(tmp, "utf-8");
      if (check !== candidate) {
        try {
          unlinkSync(tmp);
        } catch {}
        return { ok: false, errors: ["temp verification failed"] };
      }
      renameSync(tmp, path);
      const finalContent = readFileSync(path, "utf-8");
      const newHash = hashContent(finalContent);

      const revId = `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      revisions.insert({
        id: revId,
        timestamp: new Date().toISOString(),
        targetPath: path,
        scope: m.scope,
        oldHash,
        newHash,
        mutationKind: exists ? "prompt-file-update" : "prompt-file-create",
        agent: m.agent,
        property: `${m.fileType}`,
        oldValue: String(beforeContent.length),
        newValue: String(finalContent.length),
        mutationJson: JSON.stringify(m),
        beforeContent,
        afterContent: finalContent,
      });
      return { ok: true, revisionId: revId, errors: [], simulation: sim };
    }

    // delete
    if (!exists) {
      return { ok: false, errors: ["Prompt file does not exist"] };
    }
    const tombstone = join(
      dir,
      `.${path.split("/").pop()}.deleted.${Date.now()}`,
    );
    assertAuthorizedPath(tombstone, cfg.authorizedRoots);
    renameSync(path, tombstone);
    const revId = `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    revisions.insert({
      id: revId,
      timestamp: new Date().toISOString(),
      targetPath: path,
      scope: m.scope,
      oldHash,
      newHash: hashContent(""),
      mutationKind: "prompt-file-delete",
      agent: m.agent,
      property: m.fileType,
      oldValue: String(beforeContent.length),
      newValue: "0",
      mutationJson: JSON.stringify(m),
      beforeContent,
      afterContent: "",
    });
    try {
      unlinkSync(tombstone);
    } catch {
      /* tombstone cleanup best-effort */
    }
    return { ok: true, revisionId: revId, errors: [], simulation: sim };
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
}
