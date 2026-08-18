import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isWithinAuthorizedRoots,
  loadServerConfig,
  resolveOwlInstallDirectory,
  validateBridgeOverride,
  assertAuthorizedPath,
} from "./config";

function makeTempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "omo-test-")));
}
function cleanup(p: string) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {}
}

// ── resolveOwlInstallDirectory ──────────────────────────────────────────

describe("resolveOwlInstallDirectory", () => {
  test("finds repo root with package name omo-control-plane", () => {
    const dir = resolveOwlInstallDirectory();
    expect(dir).toBe(realpathSync(dir));
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name?: string;
    };
    expect(pkg.name).toBe("omo-control-plane");
  });

  test("explicit startDir within repo resolves to same install root", () => {
    const root = resolveOwlInstallDirectory();
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const viaSrc = resolveOwlInstallDirectory(srcDir);
    expect(viaSrc).toBe(root);
    expect(resolveOwlInstallDirectory(join(root, "apps/server/src"))).toBe(root);
  });

  test("throws when no ancestor within hop limit matches", () => {
    const tmp = makeTempDir();
    try {
      expect(() => resolveOwlInstallDirectory(tmp)).toThrow("not found");
    } finally {
      cleanup(tmp);
    }
  });
});

// ── loadServerConfig: explicit dirs canonicalized & default cwd ─────────

describe("loadServerConfig directory resolution", () => {
  test("explicit absolute temp OMO_CP_PROJECT_DIR and OPENCODE_CONFIG_DIR are canonicalized and used", () => {
    const project = makeTempDir();
    const config = makeTempDir();
    try {
      const cfg = loadServerConfig({
        OMO_CP_PROJECT_DIR: project,
        OPENCODE_CONFIG_DIR: config,
      });
      expect(cfg.projectDirectory).toBe(realpathSync(project));
      expect(cfg.opencodeConfigDir).toBe(realpathSync(config));
    } finally {
      cleanup(project);
      cleanup(config);
    }
  });

  test("symlinked override is canonicalized via realpath", () => {
    const target = makeTempDir();
    const linkParent = makeTempDir();
    const config = makeTempDir();
    const link = join(linkParent, "link-project");
    try {
      symlinkSync(target, link);
      const cfg = loadServerConfig({
        OMO_CP_PROJECT_DIR: link,
        OPENCODE_CONFIG_DIR: config,
      });
      expect(cfg.projectDirectory).toBe(realpathSync(target));
      // link and target realpaths coincide
      expect(cfg.projectDirectory).toBe(realpathSync(link));
    } finally {
      cleanup(target);
      cleanup(linkParent);
      cleanup(config);
    }
  });

  test("default project is current cwd when OMO_CP_PROJECT_DIR absent", () => {
    const cwdTemp = makeTempDir();
    const config = makeTempDir();
    const prev = process.cwd();
    try {
      process.chdir(cwdTemp);
      const cfg = loadServerConfig({ OPENCODE_CONFIG_DIR: config });
      expect(cfg.projectDirectory).toBe(realpathSync(cwdTemp));
      expect(cfg.opencodeConfigDir).toBe(realpathSync(config));
    } finally {
      process.chdir(prev);
      cleanup(cwdTemp);
      cleanup(config);
    }
  });
});

// ── override validation rejects ─────────────────────────────────────────

