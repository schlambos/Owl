/**
 * Targeted JSONC mutation preserving comments and unrelated structure.
 */

import {
  applyEdits,
  findNodeAtLocation,
  getNodePath,
  getNodeValue,
  modify,
  parse as parseJsonc,
  parseTree,
  printParseErrorCode,
  type JSONPath,
  type Node,
} from "jsonc-parser";
import { createHash } from "node:crypto";
import type { OmoFormat } from "@omo/shared";

export type { OmoFormat };

export type OmoParseIssueCode = "syntax-invalid" | "root-not-object";

export interface OmoParseIssue {
  code: OmoParseIssueCode;
  format: OmoFormat;
  offset?: number;
  length?: number;
  path: "";
  message: string;
}

export type OmoParseResult =
  | { ok: true; document: Record<string, unknown> }
  | { ok: false; issue: OmoParseIssue };

export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function parseConfigText(text: string): Record<string, unknown> {
  const errors: { error: number; offset: number; length: number }[] = [];
  const data = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new Error(
      `JSONC parse error at offset ${errors[0]!.offset}: code ${errors[0]!.error}`,
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Config root must be an object");
  }
  return data as Record<string, unknown>;
}

function jsonPosition(err: unknown): { offset?: number } {
  if (!(err instanceof SyntaxError)) return {};
  const match = /position\s+(\d+)/i.exec(err.message);
  if (!match) return {};
  return { offset: Number(match[1]) };
}

/**
 * Format-strict OMO document parser (Slice 18 D0).
 *
 * - `.json` uses native JSON.parse and rejects comments/trailing commas.
 * - `.jsonc` uses jsonc-parser and accepts comments/trailing commas.
 *
 * Existing writers keep `parseConfigText` (JSONC). Transaction producers
 * (D1+) must consume this function and never choose looser parsing.
 */
export function parseOmoDocument(
  text: string,
  format: OmoFormat,
): OmoParseResult {
  if (format === "json") {
    try {
      const data: unknown = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return {
          ok: false,
          issue: {
            code: "root-not-object",
            format,
            path: "",
            message: "Config root must be an object",
          },
        };
      }
      return { ok: true, document: data as Record<string, unknown> };
    } catch (e) {
      const pos = jsonPosition(e);
      return {
        ok: false,
        issue: {
          code: "syntax-invalid",
          format,
          path: "",
          message: `JSON parse error${
            pos.offset !== undefined ? ` at offset ${pos.offset}` : ""
          }: ${e instanceof Error ? e.message : String(e)}`,
          ...(pos.offset !== undefined ? { offset: pos.offset } : {}),
        },
      };
    }
  }

  const errors: { error: number; offset: number; length: number }[] = [];
  const data = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    const first = errors[0]!;
    return {
      ok: false,
      issue: {
        code: "syntax-invalid",
        format,
        path: "",
        offset: first.offset,
        length: first.length,
        message: `JSONC parse error at offset ${first.offset}: ${printParseErrorCode(first.error)}`,
      },
    };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      ok: false,
      issue: {
        code: "root-not-object",
        format,
        path: "",
        message: "Config root must be an object",
      },
    };
  }
  return { ok: true, document: data as Record<string, unknown> };
}

export function applyJsoncPathEdit(
  text: string,
  path: JSONPath,
  value: unknown,
): string {
  const edits = modify(text, path, value, {
    formattingOptions: {
      tabSize: 2,
      insertSpaces: true,
      eol: text.includes("\r\n") ? "\r\n" : "\n",
    },
    isArrayInsertion: false,
  });
  if (!edits.length && value !== undefined) {
    // path may already equal value
    const current = getAtPath(parseConfigText(text), path as string[]);
    if (JSON.stringify(current) === JSON.stringify(value)) return text;
  }
  return applyEdits(text, edits);
}

