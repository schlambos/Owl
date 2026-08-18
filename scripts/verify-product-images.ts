#!/usr/bin/env bun
/**
 * Verify the three public README product screenshots.
 *
 * Checks, per PNG under docs/images/product:
 *   1. PNG signature (8-byte magic).
 *   2. Dimensions from IHDR (expected 1440x1000).
 *   3. Rejects metadata chunks: eXIf, tEXt, zTXt, iTXt, tIME.
 * Reports SHA-256 for each file. Exits non-zero on any failure.
 *
 * Dependency-free; run with `bun run scripts/verify-product-images.ts`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "docs", "images", "product");

const EXPECTED_WIDTH = 1440;
const EXPECTED_HEIGHT = 1000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FORBIDDEN_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

const FILES = [
  "owl-overview.png",
  "owl-agents.png",
  "owl-config-or-sessions.png",
];

interface CheckFailure {
  file: string;
  reason: string;
}

let failures: CheckFailure[] = [];

for (const name of FILES) {
  const path = join(DIR, name);
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err) {
    failures.push({ file: name, reason: `unreadable: ${String(err)}` });
    continue;
  }

  const sha256 = createHash("sha256").update(buf).digest("hex");

  // 1. Signature
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    failures.push({ file: name, reason: "invalid PNG signature" });
    console.log(`FAIL ${name} (sha256 ${sha256}): invalid PNG signature`);
    continue;
  }

  // Walk chunks: [length:4][type:4][data:length][crc:4]
  let width: number | undefined;
  let height: number | undefined;
  const rejected: string[] = [];
  let offset = 8;
  let malformed = false;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IHDR") {
      if (offset + 8 + 8 > buf.length) {
        malformed = true;
        break;
      }
      width = buf.readUInt32BE(offset + 8);
      height = buf.readUInt32BE(offset + 12);
    }
    if (FORBIDDEN_CHUNKS.has(type)) rejected.push(type);
    const next = offset + 12 + length;
    if (length > 0x7fffffff || next > buf.length) {
      malformed = true;
      break;
    }
    offset = next;
    if (type === "IEND") break;
  }

  const problems: string[] = [];
  if (malformed) problems.push("malformed chunk structure");
  if (width === undefined || height === undefined) {
    problems.push("missing IHDR dimensions");
  } else if (width !== EXPECTED_WIDTH || height !== EXPECTED_HEIGHT) {
    problems.push(`dimensions ${width}x${height}, expected ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}`);
  }
  if (rejected.length > 0) {
    problems.push(`forbidden metadata chunks: ${rejected.join(", ")}`);
  }

  if (problems.length > 0) {
    for (const reason of problems) failures.push({ file: name, reason });
    console.log(`FAIL ${name} (sha256 ${sha256}): ${problems.join("; ")}`);
  } else {
    console.log(`ok   ${name}  ${width}x${height}  sha256 ${sha256}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll product images verified.");