describe("loadServerConfig override validation", () => {
  test("blank OMO_CP_PROJECT_DIR rejects", () => {
    const config = makeTempDir();
    try {
      expect(() =>
        loadServerConfig({ OMO_CP_PROJECT_DIR: "", OPENCODE_CONFIG_DIR: config }),
      ).toThrow("empty");
      expect(() =>
        loadServerConfig({ OMO_CP_PROJECT_DIR: "   ", OPENCODE_CONFIG_DIR: config }),
      ).toThrow("empty");
    } finally {
      cleanup(config);
    }
  });

  test("blank OPENCODE_CONFIG_DIR rejects", () => {
    const project = makeTempDir();
    try {
      expect(() =>
        loadServerConfig({ OMO_CP_PROJECT_DIR: project, OPENCODE_CONFIG_DIR: "" }),
      ).toThrow("empty");
      expect(() =>
        loadServerConfig({ OMO_CP_PROJECT_DIR: project, OPENCODE_CONFIG_DIR: "   " }),
      ).toThrow("empty");
    } finally {
      cleanup(project);
    }
  });

  test("relative OMO_CP_PROJECT_DIR rejects", () => {
    const config = makeTempDir();
    try {
      expect(() =>
        loadServerConfig({
          OMO_CP_PROJECT_DIR: "relative/path",
          OPENCODE_CONFIG_DIR: config,
        }),
      ).toThrow("absolute");
    } finally {
      cleanup(config);
    }
  });

  test("relative OPENCODE_CONFIG_DIR rejects", () => {
    const project = makeTempDir();
    try {
      expect(() =>
        loadServerConfig({
          OMO_CP_PROJECT_DIR: project,
          OPENCODE_CONFIG_DIR: "relative/opencode",
        }),
      ).toThrow("absolute");
    } finally {
      cleanup(project);
    }
  });

  test("nonexistent OMO_CP_PROJECT_DIR rejects", () => {
    const config = makeTempDir();
    const nope = join(tmpdir(), `omo-nope-${Date.now()}-a`);
    try {
      expect(() =>
        loadServerConfig({ OMO_CP_PROJECT_DIR: nope, OPENCODE_CONFIG_DIR: config }),
      ).toThrow("does not exist");
    } finally {
      cleanup(config);
    }
  });

  test("nonexistent OPENCODE_CONFIG_DIR rejects", () => {
    const project = makeTempDir();
    const nope = join(tmpdir(), `omo-nope-${Date.now()}-b`);
    try {
      expect(() =>
        loadServerConfig({ OMO_CP_PROJECT_DIR: project, OPENCODE_CONFIG_DIR: nope }),
      ).toThrow("does not exist");
    } finally {
      cleanup(project);
    }
  });

  test("file-not-directory OMO_CP_PROJECT_DIR rejects", () => {
    const config = makeTempDir();
    const parent = makeTempDir();
    const file = join(parent, "file.txt");
    writeFileSync(file, "hi");
    try {
      expect(() =>
        loadServerConfig({ OMO_CP_PROJECT_DIR: file, OPENCODE_CONFIG_DIR: config }),
      ).toThrow("not a directory");
    } finally {
      cleanup(parent);
      cleanup(config);
    }
  });

  test("file-not-directory OPENCODE_CONFIG_DIR rejects", () => {
    const project = makeTempDir();
    const parent = makeTempDir();
    const file = join(parent, "file.txt");
    writeFileSync(file, "hi");
    try {
      expect(() =>
        loadServerConfig({ OMO_CP_PROJECT_DIR: project, OPENCODE_CONFIG_DIR: file }),
      ).toThrow("not a directory");
    } finally {
      cleanup(parent);
      cleanup(project);
    }
  });
});

// ── authorizedRoots exact deduped realpaths ─────────────────────────────

describe("authorizedRoots", () => {
  test("are exact deduped realpaths of install/project/config", () => {
    const project = makeTempDir();
    const config = makeTempDir();
    try {
      const cfg = loadServerConfig({
        OMO_CP_PROJECT_DIR: project,
        OPENCODE_CONFIG_DIR: config,
      });
      const expected = [...new Set([cfg.owlInstallDirectory, cfg.projectDirectory, cfg.opencodeConfigDir])];
      expect(cfg.authorizedRoots).toEqual(expected);
      expect(cfg.authorizedRoots).toContain(cfg.owlInstallDirectory);
      expect(cfg.authorizedRoots).toContain(cfg.projectDirectory);
      expect(cfg.authorizedRoots).toContain(cfg.opencodeConfigDir);
      // already realpaths
      for (const r of cfg.authorizedRoots) expect(r).toBe(realpathSync(r));
    } finally {
      cleanup(project);
      cleanup(config);
    }
  });

  test("dedupes when project and config are same directory", () => {
    const shared = makeTempDir();
    try {
      const cfg = loadServerConfig({
        OMO_CP_PROJECT_DIR: shared,
        OPENCODE_CONFIG_DIR: shared,
      });
      const real = realpathSync(shared);
      expect(cfg.projectDirectory).toBe(real);
      expect(cfg.opencodeConfigDir).toBe(real);
      // install root distinct from temp, so 2 entries
      expect(cfg.authorizedRoots.length).toBe(2);
      expect(cfg.authorizedRoots.filter((r) => r === real).length).toBe(1);
    } finally {
      cleanup(shared);
    }
  });
});

// ── isWithinAuthorizedRoots containment / prefix / sibling ──────────────

