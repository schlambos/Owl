/**
 * OpenCode provider-management config writer.
 *
 * Write-target gate (exact, ordered — no other branch):
 *  1. resolveAuthorizedCandidate runs first; a dirty bridge reconciliation
 *     also refuses. (Reconciliation-dirty blocks owned restarts; provider
 *     writes ride the same lifecycle boundary.)
 *  2. proven + candidate.kind === "opencode-config-dir" → that file is the
 *     ONLY write target (expectedSourceHash = hashContent of that file).
 *  3. proven + candidate.kind === "project-root" → REFUSE. Project-root is
 *     never written and a competing config-dir file is never created;
 *     surface project-masked / user-level-unavailable.
 *  4. unproven/ambiguous/dirty → REFUSE, except (5).
 *  5. First create: only when resolveSourceCandidates has NO config-dir
 *     AND NO project-root candidates (and no candidate errors) is
 *     `{OPENCODE_CONFIG_DIR}/opencode.jsonc` created as the target; the
 *     first create does not require `proven`.
 *
 * Apply ordering: gate → in-process mutex → hash check (mismatch = 409 /
 * hash-conflict, NO write) → path-edit → atomic write (same-dir temp →
 * reread → renameSync) → revision. Unknown keys, comments, and the plugin
 * array are preserved by the jsonc-parser edit producers.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { OpenCodeProviderMutation } from "@omo/shared";
import {
  emptyConfigDocument,
  hashContent,
  parseConfigText,
  unifiedDiff,
} from "../cfgwrite/jsonc-edit";
import {
  resolveAuthorizedCandidate,
  resolveSourceCandidates,
} from "../opencode-bridge/resolver";
import type { EffectivePluginView } from "../opencode-bridge/types";
import { withOpenCodeConfigLock } from "./lock";
import { firstCreateConfigPath } from "./paths";
import { applyProviderMutationText, mutationProviderId } from "./mutations";
import type { ProviderRevisionStore } from "./revisions";

export interface ProviderWriteError {
  code: string;
  message: string;
}

export type WriteTargetResult =
  | {
      ok: true;
      kind: "opencode-config-dir";
      targetPath: string;
      baselineText: string;
      baselineHash: string;
    }
  | { ok: true; kind: "create"; targetPath: string; baselineText: string; baselineHash: string }
  | { ok: false; errors: ProviderWriteError[] };

export interface WriterOptions {
  opencodeConfigDir: string;
  projectDirectory: string;
  owlInstallDirectory: string;
  authorizedRoots: string[];
  revisions: ProviderRevisionStore;
  /**
   * Trusted effective-view provider over the CURRENT canonical client.
   * External callers cannot forge it.
   */
  effectiveViewProvider: () => Promise<EffectivePluginView>;
  /**
   * Lifecycle bridge-reconciliation-clean hook. When it returns false the
   * lifecycle is `bridge-reconciliation-dirty` and ALL writes refuse.
   */
  isReconciliationClean?: () => boolean;
}

export interface SimulateRequest {
  mutation: OpenCodeProviderMutation;
  slimCatalogIds?: ReadonlySet<string>;
}

export interface SimulateResult {
  ok: boolean;
  diff?: string;
  targetPath?: string;
  baselineHash?: string;
  proposedHash?: string;
  errors: ProviderWriteError[];
}

export interface ApplyRequest {
  mutation: OpenCodeProviderMutation;
  expectedSourceHash?: string;
  slimCatalogIds?: ReadonlySet<string>;
}

export interface ApplyResult {
  ok: boolean;
  /** HTTP status hint: 409 on hash-conflict, 400 otherwise. */
  status: number;
  revisionId?: string;
  targetPath?: string;
  baselineHash?: string;
  postWriteHash?: string;
  errors: ProviderWriteError[];
}

export class OpenCodeConfigWriter {
  constructor(private readonly opts: WriterOptions) {}

  // ── Write-target gate (exact, ordered) ────────────────────────────────