export function getAtPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Minimal unified diff for small config files */
export function unifiedDiff(
  before: string,
  after: string,
  fileLabel: string,
): string {
  if (before === after) return `(no textual change)`;
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const lines: string[] = [`--- a/${fileLabel}`, `+++ b/${fileLabel}`];
  // Simple LCS-free line diff for small files
  const max = Math.max(a.length, b.length);
  let i = 0;
  let j = 0;
  let hunk: string[] = [];
  const flush = () => {
    if (hunk.length) {
      lines.push(`@@`);
      lines.push(...hunk);
      hunk = [];
    }
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      // skip equal runs in output for brevity — show context 1
      hunk.push(` ${a[i]}`);
      i++;
      j++;
      // keep hunk small: if too many context-only, trim
      if (hunk.length > 40 && hunk.every((l) => l.startsWith(" "))) {
        hunk = hunk.slice(-3);
      }
      continue;
    }
    // find next sync
    if (j < b.length && (i >= a.length || !a.slice(i, i + 5).includes(b[j]!))) {
      hunk.push(`+${b[j]}`);
      j++;
      continue;
    }
    if (i < a.length) {
      hunk.push(`-${a[i]}`);
      i++;
      continue;
    }
  }
  flush();
  // Compact: only keep lines with + or - and nearby context
  const out: string[] = [lines[0]!, lines[1]!];
  const body = lines.slice(2);
  for (let k = 0; k < body.length; k++) {
    const line = body[k]!;
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith("@@")) {
      // prev context
      if (k > 0 && body[k - 1]!.startsWith(" ") && !out[out.length - 1]!.startsWith(" ")) {
        out.push(body[k - 1]!);
      }
      out.push(line);
      if (k + 1 < body.length && body[k + 1]!.startsWith(" ")) {
        out.push(body[k + 1]!);
      }
    }
  }
  if (out.length <= 2) {
    // fallback full
    return [
      `--- a/${fileLabel}`,
      `+++ b/${fileLabel}`,
      ...a.map((l) => `-${l}`),
      ...b.map((l) => `+${l}`),
    ].join("\n");
  }
  return out.join("\n");
}

export function emptyConfigDocument(format: "json" | "jsonc"): string {
  if (format === "jsonc") {
    return `{\n  // Created by OMO Control Plane\n}\n`;
  }
  return `{\n}\n`;
}

// ── Slice 17: managed plugin array insertion/removal ──────────────────
//
// Narrow helpers for adding/removing a single recognized bridge entry
// in the `plugin` array. Preserves comments, unknown fields, ordering,
// EOL, and trailing commas via jsonc-parser APIs. Never JSON.stringify
// the whole document.

/**
 * Find the AST node of a plugin array entry whose value (string or
 * object.path) matches `identity`. Returns the node and its array index,
 * or null when not found.
 */
export function findPluginEntryNode(
  text: string,
  identity: string,
): { node: Node; index: number } | null {
  const errors: { error: number; offset: number; length: number }[] = [];
  const root = parseTree(text, errors as never, { allowTrailingComma: true });
  if (errors.length || !root) return null;
  const pluginNode = findNodeAtLocation(root, ["plugin"]);
  if (!pluginNode || pluginNode.type !== "array") return null;
  const children = pluginNode.children ?? [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child) continue;
    // Use getNodeValue to get the parsed value (child.value is undefined
    // for object/array nodes in parseTree).
    const val = getNodeValue(child);
    if (typeof val === "string" && val === identity) {
      return { node: child, index: i };
    }
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const pathField = (val as Record<string, unknown>)["path"];
      if (typeof pathField === "string" && pathField === identity) {
        return { node: child, index: i };
      }
    }
  }
  return null;
}

/**
 * Insert a recognized bridge entry into the `plugin` array. If the
 * `plugin` property does not exist, it is created (with formatting).
 * If it exists as an array, the entry is inserted via narrow AST-span
 * patching to preserve the exact original formatting (comments,
 * indentation, EOL) of all surrounding content. If the entry already
 * exists (by identity), the text is returned unchanged.
 *
 * `entry` is the lexical identity string (e.g. an absolute path). The
 * entry is inserted as a bare string to match the canonical bridge form.
 */