describe("isWithinAuthorizedRoots", () => {
  test("exact match is within", () => {
    expect(isWithinAuthorizedRoots("/a/b", ["/a/b"])).toBe(true);
  });
  test("child path is within", () => {
    expect(isWithinAuthorizedRoots("/a/b/c", ["/a/b"])).toBe(true);
    expect(isWithinAuthorizedRoots("/a/b/c/d/e", ["/a/b"])).toBe(true);
  });
  test("sibling with dash prefix is not within", () => {
    expect(isWithinAuthorizedRoots("/a/b-other", ["/a/b"])).toBe(false);
  });
  test("prefix without slash sibling is not within", () => {
    expect(isWithinAuthorizedRoots("/a/bother", ["/a/b"])).toBe(false);
    expect(isWithinAuthorizedRoots("/tmp/foobar", ["/tmp/foo"])).toBe(false);
  });
  test("outside unrelated root is not within", () => {
    expect(isWithinAuthorizedRoots("/x/y", ["/a/b"])).toBe(false);
  });
  test("darwin /tmp <-> /private/tmp alias treated as equivalent", () => {
    expect(isWithinAuthorizedRoots("/private/tmp/foo/bar", ["/tmp/foo"])).toBe(true);
    expect(isWithinAuthorizedRoots("/tmp/foo/bar", ["/private/tmp/foo"])).toBe(true);
    expect(isWithinAuthorizedRoots("/private/var/foo", ["/var/foo"])).toBe(true);
    expect(isWithinAuthorizedRoots("/var/foo/bar", ["/private/var/foo"])).toBe(true);
  });
  test("assertAuthorizedPath throws outside", () => {
    expect(() => assertAuthorizedPath("/outside/path", ["/a/b"])).toThrow(
      "outside authorized scope",
    );
    expect(() => assertAuthorizedPath("/a/b/c", ["/a/b"])).not.toThrow();
  });
});

// ── OpenCode mode / host / port ─────────────────────────────────────────

describe("OpenCode mode configuration", () => {
  test("absence selects managed without inventing an attach URL", () => {
    const project = makeTempDir();
    const config = makeTempDir();
    try {
      const cfg = loadServerConfig({
        OMO_CP_PROJECT_DIR: project,
        OPENCODE_CONFIG_DIR: config,
      });
      expect(cfg.opencodeMode).toBe("managed");
      expect(cfg.opencodeAttachBaseUrl).toBeUndefined();
      expect(cfg.projectDirectory).toBe(realpathSync(project));
      expect(cfg.opencodeConfigDir).toBe(realpathSync(config));
    } finally {
      cleanup(project);
      cleanup(config);
    }
  });

  test("presence selects attach, including explicit empty", () => {
    const project = makeTempDir();
    const config = makeTempDir();
    try {
      const cfg = loadServerConfig({
        OMO_CP_PROJECT_DIR: project,
        OPENCODE_CONFIG_DIR: config,
        OPENCODE_BASE_URL: "",
      });
      expect(cfg.opencodeMode).toBe("attach");
      expect(cfg.opencodeAttachBaseUrl).toBe("");
      const cfg2 = loadServerConfig({
        OMO_CP_PROJECT_DIR: project,
        OPENCODE_CONFIG_DIR: config,
        OPENCODE_BASE_URL: "http://127.0.0.1:4096",
      });
      expect(cfg2.opencodeMode).toBe("attach");
      expect(cfg2.opencodeAttachBaseUrl).toBe("http://127.0.0.1:4096");
    } finally {
      cleanup(project);
      cleanup(config);
    }
  });

  test("host and port defaults and overrides", () => {
    const project = makeTempDir();
    const config = makeTempDir();
    try {
      const def = loadServerConfig({
        OMO_CP_PROJECT_DIR: project,
        OPENCODE_CONFIG_DIR: config,
      });
      expect(def.host).toBe("127.0.0.1");
      expect(def.port).toBe(8787);
      const over = loadServerConfig({
        OMO_CP_PROJECT_DIR: project,
        OPENCODE_CONFIG_DIR: config,
        OMO_CP_HOST: "0.0.0.0",
        OMO_CP_PORT: "3000",
      });
      expect(over.host).toBe("0.0.0.0");
      expect(over.port).toBe(3000);
    } finally {
      cleanup(project);
      cleanup(config);
    }
  });
});

// ── OMO_BRIDGE_BASE_URL override in loadServerConfig ────────────────────

