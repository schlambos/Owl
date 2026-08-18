import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  applyAcp,
  buildAcpInventory,
  redactSecrets,
  simulateAcp,
  type AcpMutation,
} from "./acp";
import { RevisionStore } from "./revisions";
import { hashContent } from "./jsonc-edit";
import { probeAcp } from "../acp/probe";
import { resolveCommand } from "../acp/command";

const ROOT = join(import.meta.dir, "../../test/acp-sandbox");

function installSyntheticSchema(userDir: string): void {
  const dir = join(userDir, "node_modules", "oh-my-opencode-slim");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.0.0-test" }));
  writeFileSync(join(dir, "oh-my-opencode-slim.schema.json"), JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }));
}

function fresh() {
  rmSync(ROOT, { recursive: true, force: true });
  const userDir = join(ROOT, "cfg");
  const projDir = join(ROOT, "proj");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  mkdirSync(join(projDir, "data"), { recursive: true });
  installSyntheticSchema(userDir);
  writeFileSync(
    join(userDir, "oh-my-opencode-slim.json"),
    `{
  // keep
  "preset": "openai",
  "acpAgents": {
    "claude-acp": {
      "command": "node",
      "args": ["agent.js"],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-xxx", "NODE_ENV": "prod" },
      "wrapperModel": "openai/gpt-5.6-sol",
      "permissionMode": "ask"
    }
  }
}
`,
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

describe("inventory", () => {
  let s: ReturnType<typeof fresh>;
  beforeEach(() => {
    s = fresh();
  });

  test("inventory masked env", () => {
    const inv = buildAcpInventory(s.cfg, ["claude-acp"], false);
    const a = inv.agents[0]!;
    expect(a.name).toBe("claude-acp");
    expect(a.command).toBe("node");
    expect(a.secretKeyCount).toBe(1);
    expect(String(a.envMasked.ANTHROPIC_API_KEY)).not.toContain("sk-ant-xxx");
    expect(a.envMasked.NODE_ENV).toBe("prod");
    expect(a.wrapperRegistered).toBe(true);
  });

  test("command resolve", () => {
    const r = resolveCommand("node");
    expect(r.status).toBe("resolved");
    const r2 = resolveCommand("definitely-not-a-cmd-xyz-123");
    expect(r2.status).toBe("not-resolved");
  });

  test("cwd outside scope", () => {
    writeFileSync(
      join(s.userDir, "oh-my-opencode-slim.json"),
      JSON.stringify({ acpAgents: { x: { command: "node", cwd: "/usr/lib" } } }),
    );
    const inv = buildAcpInventory(s.cfg, [], false);
    expect(inv.agents[0]!.cwdAuthorized).toBe(false);
    expect(inv.agents[0]!.warnings.join(" ")).toContain("outside");
  });
});

describe("mutations", () => {
  let s: ReturnType<typeof fresh>;
  beforeEach(() => {
    s = fresh();
  });
  const h = () =>
    hashContent(readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8"));

  test("create requires command", () => {
    const r = simulateAcp(s.cfg, {
      kind: "acp",
      scope: "user",
      create: { name: "new-acp" },
      expectedSourceHash: h(),
    });
    expect(r.ok).toBe(false);
  });

  test("name conflict with custom agent", () => {
    writeFileSync(
      join(s.userDir, "oh-my-opencode-slim.json"),
      JSON.stringify({ agents: { researcher: {} } }),
    );
    const r = simulateAcp(s.cfg, {
      kind: "acp",
      scope: "user",
      create: {
        name: "researcher",
        fields: { command: { operation: "set", value: "node" } },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("custom agent");
  });

  test("invalid name", () => {
    const r = simulateAcp(s.cfg, {
      kind: "acp",
      scope: "user",
      create: {
        name: "1bad name",
        fields: { command: { operation: "set", value: "node" } },
      },
    });
    expect(r.ok).toBe(false);
  });

  test("create + update + rename + delete", () => {
    let r = applyAcp(s.cfg, {
      kind: "acp",
      scope: "user",
      create: {
        name: "probe-agent",
        fields: {
          command: { operation: "set", value: "/bin/echo" },
          args: { operation: "set", value: ["hello"] },
          wrapperModel: { operation: "set", value: "openai/gpt-5.6-sol" },
          timeoutMs: { operation: "set", value: 5000 },
          permissionMode: { operation: "set", value: "allow" },
        },
      },
      expectedSourceHash: h(),
    }, s.revisions);
    expect(r.ok).toBe(true);
    expect((r.effectiveChanges ?? []).length).toBeGreaterThan(0);

    r = applyAcp(s.cfg, {
      kind: "acp",
      scope: "user",
      update: {
        name: "probe-agent",
        fields: { timeoutMs: { operation: "set", value: 9000 } },
      },
      expectedSourceHash: hashContent(readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8")),
    }, s.revisions);
    expect(r.ok).toBe(true);

    r = applyAcp(s.cfg, {
      kind: "acp",
      scope: "user",
      rename: { oldName: "probe-agent", newName: "probe-2" },
      expectedSourceHash: hashContent(readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8")),
    }, s.revisions);
    expect(r.ok).toBe(true);

    r = applyAcp(s.cfg, {
      kind: "acp",
      scope: "user",
      delete: { name: "probe-2" },
      expectedSourceHash: hashContent(readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8")),
    }, s.revisions);
    expect(r.ok).toBe(true);
    const t = readFileSync(join(s.userDir, "oh-my-opencode-slim.json"), "utf-8");
    expect(t).toContain("claude-acp"); // untouched
    expect(t).toContain("sk-ant-xxx"); // real file keeps secrets
  });

  test("env validation", () => {
    const r = simulateAcp(s.cfg, {
      kind: "acp",
      scope: "user",
      update: {
        name: "claude-acp",
        fields: { env: { operation: "set", value: { "bad key": "x" } } },
      },
      expectedSourceHash: h(),
    });
    expect(r.ok).toBe(false);
  });

  test("permissionMode enum", () => {
    const r = simulateAcp(s.cfg, {
      kind: "acp",
      scope: "user",
      update: {
        name: "claude-acp",
        fields: { permissionMode: { operation: "set", value: "nope" } },
      },
      expectedSourceHash: h(),
    });
    expect(r.ok).toBe(false);
  });
});

describe("secrets", () => {
  test("redactSecrets", () => {
    const t = `{"env":{"ANTHROPIC_API_KEY":"sk-ant-xxx","plain":"ok"}}`;
    const out = redactSecrets(t);
    expect(out).not.toContain("sk-ant-xxx");
    expect(out).toContain("ok");
  });
});

describe("probe fixture", () => {
  let s: ReturnType<typeof fresh>;
  beforeEach(() => {
    s = fresh();
  });

  test("handshake with fake ACP agent", async () => {
    const fixture = join(s.projDir, "fake-acp.js");
    writeFileSync(
      fixture,
      `process.stdin.on("data", (d) => {
        const lines = String(d).split("\\n").filter(Boolean);
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            if (msg.method === "initialize") {
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0", id: msg.id,
                result: { protocolVersion: 1, agentInfo: { name: "fake-acp", version: "0.0.1" } }
              }) + "\\n");
            }
          } catch {}
        }
      });
      setTimeout(() => {}, 5000);
      `,
    );
    const result = await probeAcp({
      command: "bun",
      args: [fixture],
      env: { TEST_SECRET: "secret123" },
      cwd: s.projDir,
    });
    expect(result.ok).toBe(true);
    expect(result.handshake).toBe(true);
    expect(result.agentInfo?.name).toBe("fake-acp");
    expect(result.terminated).toBe(true);
  }, 25000);
});