export function applyPluginEntryAdd(
  text: string,
  identity: string,
): { text: string; alreadyPresent: boolean } {
  // Check existing first.
  const existing = findPluginEntryNode(text, identity);
  if (existing) return { text, alreadyPresent: true };

  // Determine if plugin array exists.
  const errors: { error: number; offset: number; length: number }[] = [];
  const root = parseTree(text, errors as never, { allowTrailingComma: true });
  if (errors.length || !root) {
    throw new Error("Cannot parse text for plugin entry add");
  }
  const pluginNode = findNodeAtLocation(root, ["plugin"]);

  const formattingOptions = {
    tabSize: 2,
    insertSpaces: true,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };

  if (!pluginNode) {
    // Create plugin array with the entry (no existing array to preserve).
    const edits = modify(text, ["plugin"], [identity], {
      formattingOptions,
      isArrayInsertion: false,
    });
    return { text: applyEdits(text, edits), alreadyPresent: false };
  }

  if (pluginNode.type !== "array") {
    throw new Error("plugin property exists but is not an array");
  }

  // Narrow AST-span insertion: find the closing bracket of the array
  // and insert the new entry before it, preserving surrounding text.
  // The pluginNode's range includes the brackets. The closing bracket
  // is at pluginNode.offset + pluginNode.length - 1.
  const closeBracketOffset = pluginNode.offset + pluginNode.length - 1;

  // Determine the indentation of existing entries (if any).
  const children = pluginNode.children ?? [];
  let insertion: string;
  if (children.length === 0) {
    // Empty array: insert with formatting.
    const edits = modify(text, ["plugin", 0], identity, {
      formattingOptions,
      isArrayInsertion: true,
    });
    return { text: applyEdits(text, edits), alreadyPresent: false };
  }

  // Find the indentation of the last entry to match it.
  const lastChild = children[children.length - 1]!;
  // Search backwards from lastChild.offset to find the start of the line
  // (the indentation).
  let lineStart = lastChild.offset;
  while (lineStart > 0 && text[lineStart - 1] !== "\n" && text[lineStart - 1] !== "\r") {
    lineStart--;
  }
  const indent = text.slice(lineStart, lastChild.offset);

  // Check if there's a comma after the last entry.
  let afterLast = lastChild.offset + lastChild.length;
  let hasTrailingComma = false;
  while (afterLast < closeBracketOffset) {
    const ch = text[afterLast];
    if (ch === ",") { hasTrailingComma = true; break; }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { afterLast++; continue; }
    break;
  }

  // Detect if the array is single-line (no newline between open bracket
  // and close bracket).
  const arrayContent = text.slice(pluginNode.offset, pluginNode.offset + pluginNode.length);
  const isSingleLine = !arrayContent.includes("\n") && !arrayContent.includes("\r");

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const quotedIdentity = JSON.stringify(identity);

  if (isSingleLine) {
    // Single-line array: insert without newlines.
    if (hasTrailingComma) {
      // Already has trailing comma: insert before closing bracket.
      // afterLast is at the comma. Insert after the comma.
      const insertPos = afterLast + 1; // after comma
      // Skip whitespace after comma.
      let wsEnd = insertPos;
      while (wsEnd < closeBracketOffset && (text[wsEnd] === " " || text[wsEnd] === "\t")) wsEnd++;
      const before = text.slice(0, insertPos);
      const after = text.slice(wsEnd);
      return {
        text: before + " " + quotedIdentity + after,
        alreadyPresent: false,
      };
    } else {
      // No trailing comma: add comma + entry.
      const before = text.slice(0, afterLast);
      const after = text.slice(afterLast);
      return {
        text: before + "," + quotedIdentity + after,
        alreadyPresent: false,
      };
    }
  }

  if (hasTrailingComma) {
    // Already has trailing comma after last entry; just insert the new
    // entry on its own line before the closing bracket.
    insertion = `${indent}${quotedIdentity},`;
    // Insert before the closing bracket, after the last newline before it.
    // Find the position just after the last newline before closeBracket.
    let insertPos = closeBracketOffset;
    while (insertPos > 0 && (text[insertPos - 1] === " " || text[insertPos - 1] === "\t")) {
      insertPos--;
    }
    // Now insertPos is at the start of the indentation before ].
    // We want to insert: indent + quotedIdentity + "," + eol + (indent before ])
    // But the indent before ] is already there. So insert:
    //   indent + quotedIdentity + "," + eol
    // at the position before the existing indent before ].
    // Actually, let's insert at the position right after the last newline
    // before the closing bracket's indentation.
    // Find the newline before the closing bracket indentation.
    let nlPos = insertPos;
    while (nlPos > 0 && text[nlPos - 1] !== "\n" && text[nlPos - 1] !== "\r") {
      nlPos--;
    }
    // Insert after the newline (at nlPos), the new entry line + eol.
    const before = text.slice(0, nlPos);
    const after = text.slice(nlPos);
    return {
      text: before + indent + quotedIdentity + "," + eol + after,
      alreadyPresent: false,
    };
  } else {
    // No trailing comma: add comma after last entry, then new entry.
    // Insert at afterLast (position right after last entry's content,
    // before any whitespace/comma).
    // Insert: "," + eol + indent + quotedIdentity
    const before = text.slice(0, afterLast);
    const after = text.slice(afterLast);
    return {
      text: before + "," + eol + indent + quotedIdentity + after,
      alreadyPresent: false,
    };
  }
}