describe("OMO_BRIDGE_BASE_URL override in loadServerConfig", () => {
  function validEnv(extra: Record<string, string | undefined> = {}) {
    const project = makeTempDir();
    const config = makeTempDir();
    return { project, config, env: { OMO_CP_PROJECT_DIR: project, OPENCODE_CONFIG_DIR: config, ...extra } };
  }

  test("absence → override not present, no management opt-out", () => {
    const { project, config, env } = validEnv();
    try {
      const cfg = loadServerConfig(env);
      expect(cfg.omoBridgeOverride?.present).toBe(false);
      expect(cfg.omoBridgeOverride?.optsOutOfManagement).toBe(false);
      expect(cfg.omoBridgeBaseUrl).toBeUndefined();
    } finally {
      cleanup(project);
      cleanup(config);
    }
  });

  test("valid loopback → valid override, opts out of management", () => {
    const { project, config, env } = validEnv({ OMO_BRIDGE_BASE_URL: "http://127.0.0.1:8788" });
    try {
      const cfg = loadServerConfig(env);
      expect(cfg.omoBridgeOverride?.present).toBe(true);
      expect(cfg.omoBridgeOverride?.invalid).toBe(false);
      expect(cfg.omoBridgeOverride?.url).toBe("http://127.0.0.1:8788");
      expect(cfg.omoBridgeOverride?.port).toBe(8788);
      expect(cfg.omoBridgeOverride?.optsOutOfManagement).toBe(true);
      expect(cfg.omoBridgeBaseUrl).toBe("http://127.0.0.1:8788");
    } finally {
      cleanup(project);
      cleanup(config);
    }
  });

  test("invalid non-loopback → omoBridgeBaseUrl undefined (cannot request)", () => {
    const { project, config, env } = validEnv({ OMO_BRIDGE_BASE_URL: "http://192.168.0.1:8788" });
    try {
      const cfg = loadServerConfig(env);
      expect(cfg.omoBridgeOverride?.present).toBe(true);
      expect(cfg.omoBridgeOverride?.invalid).toBe(true);
      expect(cfg.omoBridgeOverride?.optsOutOfManagement).toBe(false);
      expect(cfg.omoBridgeBaseUrl).toBeUndefined();
    } finally {
      cleanup(project);
      cleanup(config);
    }
  });

  test("localhost rejected (only 127.0.0.1)", () => {
    const { project, config, env } = validEnv({ OMO_BRIDGE_BASE_URL: "http://localhost:8788" });
    try {
      const cfg = loadServerConfig(env);
      expect(cfg.omoBridgeOverride?.invalid).toBe(true);
      expect(cfg.omoBridgeBaseUrl).toBeUndefined();
    } finally {
      cleanup(project);
      cleanup(config);
    }
  });

  test("empty string → not present (absence preserved)", () => {
    const { project, config, env } = validEnv({ OMO_BRIDGE_BASE_URL: "" });
    try {
      const cfg = loadServerConfig(env);
      expect(cfg.omoBridgeOverride?.present).toBe(false);
      expect(cfg.omoBridgeBaseUrl).toBeUndefined();
    } finally {
      cleanup(project);
      cleanup(config);
    }
  });

  test("https rejected", () => {
    const { project, config, env } = validEnv({ OMO_BRIDGE_BASE_URL: "https://127.0.0.1:8788" });
    try {
      const cfg = loadServerConfig(env);
      expect(cfg.omoBridgeOverride?.invalid).toBe(true);
      expect(cfg.omoBridgeBaseUrl).toBeUndefined();
    } finally {
      cleanup(project);
      cleanup(config);
    }
  });

  test("userinfo rejected", () => {
    const { project, config, env } = validEnv({ OMO_BRIDGE_BASE_URL: "http://user:pass@127.0.0.1:8788" });
    try {
      const cfg = loadServerConfig(env);
      expect(cfg.omoBridgeOverride?.invalid).toBe(true);
      expect(cfg.omoBridgeOverride?.invalidReason).toContain("userinfo");
    } finally {
      cleanup(project);
      cleanup(config);
    }
  });

  test("query rejected", () => {
    const { project, config, env } = validEnv({ OMO_BRIDGE_BASE_URL: "http://127.0.0.1:8788?foo=bar" });
    try {
      const cfg = loadServerConfig(env);
      expect(cfg.omoBridgeOverride?.invalid).toBe(true);
      expect(cfg.omoBridgeOverride?.invalidReason).toContain("query");
    } finally {
      cleanup(project);
      cleanup(config);
    }
  });

  test("fragment rejected", () => {
    const { project, config, env } = validEnv({ OMO_BRIDGE_BASE_URL: "http://127.0.0.1:8788#frag" });
    try {
      const cfg = loadServerConfig(env);
      expect(cfg.omoBridgeOverride?.invalid).toBe(true);
      expect(cfg.omoBridgeOverride?.invalidReason).toContain("fragment");
    } finally {
      cleanup(project);
      cleanup(config);
    }
  });
});

describe("validateBridgeOverride (consolidated)", () => {
  test("undefined → not present", () => {
    const r = validateBridgeOverride(undefined);
    expect(r.present).toBe(false);
    expect(r.invalid).toBe(false);
  });

  test("valid 127.0.0.1 → canonical URL", () => {
    const r = validateBridgeOverride("http://127.0.0.1:8788");
    expect(r.invalid).toBe(false);
    expect(r.url).toBe("http://127.0.0.1:8788");
    expect(r.optsOutOfManagement).toBe(true);
  });

  test("non-127.0.0.1 rejected", () => {
    const r = validateBridgeOverride("http://10.0.0.1:8788");
    expect(r.invalid).toBe(true);
    expect(r.invalidReason).toContain("127.0.0.1");
  });
});
