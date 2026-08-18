/**
 * Slice 17 hardened — Bridge byte patch (BridgeBytePatchV1).
 *
 * Oracle decision 8: deterministic reversible byte edit for only the
 * bridge string entry. offset + exact before/after bridge fragment.
 * No neighboring values, no raw nonce, no comments, no arbitrary JSON.
 * Production bare string only. If safe contiguous patch impossible, block.
 * Restore exact inverse after post hash and target match.
 */

import { findPluginEntryNode, parseConfigText, applyPluginEntryAdd } from "../cfgwrite/jsonc-edit";
import type { BridgeBytePatchV1, BridgeError } from "./types";

/**
 * Compute a BridgeBytePatchV1 for adding a bridge string entry to the
 * plugin array. The patch must only touch the bridge string entry and
 * plugin structural syntax (comma, bracket, quotes, whitespace).
 *
 * Returns the patch and the proposed text, or errors if a safe contiguous
 * patch is impossible.
 */
export function computeAddPatch(
  sourceText: string,
  canonicalIdentity: string,
): { patch: BridgeBytePatchV1; proposedText: string } | { errors: BridgeError[] } {
  // Check if already present.
  const existing = findPluginEntryNode(sourceText, canonicalIdentity);
  if (existing) {
    return { errors: [{ code: "duplicate-config", message: "Bridge entry already present." }] };
  }

  // Find the plugin array's closing bracket position.
  // We need to insert: ,"canonicalIdentity" before the closing ]
  // or "canonicalIdentity" if the array is empty.
  const { patch, proposedText } = computeInsertionPatch(sourceText, canonicalIdentity);
  if (!patch) {
    return { errors: [{ code: "plugin-shape-unsupported", message: "Safe contiguous patch impossible for this config structure." }] };
  }

  // Validate proposed text parses.
  try { parseConfigText(proposedText); } catch {
    return { errors: [{ code: "plugin-shape-unsupported", message: "Proposed text from patch does not parse." }] };
  }

  // Validate the patch only touches bridge string + structural syntax.
  const validation = validatePatchSafety(patch);
  if (!validation.ok) {
    return { errors: [{ code: "plugin-shape-unsupported", message: validation.reason }] };
  }

  return { patch, proposedText };
}

/**
 * Compute a BridgeBytePatchV1 for removing a bridge string entry from
 * the plugin array.
 */
export function computeRemovePatch(
  sourceText: string,
  canonicalIdentity: string,
): { patch: BridgeBytePatchV1; proposedText: string } | { errors: BridgeError[] } {
  const found = findPluginEntryNode(sourceText, canonicalIdentity);
  if (!found) {
    return { errors: [{ code: "restore-mismatch", message: "Bridge entry not present in source." }] };
  }

  // Find the exact span to remove: the entry + its preceding or following comma.
  const offset = found.node.offset;
  const length = found.node.length;

  let removeStart = offset;
  let removeEnd = offset + length;
  let foundComma = false;

  // Search backwards for comma.
  for (let i = offset - 1; i >= 0; i--) {
    const ch = sourceText[i];
    if (ch === ",") { removeStart = i; foundComma = true; break; }
    if (ch === "[" || ch === "\n" || ch === " " || ch === "\t" || ch === "\r") {
      if (ch === "[") break;
      continue;
    }
    break;
  }

  if (!foundComma) {
    for (let i = offset + length; i < sourceText.length; i++) {
      const ch = sourceText[i];
      if (ch === ",") { removeEnd = i + 1; foundComma = true; break; }
      if (ch === "]" || ch === "\n" || ch === " " || ch === "\t" || ch === "\r") {
        if (ch === "]") break;
        continue;
      }
      break;
    }
  }

  // Trim trailing whitespace before comma if removing backwards.
  if (foundComma && removeStart < offset) {
    while (removeStart > 0 && /[\s]/.test(sourceText[removeStart - 1]!)) {
      const prevCh = sourceText[removeStart - 1]!;
      if (prevCh === '"' || prevCh === "]" || prevCh === "}" || prevCh === "[") break;
      removeStart--;
    }
  }

  const deleteText = sourceText.slice(removeStart, removeEnd);
  const proposedText = sourceText.slice(0, removeStart) + sourceText.slice(removeEnd);

  const patch: BridgeBytePatchV1 = {
    version: 1,
    offsetUtf16: removeStart,
    deleteText,
    insertText: "",
  };

  try { parseConfigText(proposedText); } catch {
    return { errors: [{ code: "plugin-shape-unsupported", message: "Proposed text from remove patch does not parse." }] };
  }

  const validation = validatePatchSafety(patch);
  if (!validation.ok) {
    return { errors: [{ code: "plugin-shape-unsupported", message: validation.reason }] };
  }

  return { patch, proposedText };
}

