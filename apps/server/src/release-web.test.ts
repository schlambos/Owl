import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleReleaseWeb, type ReleaseWebConfig } from "./release-web";

function makeTempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "omo-release-web-")));
}

function cleanup(p: string) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {}
}

interface Fixture {
  install: string;
  web: string;
  cfg: ReleaseWebConfig;
  cleanup: () => void;
}

/**
 * Build a temp install root with a `<install>/web` directory containing a
 * built-app layout: index.html, an `assets/` subdir with a hashed JS/CSS
 * pair, and a nested SPA route directory. `authorizedRoots` mirrors the
 * production shape (install + project + config realpaths).
 */
function makeFixture(): Fixture {
  const install = makeTempDir();
  const project = makeTempDir();
  const config = makeTempDir();
  const web = join(install, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  mkdirSync(join(web, "agents"), { recursive: true });
  writeFileSync(join(web, "index.html"), "<!doctype html><div id=root></div>");
  writeFileSync(join(web, "assets", "app-abc123.js"), "console.log('app')");
  writeFileSync(join(web, "assets", "style-abc123.css"), "body{}");
  writeFileSync(join(web, "assets", "data.json"), '{"ok":true}');
  writeFileSync(join(web, "agents", "index.html"), "<!doctype html>agents");
  const cfg: ReleaseWebConfig = {
    owlInstallDirectory: install,
    authorizedRoots: [install, project, config],
  };
  return {
    install,
    web,
    cfg,
    cleanup: () => {
      cleanup(install);
      cleanup(project);
      cleanup(config);
    },
  };
}

function get(url: string, method = "GET"): Request {
  return new Request(`http://127.0.0.1:8787${url}`, { method });
}

describe("handleReleaseWeb", () => {
  test("absent web directory returns undefined (dev JSON 404 preserved)", () => {
    const install = makeTempDir();
    const project = makeTempDir();
    const config = makeTempDir();
    try {
      const cfg: ReleaseWebConfig = {
        owlInstallDirectory: install,
        authorizedRoots: [install, project, config],
      };
      expect(handleReleaseWeb(get("/"), cfg)).toBeUndefined();
      expect(handleReleaseWeb(get("/assets/app.js"), cfg)).toBeUndefined();
    } finally {
      cleanup(install);
      cleanup(project);
      cleanup(config);
    }
  });

  test("API and non-GET requests bypass", () => {
    const f = makeFixture();
    try {
      expect(handleReleaseWeb(get("/api/health"), f.cfg)).toBeUndefined();
      expect(handleReleaseWeb(get("/api"), f.cfg)).toBeUndefined();
      expect(handleReleaseWeb(get("/api/agents"), f.cfg)).toBeUndefined();
      expect(handleReleaseWeb(get("/", "POST"), f.cfg)).toBeUndefined();
      expect(handleReleaseWeb(get("/assets/app-abc123.js", "POST"), f.cfg)).toBeUndefined();
      expect(handleReleaseWeb(get("/", "PUT"), f.cfg)).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });

  test("root serves index.html with no-cache", async () => {
    const f = makeFixture();
    try {
      const res = handleReleaseWeb(get("/"), f.cfg)!;
      expect(res).toBeDefined();
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toContain("id=root");
    } finally {
      f.cleanup();
    }
  });

  test("extensionless SPA route serves index.html", async () => {
    const f = makeFixture();
    try {
      const res = handleReleaseWeb(get("/agents"), f.cfg)!;
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("id=root");
    } finally {
      f.cleanup();
    }
  });

  test("existing asset serves with correct MIME and immutable cache", async () => {
    const f = makeFixture();
    try {
      const js = handleReleaseWeb(get("/assets/app-abc123.js"), f.cfg)!;
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(js.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(await js.text()).toBe("console.log('app')");

      const css = handleReleaseWeb(get("/assets/style-abc123.css"), f.cfg)!;
      expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");

      const json = handleReleaseWeb(get("/assets/data.json"), f.cfg)!;
      expect(json.headers.get("content-type")).toBe("application/json; charset=utf-8");
    } finally {
      f.cleanup();
    }
  });

  test("HEAD returns no body", async () => {
    const f = makeFixture();
    try {
      const res = handleReleaseWeb(get("/", "HEAD"), f.cfg)!;
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");

      const asset = handleReleaseWeb(get("/assets/app-abc123.js", "HEAD"), f.cfg)!;
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(await asset.text()).toBe("");
    } finally {
      f.cleanup();
    }
  });

  test("missing extension path returns static 404", async () => {
    const f = makeFixture();
    try {
      const res = handleReleaseWeb(get("/assets/nope-xyz.js"), f.cfg)!;
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    } finally {
      f.cleanup();
    }
  });

  test("unknown extension returns static 404", async () => {
    const f = makeFixture();
    try {
      const res = handleReleaseWeb(get("/assets/file.unknown"), f.cfg)!;
      expect(res.status).toBe(404);
    } finally {
      f.cleanup();
    }
  });

  test("malformed percent-encoding returns 404", () => {
    const f = makeFixture();
    try {
      expect(handleReleaseWeb(get("/assets/%zz.js"), f.cfg)!.status).toBe(404);
    } finally {
      f.cleanup();
    }
  });

  test("traversal and dot segments are rejected", () => {
    const f = makeFixture();
    try {
      // Literal `..` is normalized away by URL parsing before we see it, so
      // assert the encoded forms that survive normalization.
      expect(handleReleaseWeb(get("/assets/%2e%2e/secret.js"), f.cfg)!.status).toBe(404);
      expect(handleReleaseWeb(get("/assets/%2e%2e%2fsecret.js"), f.cfg)!.status).toBe(404);
      expect(handleReleaseWeb(get("/assets/.%2e/secret.js"), f.cfg)!.status).toBe(404);
      expect(handleReleaseWeb(get("/assets/%2e./secret.js"), f.cfg)!.status).toBe(404);
      expect(handleReleaseWeb(get("/assets/%2e/secret.js"), f.cfg)!.status).toBe(404);
    } finally {
      f.cleanup();
    }
  });

  test("backslash and NUL are rejected", () => {
    const f = makeFixture();
    try {
      expect(handleReleaseWeb(get("/assets/foo%5cbar.js"), f.cfg)!.status).toBe(404);
      expect(handleReleaseWeb(get("/assets/foo%00bar.js"), f.cfg)!.status).toBe(404);
    } finally {
      f.cleanup();
    }
  });

  test("decoded slash is rejected", () => {
    const f = makeFixture();
    try {
      expect(handleReleaseWeb(get("/assets/foo%2fbar.js"), f.cfg)!.status).toBe(404);
    } finally {
      f.cleanup();
    }
  });

  test("dots inside filenames are allowed", async () => {
    const f = makeFixture();
    try {
      writeFileSync(join(f.web, "assets", "app.min.js"), "minified");
      const res = handleReleaseWeb(get("/assets/app.min.js"), f.cfg)!;
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("minified");
    } finally {
      f.cleanup();
    }
  });

  test("directory request returns 404", () => {
    const f = makeFixture();
    try {
      // A path with an extension that resolves to a directory must be
      // rejected (not served, not SPA-routed).
      mkdirSync(join(f.web, "assets", "dir.js"), { recursive: true });
      expect(handleReleaseWeb(get("/assets/dir.js"), f.cfg)!.status).toBe(404);
    } finally {
      f.cleanup();
    }
  });

  test("symlink escape is rejected", () => {
    const f = makeFixture();
    try {
      const outside = makeTempDir();
      try {
        writeFileSync(join(outside, "secret.js"), "secret");
        symlinkSync(outside, join(f.web, "assets", "escape"));
        expect(handleReleaseWeb(get("/assets/escape/secret.js"), f.cfg)!.status).toBe(404);
      } finally {
        cleanup(outside);
      }
    } finally {
      f.cleanup();
    }
  });

  test("web root symlink outside install is not served", () => {
    const install = makeTempDir();
    const project = makeTempDir();
    const config = makeTempDir();
    const outside = makeTempDir();
    try {
      mkdirSync(join(outside, "assets"), { recursive: true });
      writeFileSync(join(outside, "index.html"), "outside");
      writeFileSync(join(outside, "assets", "app.js"), "app");
      symlinkSync(outside, join(install, "web"));
      const cfg: ReleaseWebConfig = {
        owlInstallDirectory: install,
        authorizedRoots: [install, project, config],
      };
      expect(handleReleaseWeb(get("/"), cfg)).toBeUndefined();
    } finally {
      cleanup(install);
      cleanup(project);
      cleanup(config);
      cleanup(outside);
    }
  });

  test("web root symlink within install is served", async () => {
    const install = makeTempDir();
    const project = makeTempDir();
    const config = makeTempDir();
    try {
      const realWeb = join(install, "real-web");
      mkdirSync(realWeb, { recursive: true });
      writeFileSync(join(realWeb, "index.html"), "real");
      symlinkSync(realWeb, join(install, "web"));
      const cfg: ReleaseWebConfig = {
        owlInstallDirectory: install,
        authorizedRoots: [install, project, config],
      };
      const res = handleReleaseWeb(get("/"), cfg)!;
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("real");
    } finally {
      cleanup(install);
      cleanup(project);
      cleanup(config);
    }
  });
});
