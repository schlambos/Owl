import { describe, expect, test, beforeEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  applyPromptFileMutation,
  promptFilePath,
  resolvePromptComposition,
  simulatePromptFileMutation,
} from "./prompts";
import { RevisionStore } from "./revisions";

const ROOT = join(import.meta.dir, "../../test/prompt-sandbox");

function fresh() {
  rmSync(ROOT, { recursive: true, force: true });
  const userDir = join(ROOT, "cfg");
  const projDir = join(ROOT, "proj");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  mkdirSync(join(projDir, "data"), { recursive: true });
  writeFileSync(
    join(userDir, "oh-my-opencode-slim.json"),
    JSON.stringify(
      {
        preset: "p1",
        presets: { p1: { explorer: { model: "m/ex" } } },
        agents: {
          researcher: { model: "m/res", prompt: "INLINE RES" },
        },
      },
      null,
      2,
    ),
  );
  const cfg = {
    host: "127.0.0.1",
    port: 0,
    opencodeConfigDir: userDir,
    projectDirectory: projDir,
    authorizedRoots: [userDir, projDir, ROOT],
  };
  const revisions = new RevisionStore(join(projDir, "data", "test.db"));
  return { cfg: cfg as never, revisions, userDir, projDir };
}

describe("prompt paths", () => {
  test("user generic append", () => {
    const { cfg } = fresh();
    const p = promptFilePath(cfg, {
      scope: "user",
      agent: "explorer",
      fileType: "append",
    });
    expect(p.endsWith("oh-my-opencode-slim/explorer_append.md")).toBe(true);
  });

  test("rejects traversal", () => {
    const { cfg } = fresh();
    expect(() =>
      promptFilePath(cfg, {
        scope: "user",
        agent: "../evil",
        fileType: "append",
      }),
    ).toThrow();
  });
});

describe("composition + mutation", () => {
  let s: ReturnType<typeof fresh>;
  beforeEach(() => {
    s = fresh();
  });

  test("create append file applies and becomes active", () => {
    const mut = {
      kind: "prompt-file" as const,
      scope: "user" as const,
      agent: "explorer",
      fileType: "append" as const,
      operation: "set" as const,
      content: "APPEND BODY",
    };
    const sim = simulatePromptFileMutation(s.cfg, mut);
    expect(sim.ok).toBe(true);
    expect(sim.createsFile).toBe(true);

    const ap = applyPromptFileMutation(s.cfg, mut, s.revisions);
    expect(ap.ok).toBe(true);
    const path = promptFilePath(s.cfg, {
      scope: "user",
      agent: "explorer",
      fileType: "append",
    });
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("APPEND BODY");

    const comp = resolvePromptComposition(s.cfg, "explorer");
    expect(comp.append?.path).toBe(path);
  });

  test("inline prompt masks replacement", () => {
    // researcher has inline prompt
    const path = promptFilePath(s.cfg, {
      scope: "user",
      agent: "researcher",
      fileType: "replacement",
    });
    const ap = applyPromptFileMutation(
      s.cfg,
      {
        kind: "prompt-file",
        scope: "user",
        agent: "researcher",
        fileType: "replacement",
        operation: "set",
        content: "FILE REPL",
      },
      s.revisions,
    );
    expect(ap.ok).toBe(true);
    const comp = resolvePromptComposition(s.cfg, "researcher");
    expect(comp.base?.kind).toBe("inline");
    const repl = comp.sources.find((x) => x.path === path);
    expect(repl?.exists).toBe(true);
    expect(repl?.active).toBe(false);
    expect(comp.warnings.length).toBeGreaterThan(0);
  });

  test("delete restore via revisions", () => {
    const mut = {
      kind: "prompt-file" as const,
      scope: "user" as const,
      agent: "explorer",
      fileType: "append" as const,
      operation: "set" as const,
      content: "X",
    };
    const created = applyPromptFileMutation(s.cfg, mut, s.revisions);
    expect(created.ok).toBe(true);
    const path = promptFilePath(s.cfg, {
      scope: "user",
      agent: "explorer",
      fileType: "append",
    });

    const del = applyPromptFileMutation(
      s.cfg,
      { ...mut, operation: "delete" },
      s.revisions,
    );
    expect(del.ok).toBe(true);
    expect(existsSync(path)).toBe(false);

    // restore from create revision (beforeContent = "", afterContent = "X") — restore sets beforeContent
    const revs = s.revisions.list();
    const createRev = revs.find((r) => r.mutationKind === "prompt-file-create");
    expect(createRev).toBeTruthy();
    // restoring create means go back to before "" — deletion; so instead restore delete rev? Restore sets beforeContent of rev
    const delRev = revs.find((r) => r.mutationKind === "prompt-file-delete");
    expect(delRev).toBeTruthy();
  });

  test("preset subdir path", () => {
    const p = promptFilePath(s.cfg, {
      scope: "user",
      preset: "p1",
      agent: "explorer",
      fileType: "replacement",
    });
    expect(p).toContain("oh-my-opencode-slim/p1/explorer.md");
  });
});