  private async resolveWriteTarget(): Promise<WriteTargetResult> {
    // (1) Dirty bridge reconciliation refuses everything.
    if (this.opts.isReconciliationClean && !this.opts.isReconciliationClean()) {
      return {
        ok: false,
        errors: [
          {
            code: "bridge-reconciliation-dirty",
            message: "Bridge reconciliation is dirty; provider writes refuse until conflicts are resolved.",
          },
        ],
      };
    }

    let view: EffectivePluginView;
    try {
      view = await this.opts.effectiveViewProvider();
    } catch {
      view = { entries: [], unavailable: true, invalid: true };
    }

    const resolverOpts = {
      opencodeConfigDir: this.opts.opencodeConfigDir,
      projectDirectory: this.opts.projectDirectory,
      owlInstallDirectory: this.opts.owlInstallDirectory,
      authorizedRoots: this.opts.authorizedRoots,
    };

    const resolved = resolveAuthorizedCandidate(resolverOpts, view);

    if (resolved.status === "proven") {
      // (2) Only a proven config-dir candidate may be written.
      if (resolved.candidate.kind === "opencode-config-dir") {
        return {
          ok: true,
          kind: "opencode-config-dir",
          targetPath: resolved.candidate.path,
          baselineText: resolved.candidate.text,
          baselineHash: resolved.candidate.hash,
        };
      }
      // (3) Proven project-root: never write, never mask with a competing
      //     config-dir file.
      return {
        ok: false,
        errors: [
          {
            code: "project-masked",
            message:
              "The effective OpenCode config resolves to the project root; user-level provider writes are masked and refused.",
          },
        ],
      };
    }

    // (4)/(5) Unproven/ambiguous/dirty: refuse, EXCEPT first create when no
    // config-dir and no project-root candidates exist at all.
    const survey = resolveSourceCandidates(resolverOpts);
    if (survey.errors.length === 0 && survey.candidates.length === 0) {
      return {
        ok: true,
        kind: "create",
        targetPath: firstCreateConfigPath(this.opts.opencodeConfigDir),
        baselineText: "",
        baselineHash: hashContent(""),
      };
    }
    return {
      ok: false,
      errors: resolved.errors.map((e) => ({ code: e.code, message: e.message })),
    };
  }

  /**
   * Read-only write-target descriptor for the manage DTO. Filesystem-view
   * only (no effective-view call): the authoritative gate runs per write.
   */
  describeWriteTarget(): { kind: string; path?: string; sourceHash?: string; reason?: string } {
    const survey = resolveSourceCandidates({
      opencodeConfigDir: this.opts.opencodeConfigDir,
      projectDirectory: this.opts.projectDirectory,
      owlInstallDirectory: this.opts.owlInstallDirectory,
      authorizedRoots: this.opts.authorizedRoots,
    });
    const configDir = survey.candidates.find((c) => c.kind === "opencode-config-dir");
    if (configDir) {
      return { kind: "opencode-config-dir", path: configDir.path, sourceHash: configDir.hash };
    }
    const projectRoot = survey.candidates.find((c) => c.kind === "project-root");
    if (projectRoot) {
      return {
        kind: "project-masked",
        reason: "Project-root config masks user-level provider writes.",
      };
    }
    if (survey.errors.length > 0) {
      return { kind: "blocked", reason: "Candidate errors block write targeting." };
    }
    return { kind: "create", path: firstCreateConfigPath(this.opts.opencodeConfigDir) };
  }

  // ── Simulate (sanitized preview only) ────────────────────────────────

  async simulate(req: SimulateRequest): Promise<SimulateResult> {
    const target = await this.resolveWriteTarget();
    if (!target.ok) return { ok: false, errors: target.errors };

    // For create, the mutation produces against an empty document.
    const baseline = target.kind === "create" ? emptyConfigDocument("jsonc") : target.baselineText;
    const mutated = applyProviderMutationText(baseline, req.mutation, req.slimCatalogIds ?? new Set());
    if (!mutated.ok) return { ok: false, errors: [mutated.error] };

    return {
      ok: true,
      diff: unifiedDiff(target.baselineText, mutated.text, basename(target.targetPath)),
      targetPath: target.targetPath,
      baselineHash: target.baselineHash,
      proposedHash: hashContent(mutated.text),
      errors: [],
    };
  }

  // ── Apply (gate → mutex → hash check → path-edit → atomic write) ─────

