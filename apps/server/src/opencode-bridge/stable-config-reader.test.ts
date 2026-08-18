/**
 * Descriptor-stable config reader tests. Real temp files for the happy path
 * and simple rejections; an injectable file-ops seam for deterministic race
 * scenarios (swap/replacement/root-escape mid-read). No FIFO is ever opened
 * (lstat rejects non-regular files before open).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  stableReadConfigFile,
  type StableReadFileOps,
} from "./stable-config-reader";

let sandbox: string;
let roots: string[];

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "omo-stable-"));
  roots = [sandbox];
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function realFile(content = `{"plugin": []}`): string {
  const p = join(sandbox, "opencode.json");
  writeFileSync(p, content, "utf-8");
  return p;
}

/** Clone a Stats object preserving its prototype methods. */
function cloneStats(st: import("node:fs").Stats, patch: Record<string, unknown>): import("node:fs").Stats {
  const clone = Object.assign(Object.create(Object.getPrototypeOf(st)), st, patch);
  return clone as import("node:fs").Stats;
}

/** Build a seam around the real fs with per-call overrides. */
function seam(overrides: Partial<StableReadFileOps>): StableReadFileOps {
  const base: StableReadFileOps = {
    lstatSync,
    realpathSync,
    existsSync: (p) => {
      try {
        lstatSync(p);
        return true;
      } catch {
        return false;
      }
    },
    openSync: (p, flags) => {
      const { openSync } = require("node:fs") as typeof import("node:fs");
      return openSync(p, flags);
    },
    fstatSync: (fd) => {
      const { fstatSync } = require("node:fs") as typeof import("node:fs");
      return fstatSync(fd);
    },
    readFdSync: (fd) => {
      const { readFileSync } = require("node:fs") as typeof import("node:fs");
      return readFileSync(fd);
    },
    closeSync: (fd) => {
      const { closeSync } = require("node:fs") as typeof import("node:fs");
      closeSync(fd);
    },
  };
  return { ...base, ...overrides };
}

