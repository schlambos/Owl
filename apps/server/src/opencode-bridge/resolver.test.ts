/**
 * Slice 17 hardened — Resolver tests.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAuthorizedCandidate,
  resolveSourceCandidates,
  fetchAdvisoryRemoteSchema,
} from "./resolver";
import type { EffectivePluginView, EffectivePluginEntry } from "./types";

let sandbox: string;
let configDir: string;
let projectDir: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "omo-resolver-"));
  configDir = join(sandbox, "config");
  projectDir = join(sandbox, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* */ }
});

function writeConfig(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

function makeEntry(identity: string, kind: "npm" | "path" | "file-url"): EffectivePluginEntry {
  return { form: "string", effectiveIdentity: identity, identityKind: kind };
}

function view(entries: EffectivePluginEntry[]): EffectivePluginView {
  return { entries };
}

/** Parse a config and build a matching effective view from its plugin array. */
function matchingView(text: string): EffectivePluginView {
  const parsed = JSON.parse(text);
  const plugin = (parsed.plugin ?? []) as string[];
  const entries: EffectivePluginEntry[] = plugin.map((p) => {
    const kind = p.startsWith("/") ? "path" : p.startsWith("file://") ? "file-url" : "npm";
    return makeEntry(p, kind as "npm" | "path" | "file-url");
  });
  return view(entries);
}

// Legacy fixtures keep the bridge package co-located under the project
// dir, so the fixture "install root" defaults to the project dir.
const opts = () => ({
  opencodeConfigDir: configDir,
  projectDirectory: projectDir,
  owlInstallDirectory: projectDir,
  authorizedRoots: [configDir, projectDir],
});

describe("resolveSourceCandidates: both json and jsonc", () => {
  test("finds .json candidate", () => {
    writeConfig(configDir, "opencode.json", '{"plugin":["foo"]}');
    const { candidates } = resolveSourceCandidates(opts());
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.format).toBe("json");
  });

  test("finds .jsonc candidate", () => {
    writeConfig(configDir, "opencode.jsonc", '{\n  // comment\n  "plugin": ["foo"]\n}');
    const { candidates } = resolveSourceCandidates(opts());
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.format).toBe("jsonc");
  });

  test("BOTH .json and .jsonc exist → 2 candidates (not rejected)", () => {
    writeConfig(configDir, "opencode.json", '{"plugin":["foo"]}');
    writeConfig(configDir, "opencode.jsonc", '{"plugin":["foo"]}');
    const { candidates } = resolveSourceCandidates(opts());
    expect(candidates).toHaveLength(2);
  });

  test("no candidates → empty", () => {
    const { candidates } = resolveSourceCandidates(opts());
    expect(candidates).toEqual([]);
  });

  test("comments preserved in parse", () => {
    writeConfig(configDir, "opencode.jsonc", `{
  // top comment
  "plugin": ["foo"]
}`);
    const { candidates, errors } = resolveSourceCandidates(opts());
    expect(errors).toHaveLength(0);
    expect(candidates[0]!.pluginEntries).toHaveLength(1);
  });

  test("trailing comma tolerated", () => {
    writeConfig(configDir, "opencode.jsonc", `{"plugin":["foo",]}`);
    const { candidates, errors } = resolveSourceCandidates(opts());
    expect(errors).toHaveLength(0);
    expect(candidates[0]!.pluginEntries).toHaveLength(1);
  });

  test("empty plugin array → 0 entries", () => {
    writeConfig(configDir, "opencode.json", '{"plugin":[]}');
    const { candidates } = resolveSourceCandidates(opts());
    expect(candidates[0]!.pluginEntries).toEqual([]);
  });

  test("plugin not array → error", () => {
    writeConfig(configDir, "opencode.json", '{"plugin":"foo"}');
    const { candidates, errors } = resolveSourceCandidates(opts());
    expect(candidates).toHaveLength(0);
    expect(errors[0]?.code).toBe("plugin-shape-unsupported");
  });

  test("tuple [string, options] entry parsed", () => {
    writeConfig(configDir, "opencode.json", '{"plugin":[["foo",{ "port": 8788 }]]}');
    const { candidates, errors } = resolveSourceCandidates(opts());
    expect(errors).toHaveLength(0);
    expect(candidates[0]!.pluginEntries).toHaveLength(1);
    expect(candidates[0]!.pluginEntries[0]!.form).toBe("tuple");
  });

  test("{path, options} object entry → unsupported error", () => {
    writeConfig(configDir, "opencode.json", '{"plugin":[{"path":"foo"}]}');
    const { candidates, errors } = resolveSourceCandidates(opts());
    expect(errors[0]?.code).toBe("plugin-shape-unsupported");
  });
});