  async apply(req: ApplyRequest): Promise<ApplyResult> {
    return withOpenCodeConfigLock(async () => {
      const target = await this.resolveWriteTarget();
      if (!target.ok) {
        return { ok: false, status: 400, errors: target.errors };
      }

      // Hash check (mismatch → 409, no write). For create targets the
      // file must still be absent at apply time.
      if (target.kind === "create") {
        if (req.expectedSourceHash !== undefined && req.expectedSourceHash !== target.baselineHash) {
          return {
            ok: false,
            status: 409,
            errors: [{ code: "hash-conflict", message: "Expected source hash does not match the create target." }],
          };
        }
        if (existsSync(target.targetPath)) {
          return {
            ok: false,
            status: 409,
            errors: [{ code: "hash-conflict", message: "A config file appeared between simulate and apply. Re-simulate." }],
          };
        }
      } else {
        const expected = req.expectedSourceHash ?? target.baselineHash;
        if (expected !== target.baselineHash) {
          return {
            ok: false,
            status: 409,
            errors: [{ code: "hash-conflict", message: "Source hash changed since simulate. Re-simulate." }],
          };
        }
      }

      const baseline = target.kind === "create" ? emptyConfigDocument("jsonc") : target.baselineText;
      const mutated = applyProviderMutationText(baseline, req.mutation, req.slimCatalogIds ?? new Set());
      if (!mutated.ok) {
        return { ok: false, status: 400, errors: [mutated.error] };
      }
      try {
        parseConfigText(mutated.text);
      } catch {
        return {
          ok: false,
          status: 400,
          errors: [{ code: "plugin-shape-unsupported", message: "Mutated config text does not parse." }],
        };
      }

      const write = this.atomicWrite(target.targetPath, mutated.text, target);
      if (!write.ok) {
        return { ok: false, status: 409, errors: write.errors };
      }

      const postWriteHash = hashContent(mutated.text);
      const revisionId = `prev_${randomBytes(12).toString("hex")}`;
      this.opts.revisions.insertRevision({
        id: revisionId,
        timestamp: new Date().toISOString(),
        targetPath: target.targetPath,
        operation: String(mutated.summary.operation) as
          | "provider-added"
          | "provider-blacklist"
          | "provider-enablement",
        providerId: mutationProviderId(req.mutation),
        baselineHash: target.baselineHash,
        postWriteHash,
        summary: JSON.stringify(mutated.summary),
      });

      return {
        ok: true,
        status: 200,
        revisionId,
        targetPath: target.targetPath,
        baselineHash: target.baselineHash,
        postWriteHash,
        errors: [],
      };
    });
  }

  // ── Atomic write: same-dir temp → reread → renameSync ────────────────

  private atomicWrite(
    targetPath: string,
    content: string,
    target: { kind: "opencode-config-dir" | "create"; baselineHash: string },
  ): { ok: true } | { ok: false; errors: ProviderWriteError[] } {
    const dir = dirname(targetPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* may exist */
    }
    const tmp = join(dir, `.${basename(targetPath)}.${randomBytes(8).toString("hex")}.tmp`);

    let fd: number | null = null;
    try {
      fd = openSync(tmp, "wx");
      writeFileSync(fd, content, "utf-8");
      let mode = 0o600;
      try {
        if (existsSync(targetPath)) {
          mode = Math.min(lstatSync(targetPath).mode & 0o777, 0o600);
        }
      } catch {
        /* default 0600 */
      }
      chmodSync(tmp, mode);
      fsyncSync(fd);
    } catch {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* */
      }
      return { ok: false, errors: [{ code: "source-unproven", message: "Temp write failed." }] };
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* */
        }
      }
    }

    // Reread parity.
    try {
      if (readFileSync(tmp, "utf-8") !== content) {
        throw new Error("parity");
      }
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        /* */
      }
      return { ok: false, errors: [{ code: "source-unproven", message: "Temp reread/parity failed." }] };
    }

    // Pre-rename baseline re-verification (no TOCTOU inside the mutex).
    try {
      if (target.kind === "create") {
        if (existsSync(targetPath)) throw new Error("appeared");
      } else {
        const current = readFileSync(targetPath, "utf-8");
        if (hashContent(current) !== target.baselineHash) throw new Error("changed");
      }
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        /* */
      }
      return {
        ok: false,
        errors: [{ code: "hash-conflict", message: "Target changed immediately before rename." }],
      };
    }

    try {
      renameSync(tmp, targetPath);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        /* */
      }
      return { ok: false, errors: [{ code: "source-unproven", message: "Atomic rename failed." }] };
    }

    let dirFd: number | null = null;
    try {
      dirFd = openSync(dir, "r");
      fsyncSync(dirFd);
    } catch {
      return { ok: false, errors: [{ code: "source-unproven", message: "Directory sync failed after rename." }] };
    } finally {
      if (dirFd !== null) {
        try {
          closeSync(dirFd);
        } catch {
          /* */
        }
      }
    }
    return { ok: true };
  }
}
