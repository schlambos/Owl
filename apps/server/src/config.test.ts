import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
  readFileSync,
  symlinkSync,
  mkdirSync,
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
  getDefaultOwlInstallSearchStartDir,
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

// ── getDefaultOwlInstallSearchStartDir source selection (no global Bun mutation) ─

describe("getDefaultOwlInstallSearchStartDir source selection", () => {
  test("non-standalone returns module directory via injection", () => {
    const modDir = dirname(fileURLToPath(import.meta.url));
    expect(
      getDefaultOwlInstallSearchStartDir({
        isStandaloneExecutable: false,
        moduleDir: modDir,
        execPath: "/fake/exec",
      }),
    ).toBe(modDir);
  });

  test("non-standalone default without overrides returns module directory", () => {
    // In bun test we are not standalone, so default should equal module dir.
    const modDir = dirname(fileURLToPath(import.meta.url));
    expect(getDefaultOwlInstallSearchStartDir()).toBe(modDir);
  });

  test("standalone returns dirname(realpathSync(execPath)) via injection", () => {
    const execDir = makeTempDir();
    const fakeExec = join(execDir, "omo-executable");
    writeFileSync(fakeExec, "fake binary");
    try {
      const start = getDefaultOwlInstallSearchStartDir({
        isStandaloneExecutable: true,
        execPath: fakeExec,
      });
      expect(start).toBe(dirname(realpathSync(fakeExec)));
      expect(start).toBe(realpathSync(execDir));
    } finally {
      cleanup(execDir);
    }
  });

  test("standalone resolves symlink execPath via realpath", () => {
    const targetDir = makeTempDir();
    const linkParent = makeTempDir();
    const realExec = join(targetDir, "real-exec");
    writeFileSync(realExec, "bin");
    const linkExec = join(linkParent, "link-exec");
    symlinkSync(realExec, linkExec);
    try {
      const start = getDefaultOwlInstallSearchStartDir({
        isStandaloneExecutable: true,
        execPath: linkExec,
      });
      // realpathSync(linkExec) == realExec, dirname is targetDir
      expect(start).toBe(dirname(realpathSync(realExec)));
      expect(start).toBe(realpathSync(targetDir));
    } finally {
      cleanup(targetDir);
      cleanup(linkParent);
    }
  });

  test("standalone with nonexistent execPath falls back to lexical dirname", () => {
    const fake = join(tmpdir(), `omo-nonexistent-${Date.now()}`, "bin", "exec");
    const start = getDefaultOwlInstallSearchStartDir({
      isStandaloneExecutable: true,
      execPath: fake,
    });
    expect(start).toBe(dirname(fake));
  });

  test("does not use process.cwd() - cwd change does not affect injected moduleDir", () => {
    const modDir = dirname(fileURLToPath(import.meta.url));
    const cwdTemp = makeTempDir();
    const prev = process.cwd();
    try {
      process.chdir(cwdTemp);
      expect(
        getDefaultOwlInstallSearchStartDir({
          isStandaloneExecutable: false,
          moduleDir: modDir,
        }),
      ).toBe(modDir);
      expect(getDefaultOwlInstallSearchStartDir({ isStandaloneExecutable: false, moduleDir: modDir })).not.toBe(
        realpathSync(cwdTemp),
      );
    } finally {
      process.chdir(prev);
      cleanup(cwdTemp);
    }
  });
});

// ── Bun 1.3/1.4 forward/backward compatible detection via injectable Bun.main ─

