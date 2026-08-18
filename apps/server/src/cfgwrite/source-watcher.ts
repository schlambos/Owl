/**
 * Authorized OMO source + installed-schema watcher (Slice 18 D3).
 *
 * Roots only:
 * 1. cfg.opencodeConfigDir — exact OMO JSON/JSONC basename
 * 2. cfg.projectDirectory — only `.opencode` creation
 * 3. join(project, ".opencode") when present — exact OMO basename
 * 4. installed schema file + sibling package manifest
 *
 * Coalesces 100 ms and emits typed `config.sources.changed`. Matching
 * post-Apply fingerprints are marked `ownApply` and must not false-stale.
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import type {
  ConfigSourcesChangedEvent,
  RawOmoSourceId,
  SourceFingerprint,
} from "@omo/shared";
import type { ServerConfig } from "../config";
import {
  INSTALLED_PACKAGE_NAME,
  INSTALLED_SCHEMA_BASENAME,
  loadInstalledSchema,
} from "../omo-schema/authority";
import { schemaContextFor } from "../omo-schema/validator";
import { currentFingerprints, schemaIdentityFor } from "./raw";

const OMO_BASENAMES = new Set([
  "oh-my-opencode-slim.json",
  "oh-my-opencode-slim.jsonc",
]);

export const SOURCE_WATCH_COALESCE_MS = 100;

export interface SourceWatcherDeps {
  cfg: ServerConfig;
  coalesceMs?: number;
  now?: () => Date;
  emit: (event: ConfigSourcesChangedEvent) => void;
}

export interface SourceWatcher {
  start(): void;
  stop(): void;
  generation(): number;
  noteOwnApply(sourceId: RawOmoSourceId, sha256: string | null): void;
  snapshot(): ConfigSourcesChangedEvent;
}

export function createSourceWatcher(deps: SourceWatcherDeps): SourceWatcher {
  const coalesceMs = deps.coalesceMs ?? SOURCE_WATCH_COALESCE_MS;
  const watchers: FSWatcher[] = [];
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let lastSchemaKey: string | undefined;
  let lastSources: Record<RawOmoSourceId, SourceFingerprint> | undefined;
  const ownApplies = new Map<RawOmoSourceId, string | null>();
  let watchingProjectOpencode = false;

  const fingerprintChanged = (
    before: SourceFingerprint | undefined,
    after: SourceFingerprint,
  ): boolean => {
    if (!before) return false;
    return (
      before.exists !== after.exists ||
      before.sha256 !== after.sha256 ||
      before.format !== after.format
    );
  };

  const schemaPaths = (): string[] => {
    const snap = loadInstalledSchema(schemaContextFor(deps.cfg), deps.cfg);
    const out: string[] = [];
    if (snap.available) {
      out.push(snap.schemaPath, snap.packageManifestPath);
    } else {
      const pkgDir = join(
        deps.cfg.opencodeConfigDir,
        "node_modules",
        INSTALLED_PACKAGE_NAME,
      );
      out.push(join(pkgDir, INSTALLED_SCHEMA_BASENAME), join(pkgDir, "package.json"));
    }
    return out;
  };

  const interesting = (dir: string, filename: string | null): boolean => {
    if (!filename) return true;
    const name = basename(filename);
    if (dir === deps.cfg.projectDirectory) return name === ".opencode";
    if (OMO_BASENAMES.has(name)) return true;
    if (name === INSTALLED_SCHEMA_BASENAME || name === "package.json") return true;
    return false;
  };

  const snapshot = (): ConfigSourcesChangedEvent => {
    const sources = currentFingerprints(deps.cfg, generation);
    const schema = schemaIdentityFor(deps.cfg);
    const schemaChanged = lastSchemaKey !== undefined && lastSchemaKey !== schema.cacheKey;
    const ownApplyBySource: Record<RawOmoSourceId, boolean> = {
      "user-omo": false,
      "project-omo": false,
    };
    let unmatchedExternal = false;
    for (const id of ["user-omo", "project-omo"] as const) {
      const expected = ownApplies.get(id);
      if (expected !== undefined && sources[id].sha256 === expected) {
        ownApplyBySource[id] = true;
        ownApplies.delete(id);
        continue;
      }
      if (fingerprintChanged(lastSources?.[id], sources[id])) {
        unmatchedExternal = true;
      }
    }
    const anyOwn = ownApplyBySource["user-omo"] || ownApplyBySource["project-omo"];
    return {
      type: "config.sources.changed",
      at: (deps.now?.() ?? new Date()).toISOString(),
      generation,
      sources,
      schema: { ...schema, changed: schemaChanged },
      ownApply: anyOwn && !unmatchedExternal,
      ownApplyBySource,
    };
  };

  const emitNow = (): void => {
    generation += 1;
    const event = snapshot();
    lastSchemaKey = event.schema.cacheKey;
    lastSources = event.sources;
    deps.emit(event);
    attachProjectOpencodeIfNeeded();
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      emitNow();
    }, coalesceMs);
  };

  const watchDir = (dir: string, filterProjectCreate = false): void => {
    if (!existsSync(dir)) return;
    try {
      const w = watch(dir, (_event, filename) => {
        const name = filename != null ? String(filename) : null;
        if (filterProjectCreate && name !== ".opencode") return;
        if (!interesting(dir, name)) return;
        schedule();
      });
      watchers.push(w);
    } catch {
      /* some FS cannot watch */
    }
  };

  const attachProjectOpencodeIfNeeded = (): void => {
    if (watchingProjectOpencode) return;
    const dir = join(deps.cfg.projectDirectory, ".opencode");
    if (!existsSync(dir)) return;
    watchingProjectOpencode = true;
    watchDir(dir);
  };

  return {
    start() {
      if (started) return;
      started = true;
      lastSchemaKey = schemaIdentityFor(deps.cfg).cacheKey;
      lastSources = currentFingerprints(deps.cfg, generation);
      watchDir(deps.cfg.opencodeConfigDir);
      watchDir(deps.cfg.projectDirectory, true);
      attachProjectOpencodeIfNeeded();
      for (const p of schemaPaths()) {
        const dir = p.endsWith(".json") ? p.slice(0, p.lastIndexOf("/")) : p;
        if (existsSync(dir)) watchDir(dir);
      }
    },
    stop() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* */
        }
      }
      watchers.length = 0;
      started = false;
    },
    generation: () => generation,
    noteOwnApply(sourceId, sha256) {
      ownApplies.set(sourceId, sha256);
    },
    snapshot,
  };
}
