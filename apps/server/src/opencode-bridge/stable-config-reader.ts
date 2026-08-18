/**
 * Descriptor-stable config reader (Oracle drift-acceptance remediation).
 *
 * ONE shared primitive for reading a committed config target when a plain
 * pathname hash is not sufficient authorization. Used by the drift
 * preview/apply proof, post-commit verification, BridgeService
 * reconciliation reads of the committed target, and the launch boundary.
 *
 * Discipline:
 *  - `lstat` BEFORE open (symlink / non-regular rejected before open, so a
 *    FIFO or device can never block the open).
 *  - `openSync(path, O_RDONLY | O_NOFOLLOW)` — fails explicitly when
 *    O_NOFOLLOW is unavailable on the platform.
 *  - `fstat` the descriptor: regular file only, bounded size; descriptor
 *    dev/ino must equal the path's dev/ino (same file, not a replacement).
 *  - Bytes are read from the DESCRIPTOR ONLY — a path replacement or
 *    symlink swap after open can never change what is read.
 *  - Fatal UTF-8 decode (TextDecoder fatal): invalid bytes fail.
 *  - lstat/realpath captured before AND after; dev/ino/mode/type/size must
 *    be stable; the authorized realpath/root check is re-run after the read.
 *  - Hash is computed over the descriptor bytes.
 *  - The descriptor is always closed in `finally`.
 *
 * An injectable file-ops seam allows deterministic race tests; the
 * production default is strict node:fs. Failures return stable reason
 * strings — never raw error messages or paths beyond the caller's own.
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { createHash } from "node:crypto";
import { isWithinRoots } from "./canonical";

export interface StableReadFileOps {
  lstatSync(path: string): Stats;
  realpathSync(path: string): string;
  existsSync(path: string): boolean;
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): Stats;
  /**
   * Read ALL bytes from the descriptor, at most `maxBytes`. Must throw a
   * RangeError("overflow") when the descriptor supplies MORE than maxBytes
   * (a growing file), and never allocate unboundedly.
   */
  readFdSync(fd: number, maxBytes: number): Buffer;
  closeSync(fd: number): void;
}

/**
 * Bounded descriptor read: reads at most maxBytes+1 bytes; throws
 * RangeError("overflow") the moment the descriptor supplies more than
 * maxBytes — even when fstat reported a smaller size (growing file).
 */