/**
 * Remove a recognized bridge entry from the `plugin` array by identity.
 * Preserves all other entries, comments, and formatting. If the entry
 * is not found, returns text unchanged. If the array becomes empty, the
 * empty array is preserved (not removed) to avoid disturbing unrelated
 * structure.
 *
 * Uses AST span patching to remove the element + its preceding/following
 * comma, because jsonc-parser's `modify` with `undefined` at an array
 * index produces malformed output for array element removal.
 */
export function applyPluginEntryRemove(
  text: string,
  identity: string,
): { text: string; wasPresent: boolean } {
  const found = findPluginEntryNode(text, identity);
  if (!found) return { text, wasPresent: false };

  // Find the comma before or after this element to remove it cleanly.
  const { offset, length } = {
    offset: found.node.offset,
    length: found.node.length,
  };

  // Look backwards from the element offset for a comma (skipping
  // whitespace/comments).
  let removeStart = offset;
  let removeEnd = offset + length;
  let foundComma = false;

  // Search backwards for comma.
  for (let i = offset - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ",") {
      removeStart = i;
      foundComma = true;
      break;
    }
    if (ch === "[" || ch === "\n" || ch === " " || ch === "\t" || ch === "\r") {
      // Skip whitespace/newlines but stop at array start.
      if (ch === "[") break;
      continue;
    }
    // Comment or other content — stop searching backwards.
    break;
  }

  // If no comma before, search forwards for a comma after the element.
  if (!foundComma) {
    for (let i = offset + length; i < text.length; i++) {
      const ch = text[i];
      if (ch === ",") {
        removeEnd = i + 1;
        foundComma = true;
        break;
      }
      if (ch === "]" || ch === "\n" || ch === " " || ch === "\t" || ch === "\r") {
        if (ch === "]") break;
        continue;
      }
      break;
    }
  }

  // If we found a comma before, also trim trailing whitespace on the
  // line before the comma (to avoid leaving empty lines).
  if (foundComma && removeStart < offset) {
    // Trim whitespace/newlines before the comma.
    while (removeStart > 0 && /[\s]/.test(text[removeStart - 1]!)) {
      // Don't trim past the previous element or array start.
      const prevCh = text[removeStart - 1]!;
      if (prevCh === '"' || prevCh === "]" || prevCh === "}" || prevCh === "[") break;
      removeStart--;
    }
  }

  const patched = text.slice(0, removeStart) + text.slice(removeEnd);
  return { text: patched, wasPresent: true };
}

/**
 * Narrow AST-span fragment patch: replace only the byte range of a
 * plugin entry with new text. Used when modify cannot guarantee exact
 * restore of surrounding trivia. Returns the patched text.
 */
export function patchPluginEntrySpan(
  text: string,
  offset: number,
  length: number,
  replacement: string,
): string {
  return text.slice(0, offset) + replacement + text.slice(offset + length);
}

/**
 * Get the AST offset span of a plugin entry for patch metadata.
 */
export function pluginEntrySpan(
  text: string,
  identity: string,
): { offset: number; length: number } | null {
  const found = findPluginEntryNode(text, identity);
  if (!found) return null;
  return { offset: found.node.offset, length: found.node.length };
}