describe("getDefaultOwlInstallSearchStartDir Bun detection compatibility", () => {
  test("1.3 POSIX marker /$bunfs/ is treated as standalone via bunMain", () => {
    const execDir = makeTempDir();
    const fakeExec = join(execDir, "omo-bin");
    writeFileSync(fakeExec, "fake");
    try {
      const start = getDefaultOwlInstallSearchStartDir({
        bunMain: "/$bunfs/root/apps/server/src/index.ts",
        execPath: fakeExec,
      });
      expect(start).toBe(dirname(realpathSync(fakeExec)));
      expect(start).toBe(realpathSync(execDir));
    } finally {
      cleanup(execDir);
    }
  });

  test("Windows marker B:\\~BUN\\ normalized to /~BUN/ is treated as standalone", () => {
    const execDir = makeTempDir();
    const fakeExec = join(execDir, "omo-bin.exe");
    writeFileSync(fakeExec, "fake");
    try {
      const start = getDefaultOwlInstallSearchStartDir({
        bunMain: "B:\\~BUN\\some\\path\\index.js",
        execPath: fakeExec,
      });
      expect(start).toBe(dirname(realpathSync(fakeExec)));
      // Also verify normalization with mixed separators and drive prefix
      const start2 = getDefaultOwlInstallSearchStartDir({
        bunMain: "B:\\~BUN\\apps\\server\\index.ts",
        execPath: fakeExec,
      });
      expect(start2).toBe(dirname(realpathSync(fakeExec)));
    } finally {
      cleanup(execDir);
    }
  });

  test("1.4 boolean flag isStandaloneExecutable true is treated as standalone even with normal Bun.main", () => {
    const execDir = makeTempDir();
    const fakeExec = join(execDir, "omo-bin-1.4");
    writeFileSync(fakeExec, "fake");
    try {
      const start = getDefaultOwlInstallSearchStartDir({
        isStandaloneExecutable: true,
        bunMain: "/app/repo/apps/server/src/index.ts",
        execPath: fakeExec,
      });
      expect(start).toBe(dirname(realpathSync(fakeExec)));
    } finally {
      cleanup(execDir);
    }
  });

  test("explicit false override takes precedence over virtual Bun.main marker", () => {
    const modDir = dirname(fileURLToPath(import.meta.url));
    const execDir = makeTempDir();
    const fakeExec = join(execDir, "omo-bin-override");
    writeFileSync(fakeExec, "fake");
    try {
      const start = getDefaultOwlInstallSearchStartDir({
        isStandaloneExecutable: false,
        bunMain: "/$bunfs/root/apps/server/src/index.ts",
        execPath: fakeExec,
        moduleDir: modDir,
      });
      expect(start).toBe(modDir);
      // Also Windows marker with explicit false should not be standalone
      const startWin = getDefaultOwlInstallSearchStartDir({
        isStandaloneExecutable: false,
        bunMain: "B:\\~BUN\\path\\index.js",
        execPath: fakeExec,
        moduleDir: modDir,
      });
      expect(startWin).toBe(modDir);
    } finally {
      cleanup(execDir);
    }
  });

  test("normal source Bun.main path is not standalone", () => {
    const modDir = dirname(fileURLToPath(import.meta.url));
    expect(
      getDefaultOwlInstallSearchStartDir({
        bunMain: "/app/repo/apps/server/src/index.ts",
        moduleDir: modDir,
        execPath: "/fake/should-not-be-used",
      }),
    ).toBe(modDir);

    expect(
      getDefaultOwlInstallSearchStartDir({
        bunMain: "/home/user/project/apps/server/src/config.ts",
        moduleDir: modDir,
      }),
    ).toBe(modDir);
  });
});

// ── simulated standalone executable-adjacent package root ───────────────

describe("resolveOwlInstallDirectory simulated standalone executable adjacency", () => {
  test("exec adjacent to package root is found via bounded walk", () => {
    const installRoot = makeTempDir();
    try {
      writeFileSync(join(installRoot, "package.json"), JSON.stringify({ name: "omo-control-plane" }));
      const fakeExec = join(installRoot, "omo-control-plane-bin");
      writeFileSync(fakeExec, "fake");
      const start = getDefaultOwlInstallSearchStartDir({
        isStandaloneExecutable: true,
        execPath: fakeExec,
      });
      expect(start).toBe(realpathSync(installRoot));
      expect(resolveOwlInstallDirectory(start)).toBe(realpathSync(installRoot));
    } finally {
      cleanup(installRoot);
    }
  });

  test("exec in nested subdir walks up to install root", () => {
    const installRoot = makeTempDir();
    try {
      writeFileSync(join(installRoot, "package.json"), JSON.stringify({ name: "omo-control-plane" }));
      const nested = join(installRoot, "dist", "bin");
      mkdirSync(nested, { recursive: true });
      const fakeExec = join(nested, "server");
      writeFileSync(fakeExec, "fake");
      const start = getDefaultOwlInstallSearchStartDir({
        isStandaloneExecutable: true,
        execPath: fakeExec,
      });
      expect(start).toBe(realpathSync(nested));
      expect(resolveOwlInstallDirectory(start)).toBe(realpathSync(installRoot));
    } finally {
      cleanup(installRoot);
    }
  });

  test("exec adjacent via explicit startDir never uses cwd", () => {
    const installRoot = makeTempDir();
    const cwdTemp = makeTempDir();
    const prev = process.cwd();
    try {
      writeFileSync(join(installRoot, "package.json"), JSON.stringify({ name: "omo-control-plane" }));
      const fakeExec = join(installRoot, "bin-exec");
      writeFileSync(fakeExec, "fake");
      const start = getDefaultOwlInstallSearchStartDir({
        isStandaloneExecutable: true,
        execPath: fakeExec,
      });
      process.chdir(cwdTemp);
      // Even after chdir, explicit start still resolves to installRoot
      expect(resolveOwlInstallDirectory(start)).toBe(realpathSync(installRoot));
      // And chdir'd cwd is not considered
      expect(start).not.toBe(realpathSync(cwdTemp));
    } finally {
      process.chdir(prev);
      cleanup(installRoot);
      cleanup(cwdTemp);
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

  test("non-empty XDG_CONFIG_HOME selects default config dir over ~/.config", () => {
    const xdg = makeTempDir();
    const project = makeTempDir();
    const xdgConfig = join(xdg, "opencode");
    try {
      mkdirSync(xdgConfig);
      const cfg = loadServerConfig({
        XDG_CONFIG_HOME: xdg,
        OMO_CP_PROJECT_DIR: project,
      });
      expect(cfg.opencodeConfigDir).toBe(realpathSync(xdgConfig));
    } finally {
      cleanup(xdg);
      cleanup(project);
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