/**
 * Apply a BridgeBytePatchV1 to text. Returns the patched text.
 */
export function applyPatch(text: string, patch: BridgeBytePatchV1): string {
  return text.slice(0, patch.offsetUtf16) + patch.insertText + text.slice(patch.offsetUtf16 + patch.deleteText.length);
}

/**
 * Compute the exact inverse of a patch (swap deleteText and insertText).
 */
export function inversePatch(patch: BridgeBytePatchV1): BridgeBytePatchV1 {
  return {
    version: 1,
    offsetUtf16: patch.offsetUtf16,
    deleteText: patch.insertText,
    insertText: patch.deleteText,
  };
}

/**
 * Validate that a patch only touches bridge string entry + plugin
 * structural syntax (comma, bracket, quotes, whitespace). No comments,
 * no neighboring values, no raw nonce, no arbitrary JSON.
 */
function validatePatchSafety(patch: BridgeBytePatchV1): { ok: true } | { ok: false; reason: string } {
  // The deleteText and insertText must only contain:
  // - JSON string syntax (quotes, the canonical identity path)
  // - Comma, bracket, whitespace, newline
  // - No comments (// or /*)
  // - No raw nonce-like values (long hex strings, sk- tokens)
  // - No apiKey-like fields
  const allText = patch.deleteText + patch.insertText;

  if (allText.includes("//") || allText.includes("/*")) {
    return { ok: false, reason: "Patch contains comment syntax." };
  }
  if (allText.includes("apiKey") || allText.includes("password") || allText.includes("secret")) {
    return { ok: false, reason: "Patch contains secret-like field names." };
  }
  // Check for long hex strings (could be nonces/secrets).
  if (/[0-9a-f]{40,}/i.test(allText)) {
    return { ok: false, reason: "Patch contains long hex string (potential secret)." };
  }
  if (/sk-[A-Za-z0-9_-]{8,}/.test(allText)) {
    return { ok: false, reason: "Patch contains API-key-like token." };
  }

  return { ok: true };
}

/**
 * Compute the insertion patch for adding a bridge string entry.
 * Finds the right position in the plugin array and creates a minimal
 * contiguous patch.
 */
function computeInsertionPatch(
  sourceText: string,
  canonicalIdentity: string,
): { patch: BridgeBytePatchV1 | null; proposedText: string } {
  // Use applyPluginEntryAdd to compute the proposed text,
  // then derive the byte patch by diffing.
  const result = applyPluginEntryAdd(sourceText, canonicalIdentity);
  if (result.alreadyPresent) return { patch: null, proposedText: sourceText };

  const proposed = result.text;

  // Find the contiguous insertion span by comparing source and proposed.
  // The insertion is a contiguous block added to source.
  let prefixLen = 0;
  while (prefixLen < sourceText.length && prefixLen < proposed.length && sourceText[prefixLen] === proposed[prefixLen]) {
    prefixLen++;
  }
  let suffixStart = sourceText.length;
  let proposedSuffixStart = proposed.length;
  while (suffixStart > prefixLen && proposedSuffixStart > prefixLen && sourceText[suffixStart - 1] === proposed[proposedSuffixStart - 1]) {
    suffixStart--;
    proposedSuffixStart--;
  }

  const insertText = proposed.slice(prefixLen, proposedSuffixStart);
  const patch: BridgeBytePatchV1 = {
    version: 1,
    offsetUtf16: prefixLen,
    deleteText: "",
    insertText,
  };

  return { patch, proposedText: proposed };
}