describe("resolveAuthorizedCandidate: exact match across all candidates", () => {
  test("exactly one match → proven", () => {
    writeConfig(configDir, "opencode.json", '{"plugin":["foo"]}');
    const r = resolveAuthorizedCandidate(opts(), view([makeEntry("foo", "npm")]));
    expect(r.status).toBe("proven");
  });

  test("both json and jsonc match → config-ambiguous (multiple matches)", () => {
    writeConfig(configDir, "opencode.json", '{"plugin":["foo"]}');
    writeConfig(configDir, "opencode.jsonc", '{"plugin":["foo"]}');
    const r = resolveAuthorizedCandidate(opts(), view([makeEntry("foo", "npm")]));
    expect(r.status).toBe("blocked");
    if (r.status === "blocked") {
      expect(r.errors.some((e) => e.code === "config-ambiguous")).toBe(true);
    }
  });

  test("both json and jsonc exist but only one matches → proven", () => {
    writeConfig(configDir, "opencode.json", '{"plugin":["foo"]}');
    writeConfig(configDir, "opencode.jsonc", '{"plugin":["bar"]}');
    const r = resolveAuthorizedCandidate(opts(), view([makeEntry("foo", "npm")]));
    expect(r.status).toBe("proven");
  });

  test("zero matches → source-unproven", () => {
    writeConfig(configDir, "opencode.json", '{"plugin":["bar"]}');
    const r = resolveAuthorizedCandidate(opts(), view([makeEntry("foo", "npm")]));
    expect(r.status).toBe("blocked");
    if (r.status === "blocked") {
      expect(r.errors.some((e) => e.code === "source-unproven")).toBe(true);
    }
  });

  test("order mismatch → blocked", () => {
    writeConfig(configDir, "opencode.json", '{"plugin":["foo","bar"]}');
    const r = resolveAuthorizedCandidate(opts(), view([
      makeEntry("bar", "npm"),
      makeEntry("foo", "npm"),
    ]));
    expect(r.status).toBe("blocked");
  });

  test("form mismatch (string vs tuple) → blocked", () => {
    writeConfig(configDir, "opencode.json", '{"plugin":["foo"]}');
    const r = resolveAuthorizedCandidate(opts(), view([
      { form: "tuple", effectiveIdentity: "foo", identityKind: "npm" },
    ]));
    expect(r.status).toBe("blocked");
  });

  test("effective view invalid → blocked", () => {
    writeConfig(configDir, "opencode.json", '{"plugin":["foo"]}');
    const r = resolveAuthorizedCandidate(opts(), { entries: [], invalid: true });
    expect(r.status).toBe("blocked");
  });

  test("symlinked config file escaping roots → env-scope-unproven", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "omo-outside-"));
    try {
      const outsideFile = join(outsideDir, "evil.json");
      writeFileSync(outsideFile, '{"plugin":["foo"]}');
      const linkPath = join(configDir, "opencode.json");
      symlinkSync(outsideFile, linkPath);
      const { candidates, advisories } = resolveSourceCandidates(opts());
      expect(candidates).toHaveLength(0);
      expect(advisories.some((a) => a.kind === "symlink-escape")).toBe(true);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("source canonical path ↔ effective canonical file-url matches and proves candidate", () => {
    const bridgeDir = join(projectDir, "packages", "omo-telemetry-bridge");
    mkdirSync(bridgeDir, { recursive: true });
    writeFileSync(join(bridgeDir, "package.json"), "{}");

    writeConfig(configDir, "opencode.json", JSON.stringify({ plugin: [bridgeDir] }));
    const effectiveView: EffectivePluginView = {
      entries: [
        {
          form: "string",
          effectiveIdentity: `file://${bridgeDir}`,
          identityKind: "file-url",
          bridge: {
            pluginForm: "string",
            registrationTransport: "env",
            transportMode: "loopback-http",
          },
        },
      ],
    };
    const r = resolveAuthorizedCandidate(opts(), effectiveView);
    expect(r.status).toBe("proven");
    if (r.status === "proven") {
      expect(r.bridgeEntry).not.toBeNull();
      expect(r.bridgeEntry?.identity).toBe(bridgeDir);
    }
  });

  test("canonical matching succeeds when the Owl install root differs from the target project", () => {
    // Bridge package lives ONLY under a separate install root; the target
    // project dir has no packages/ layout at all.
    const installDir = join(sandbox, "owl-install");
    const bridgeDir = join(installDir, "packages", "omo-telemetry-bridge");
    mkdirSync(bridgeDir, { recursive: true });
    writeFileSync(join(bridgeDir, "package.json"), "{}");
    expect(existsSync(join(projectDir, "packages"))).toBe(false);

    writeConfig(configDir, "opencode.json", JSON.stringify({ plugin: [bridgeDir] }));
    const effectiveView: EffectivePluginView = {
      entries: [
        {
          form: "string",
          effectiveIdentity: `file://${bridgeDir}`,
          identityKind: "file-url",
          bridge: {
            pluginForm: "string",
            registrationTransport: "env",
            transportMode: "loopback-http",
          },
        },
      ],
    };

    const installOpts = {
      opencodeConfigDir: configDir,
      projectDirectory: projectDir,
      owlInstallDirectory: installDir,
      authorizedRoots: [configDir, projectDir, installDir],
    };
    const r = resolveAuthorizedCandidate(installOpts, effectiveView);
    expect(r.status).toBe("proven");
    if (r.status === "proven") {
      expect(r.bridgeEntry).not.toBeNull();
      expect(r.bridgeEntry?.identity).toBe(bridgeDir);
      // The proven candidate remains the target project/config source.
      expect(["opencode-config-dir", "project-root"]).toContain(r.candidate.kind);
    }
  });

  test("reverse lexical forms (source file-url ↔ effective path) matches when both canonical", () => {
    const bridgeDir = join(projectDir, "packages", "omo-telemetry-bridge");
    mkdirSync(bridgeDir, { recursive: true });
    writeFileSync(join(bridgeDir, "package.json"), "{}");

    writeConfig(configDir, "opencode.json", JSON.stringify({ plugin: [`file://${bridgeDir}`] }));
    const effectiveView: EffectivePluginView = {
      entries: [
        {
          form: "string",
          effectiveIdentity: bridgeDir,
          identityKind: "path",
          bridge: {
            pluginForm: "string",
            registrationTransport: "env",
            transportMode: "loopback-http",
          },
        },
      ],
    };
    const r = resolveAuthorizedCandidate(opts(), effectiveView);
    expect(r.status).toBe("proven");
    if (r.status === "proven") {
      expect(r.bridgeEntry).not.toBeNull();
      expect(r.bridgeEntry?.identity).toBe(`file://${bridgeDir}`);
    }
  });

  test("arbitrary noncanonical path ↔ file-url does NOT match", () => {
    const otherDir = join(projectDir, "packages", "other-pkg");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "package.json"), "{}");

    writeConfig(configDir, "opencode.json", JSON.stringify({ plugin: [otherDir] }));
    const effectiveView: EffectivePluginView = {
      entries: [
        {
          form: "string",
          effectiveIdentity: `file://${otherDir}`,
          identityKind: "file-url",
        },
      ],
    };
    const r = resolveAuthorizedCandidate(opts(), effectiveView);
    expect(r.status).toBe("blocked");
  });
});

describe("fetchAdvisoryRemoteSchema: non-authority", () => {
  test("returns advisories, never throws", async () => {
    const fakeFetch = async () => new Response("{}", { status: 200 });
    const advisories = await fetchAdvisoryRemoteSchema(fakeFetch as never);
    expect(advisories.length).toBeGreaterThan(0);
    expect(advisories[0]?.kind).toBe("remote-schema");
    expect(advisories[0]?.message).toContain("Not an authority");
  });

  test("HTTP error → advisory", async () => {
    const fakeFetch = async () => new Response("nope", { status: 404 });
    const advisories = await fetchAdvisoryRemoteSchema(fakeFetch as never);
    expect(advisories[0]?.message).toContain("unreachable");
  });

  test("network error → advisory", async () => {
    const fakeFetch = async () => { throw new Error("network"); };
    const advisories = await fetchAdvisoryRemoteSchema(fakeFetch as never);
    expect(advisories[0]?.message).toContain("failed");
  });
});