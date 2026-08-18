import { describe, expect, test } from "bun:test";
import {
  buildActivity,
  extractInitialInstruction,
  normalizeDiff,
  normalizeMessage,
  normalizeMessages,
  normalizePart,
  summarizeToolInput,
  truncate,
} from "./normalize";

describe("truncate", () => {
  test("short unchanged", () => {
    expect(truncate("abc", 10)).toEqual({ text: "abc", truncated: false });
  });
  test("long truncated", () => {
    const r = truncate("x".repeat(20), 10);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("xxxxxxxxxx")).toBe(true);
  });
});

describe("summarizeToolInput", () => {
  test("filePath", () => {
    expect(summarizeToolInput({ filePath: "/a/b.ts" })).toBe(
      "filePath: /a/b.ts",
    );
  });
  test("unknown object", () => {
    const s = summarizeToolInput({ foo: 1 });
    expect(s).toContain("foo");
  });
  test("null", () => {
    expect(summarizeToolInput(null)).toBeUndefined();
  });
});

describe("normalizePart", () => {
  test("text", () => {
    const p = normalizePart({
      id: "prt_1",
      type: "text",
      text: "hello",
    });
    expect(p.kind).toBe("text");
    expect(p.text).toBe("hello");
  });

  test("unknown type preserved", () => {
    const p = normalizePart({ id: "prt_x", type: "future-thing", z: 1 });
    expect(p.kind).toBe("unknown");
    expect(p.rawType).toBe("future-thing");
  });

  test("tool completed", () => {
    const p = normalizePart({
      id: "prt_t",
      type: "tool",
      tool: "read",
      callID: "c1",
      state: {
        status: "completed",
        input: { filePath: "src/a.ts" },
        output: "ok",
        title: "a.ts",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    });
    expect(p.kind).toBe("tool");
    expect(p.tool?.name).toBe("read");
    expect(p.tool?.status).toBe("completed");
    expect(p.tool?.inputSummary).toContain("src/a.ts");
  });
});

describe("normalizeMessage", () => {
  test("envelope info+parts user", () => {
    const m = normalizeMessage({
      info: {
        id: "msg_1",
        role: "user",
        agent: "explorer",
        time: { created: 100 },
        model: { providerID: "xai", modelID: "grok" },
      },
      parts: [{ id: "prt_1", type: "text", text: "do the thing" }],
    });
    expect(m.role).toBe("user");
    expect(m.agent).toBe("explorer");
    expect(m.preview).toContain("do the thing");
    expect(m.parts).toHaveLength(1);
  });

  test("empty parts", () => {
    const m = normalizeMessage({
      info: { id: "msg_2", role: "assistant", time: { created: 1 } },
      parts: [],
    });
    expect(m.parts).toEqual([]);
    expect(m.preview).toBeUndefined();
  });
});

describe("normalizeMessages + initial instruction", () => {
  test("extracts first user text", () => {
    const msgs = normalizeMessages([
      {
        info: { id: "m1", role: "user", time: { created: 1 } },
        parts: [{ id: "p1", type: "text", text: "TASK BODY", synthetic: false }],
      },
      {
        info: { id: "m2", role: "assistant", time: { created: 2 } },
        parts: [{ id: "p2", type: "text", text: "ok" }],
      },
    ]);
    const init = extractInitialInstruction(msgs);
    expect(init.text).toBe("TASK BODY");
    expect(init.label).toContain("delegation");
  });

  test("skips synthetic", () => {
    const msgs = normalizeMessages([
      {
        info: { id: "m1", role: "user", time: { created: 1 } },
        parts: [{ id: "p1", type: "text", text: "sys", synthetic: true }],
      },
      {
        info: { id: "m2", role: "user", time: { created: 2 } },
        parts: [{ id: "p2", type: "text", text: "real" }],
      },
    ]);
    expect(extractInitialInstruction(msgs).text).toBe("real");
  });

  test("large list", () => {
    const raw = Array.from({ length: 200 }, (_, i) => ({
      info: { id: `msg_${i}`, role: i % 2 ? "assistant" : "user", time: { created: i } },
      parts: [{ id: `prt_${i}`, type: "text", text: `n${i}` }],
    }));
    const msgs = normalizeMessages(raw);
    expect(msgs).toHaveLength(200);
  });
});

describe("buildActivity", () => {
  test("tools become activity", () => {
    const msgs = normalizeMessages([
      {
        info: { id: "m1", role: "assistant", time: { created: 10 } },
        parts: [
          {
            id: "pt",
            type: "tool",
            tool: "grep",
            state: {
              status: "completed",
              input: { pattern: "foo" },
              output: "1",
              title: "grep",
              metadata: {},
              time: { start: 11, end: 12 },
            },
          },
        ],
      },
    ]);
    const act = buildActivity(msgs);
    expect(act.some((a) => a.label === "grep")).toBe(true);
  });
});

describe("normalizeDiff", () => {
  test("empty array", () => {
    const d = normalizeDiff([]);
    expect(d.empty).toBe(true);
  });

  test("file list", () => {
    const d = normalizeDiff([
      {
        file: "a.ts",
        patch: "@@",
        additions: 2,
        deletions: 1,
        status: "modified",
      },
    ]);
    expect(d.empty).toBe(false);
    expect(d.totalAdditions).toBe(2);
    expect(d.files[0]?.file).toBe("a.ts");
  });

  test("null", () => {
    expect(normalizeDiff(null).empty).toBe(true);
  });
});

describe("parent/child navigation data shape", () => {
  test("session detail fields optional-safe", () => {
    // Ensures DTO consumers tolerate missing cost/tokens
    const msgs = normalizeMessages([]);
    expect(msgs).toEqual([]);
    const init = extractInitialInstruction(msgs);
    expect(init.text).toBeUndefined();
  });
});