describe("stable-config-reader: real files", () => {
  test("happy path: hash, text, realpath, size, mode", () => {
    const p = realFile();
    const r = stableReadConfigFile(p, { maxBytes: 4096, authorizedRoots: roots });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe(`{"plugin": []}`);
    expect(r.hash).toBe(createHash("sha256").update(`{"plugin": []}`).digest("hex"));
    expect(r.realpath).toBe(realpathSync(p));
    expect(r.size).toBe(Buffer.byteLength(`{"plugin": []}`));
    expect(r.mode).toBe(lstatSync(p).mode & 0o777);
  });

  test("symlink rejected before open (same content does not matter)", () => {
    const real = realFile();
    const link = join(sandbox, "link.json");
    symlinkSync(real, link);
    const r = stableReadConfigFile(link, { maxBytes: 4096, authorizedRoots: roots });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("symlink");
  });

  test("directory (non-regular) rejected without opening", () => {
    const dir = join(sandbox, "adir");
    mkdirSync(dir);
    const r = stableReadConfigFile(dir, { maxBytes: 4096, authorizedRoots: roots });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not-regular");
  });

  test("missing file", () => {
    const r = stableReadConfigFile(join(sandbox, "nope.json"), { maxBytes: 4096, authorizedRoots: roots });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("missing");
  });

  test("oversize rejected", () => {
    const p = realFile("x".repeat(5000));
    const r = stableReadConfigFile(p, { maxBytes: 4096, authorizedRoots: roots });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("too-large");
  });

  test("invalid UTF-8 rejected (fatal decode)", () => {
    const p = join(sandbox, "bad.json");
    writeFileSync(p, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    const r = stableReadConfigFile(p, { maxBytes: 4096, authorizedRoots: roots });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not-utf8");
  });

  test("root escape rejected", () => {
    const p = realFile();
    const r = stableReadConfigFile(p, { maxBytes: 4096, authorizedRoots: [join(sandbox, "elsewhere")] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("root-escape");
  });
});

describe("stable-config-reader: deterministic race seams", () => {
  test("inode replacement between lstat and fstat → changed-during-read", () => {
    const p = realFile();
    const ops = seam({
      fstatSync: (fd) => {
        const { fstatSync } = require("node:fs") as typeof import("node:fs");
        const st = fstatSync(fd);
        // Simulate a different inode on the descriptor.
        return cloneStats(st, { ino: st.ino + 1 });
      },
    });
    const r = stableReadConfigFile(p, { maxBytes: 4096, authorizedRoots: roots }, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("changed-during-read");
  });

  test("nonregular swap: lstat regular but fstat FIFO → not-regular (never blocks)", () => {
    const p = realFile();
    const ops = seam({
      fstatSync: (fd) => {
        const { fstatSync } = require("node:fs") as typeof import("node:fs");
        const st = fstatSync(fd);
        return cloneStats(st, { isFile: () => false, isFIFO: () => true });
      },
    });
    const r = stableReadConfigFile(p, { maxBytes: 4096, authorizedRoots: roots }, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not-regular");
  });

  test("inode replacement during read (after-read lstat differs) → changed-during-read", () => {
    const p = realFile();
    let lstatCalls = 0;
    const ops = seam({
      lstatSync: (path) => {
        lstatCalls++;
        const st = lstatSync(path);
        if (lstatCalls === 1) return st; // before-open: the real file
        // After-read: simulate a swapped inode.
        return cloneStats(st, { ino: st.ino + 7 });
      },
    });
    const r = stableReadConfigFile(p, { maxBytes: 4096, authorizedRoots: roots }, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("changed-during-read");
  });

  test("root escape after initial authorization (realpath flips) → root-escape", () => {
    const p = realFile();
    let realpathCalls = 0;
    const ops = seam({
      realpathSync: (path) => {
        realpathCalls++;
        if (realpathCalls === 1) return realpathSync(path);
        return "/etc/passwd"; // post-read realpath escapes roots
      },
    });
    const r = stableReadConfigFile(p, { maxBytes: 4096, authorizedRoots: roots }, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("root-escape");
  });

  test("same-hash symlink swap after open is irrelevant — descriptor bytes win", () => {
    // After a successful open, replacing the PATH with a symlink to identical
    // content must not change what was read; but the after-read lstat detects
    // the type change and fails closed.
    const p = realFile();
    const real = lstatSync(p);
    let lstatCalls = 0;
    const ops = seam({
      lstatSync: (path) => {
        lstatCalls++;
        if (lstatCalls === 1) return real;
        // After-read: path now reports as a symlink.
        return cloneStats(real, { isSymbolicLink: () => true });
      },
    });
    const r = stableReadConfigFile(p, { maxBytes: 4096, authorizedRoots: roots }, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("changed-during-read");
  });

  test("descriptor is closed even on read failure", () => {
    const p = realFile();
    let closed = 0;
    const ops = seam({
      readFdSync: () => {
        throw new Error("read boom");
      },
      closeSync: (fd) => {
        closed++;
        const { closeSync } = require("node:fs") as typeof import("node:fs");
        closeSync(fd);
      },
    });
    const r = stableReadConfigFile(p, { maxBytes: 4096, authorizedRoots: roots }, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("read-failed");
    expect(closed).toBe(1);
  });

  test("O_NOFOLLOW is used for the open", () => {
    const p = realFile();
    let seenFlags = 0;
    const ops = seam({
      openSync: (path, flags) => {
        seenFlags = flags;
        const { openSync } = require("node:fs") as typeof import("node:fs");
        return openSync(path, flags);
      },
    });
    const r = stableReadConfigFile(p, { maxBytes: 4096, authorizedRoots: roots }, ops);
    expect(r.ok).toBe(true);
    expect(seenFlags & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
    expect(seenFlags & fsConstants.O_RDONLY).toBe(fsConstants.O_RDONLY);
  });
});