function boundedReadFd(fd: number, maxBytes: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  const chunkSize = Math.min(64 * 1024, Math.max(1, maxBytes + 1));
  const chunk = Buffer.allocUnsafe(chunkSize);
  for (;;) {
    const remaining = maxBytes + 1 - total;
    const n = readSync(fd, chunk, 0, Math.min(chunkSize, remaining), null);
    if (n <= 0) break;
    total += n;
    if (total > maxBytes) throw new RangeError("overflow");
    chunks.push(Buffer.from(chunk.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}

const defaultOps: StableReadFileOps = {
  lstatSync,
  realpathSync,
  existsSync,
  openSync,
  fstatSync,
  readFdSync: boundedReadFd,
  closeSync,
};

export type StableReadFailureReason =
  | "missing"
  | "symlink"
  | "not-regular"
  | "too-large"
  | "empty"
  | "nofollow-unavailable"
  | "open-failed"
  | "stat-failed"
  | "read-failed"
  | "not-utf8"
  | "changed-during-read"
  | "root-escape";

export type StableReadResult =
  | {
      ok: true;
      text: string;
      /** SHA-256 hex over the descriptor bytes. */
      hash: string;
      realpath: string;
      size: number;
      mode: number;
    }
  | { ok: false; reason: StableReadFailureReason };

export interface StableReadOptions {
  /** Maximum accepted file size in bytes. */
  maxBytes: number;
  /** Authorized roots (realpath'd inside this function). */
  authorizedRoots: string[];
}

function realRootsOf(roots: string[]): string[] {
  return roots.map((r) => {
    try {
      if (existsSync(r)) return realpathSync(r);
    } catch {
      /* fall through */
    }
    return r;
  });
}

/**
 * Read a config file with descriptor-stable proof. Never follows a
 * replacement or symlink; never blocks on non-regular files.
 */
export function stableReadConfigFile(
  path: string,
  opts: StableReadOptions,
  ops: StableReadFileOps = defaultOps,
): StableReadResult {
  const realRoots = realRootsOf(opts.authorizedRoots);

  // lstat BEFORE open: symlink / non-regular rejected without opening (a
  // FIFO or device can never block us).
  let before: Stats;
  try {
    if (!ops.existsSync(path)) return { ok: false, reason: "missing" };
    before = ops.lstatSync(path);
  } catch {
    return { ok: false, reason: "stat-failed" };
  }
  if (before.isSymbolicLink()) return { ok: false, reason: "symlink" };
  if (!before.isFile()) return { ok: false, reason: "not-regular" };
  if (before.size > opts.maxBytes) return { ok: false, reason: "too-large" };
  if (before.size === 0) return { ok: false, reason: "empty" };

  let realBefore: string;
  try {
    realBefore = ops.realpathSync(path);
  } catch {
    return { ok: false, reason: "stat-failed" };
  }
  if (!isWithinRoots(realBefore, realRoots)) {
    return { ok: false, reason: "root-escape" };
  }

  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    return { ok: false, reason: "nofollow-unavailable" };
  }

  let fd: number | undefined;
  try {
    try {
      fd = ops.openSync(path, fsConstants.O_RDONLY | noFollow);
    } catch {
      return { ok: false, reason: "open-failed" };
    }

    // fstat the descriptor: regular only, bounded, and the SAME file the
    // path resolved to (dev/ino parity), not a replacement.
    let fst: Stats;
    try {
      fst = ops.fstatSync(fd);
    } catch {
      return { ok: false, reason: "stat-failed" };
    }
    if (!fst.isFile()) return { ok: false, reason: "not-regular" };
    if (fst.dev !== before.dev || fst.ino !== before.ino) {
      return { ok: false, reason: "changed-during-read" };
    }
    if (fst.size > opts.maxBytes) return { ok: false, reason: "too-large" };
    if (fst.size !== before.size || fst.mode !== before.mode) {
      return { ok: false, reason: "changed-during-read" };
    }

    // Read bytes from the descriptor ONLY, bounded — a file that grows past
    // the limit after fstat is rejected.
    let bytes: Buffer;
    try {
      bytes = ops.readFdSync(fd, opts.maxBytes);
    } catch (e) {
      if (e instanceof RangeError) return { ok: false, reason: "too-large" };
      return { ok: false, reason: "read-failed" };
    }
    if (bytes.length > opts.maxBytes) return { ok: false, reason: "too-large" };

    // Fatal UTF-8 decode.
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, reason: "not-utf8" };
    }

    // Post-read path stability + root recheck.
    let after: Stats;
    let realAfter: string;
    try {
      after = ops.lstatSync(path);
      realAfter = ops.realpathSync(path);
    } catch {
      return { ok: false, reason: "stat-failed" };
    }
    // Root recheck first: a post-read realpath outside the authorized
    // roots is a root escape regardless of other stability signals.
    if (!isWithinRoots(realAfter, realRoots)) {
      return { ok: false, reason: "root-escape" };
    }
    if (
      after.dev !== fst.dev ||
      after.ino !== fst.ino ||
      after.mode !== fst.mode ||
      after.size !== fst.size ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      realAfter !== realBefore
    ) {
      return { ok: false, reason: "changed-during-read" };
    }

    const hash = createHash("sha256").update(bytes).digest("hex");
    return {
      ok: true,
      text,
      hash,
      realpath: realAfter,
      size: fst.size,
      mode: fst.mode & 0o777,
    };
  } finally {
    if (fd !== undefined) {
      try {
        ops.closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
}
