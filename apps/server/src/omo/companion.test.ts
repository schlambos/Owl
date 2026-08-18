import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveProvenance } from "./provenance";
import {
  buildCompanionState,
  COMPANION_FIELDS,
  companionDefaultBinaryPath,
} from "./companion";

const ROOT = join(import.meta.dir, "../../test/companion-sandbox");

const VERIFIED_FIELDS_SORTED = [
  "binaryPath",
  "debug",
  "enabled",
  "gifPack",
  "loopStyle",
  "position",
  "size",
  "speed",
];

function setup(
  user?: Record<string, unknown>,
  project?: Record<string, unknown>,
) {
  rmSync(ROOT, { recursive: true, force: true });
  const userDir = join(ROOT, "cfg");
  const projDir = join(ROOT, "proj");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projDir, { recursive: true });
  mkdirSync(join(projDir, ".opencode"), { recursive: true });
  if (user) {
    writeFileSync(
      join(userDir, "oh-my-opencode-slim.json"),
      JSON.stringify(user, null, 2),
    );
  }
  if (project) {
    writeFileSync(
      join(projDir, ".opencode", "oh-my-opencode-slim.json"),
      JSON.stringify(project, null, 2),
    );
  }
  const bundle = resolveProvenance({
    opencodeConfigDir: userDir,
    projectDirectory: projDir,
    authorizedRoots: [userDir, projDir],
  });
  return { bundle, userDir, projDir };
}

describe("companion field catalog (source authority)", () => {
  test("exact 8-field catalog frozen, in order", () => {
    expect(Object.keys(COMPANION_FIELDS)).toEqual([
      "enabled",
      "binaryPath",
      "position",
      "size",
      "gifPack",
      "loopStyle",
      "speed",
      "debug",
    ]);
  });

  test("regression guard: exactly the verified installed fields", () => {
    expect([...Object.keys(COMPANION_FIELDS)].sort()).toEqual(
      VERIFIED_FIELDS_SORTED,
    );
  });

  test("verified defaults/enums/ranges", () => {
    expect(COMPANION_FIELDS.enabled?.defaultValue).toBe(false);
    expect(COMPANION_FIELDS.binaryPath?.defaultValue).toBeUndefined();
    expect(COMPANION_FIELDS.position?.enumValues).toEqual([
      "bottom-right",
      "bottom-left",
      "top-right",
      "top-left",
    ]);
    expect(COMPANION_FIELDS.size?.enumValues).toEqual(["small", "medium", "large"]);
    expect(COMPANION_FIELDS.gifPack?.enumValues).toEqual(["default"]);
    expect(COMPANION_FIELDS.loopStyle?.enumValues).toEqual(["classic", "smooth"]);
    expect(COMPANION_FIELDS.speed?.minimum).toBe(0.25);
    expect(COMPANION_FIELDS.speed?.maximum).toBe(4);
    expect(COMPANION_FIELDS.speed?.defaultValue).toBe(1);
    expect(COMPANION_FIELDS.debug?.defaultValue).toBe(false);
  });
});

describe("companion state: no config", () => {
  const { bundle, userDir, projDir } = setup();
  const st = buildCompanionState(bundle, projDir, [userDir, projDir], {});

  test("desired null, effective all defaults", () => {
    expect(st.desired).toBeNull();
    expect(st.effective.enabled).toBe(false);
    expect(st.effective.binaryPath).toBeUndefined();
    expect(st.effective.position).toBe("bottom-right");
    expect(st.effective.size).toBe("medium");
    expect(st.effective.gifPack).toBe("default");
    expect(st.effective.loopStyle).toBe("classic");
    expect(st.effective.speed).toBe(1);
    expect(st.effective.debug).toBe(false);
    expect(st.warnings).toEqual([]);
  });

  test("all 8 properties synthesized as builtin leaves", () => {
    for (const f of VERIFIED_FIELDS_SORTED) {
      const p = st.properties[`companion.${f}`];
      expect(p).toBeDefined();
      expect(p?.winner.stage).toBe("builtin");
      expect(p?.winner.sourceId).toBe("builtin");
      expect(p?.winner.sourceLabel).toBe("Built-in OMO default");
      expect(p?.winner.order).toBe(0);
      expect(p?.overridden).toEqual([]);
    }
    expect(st.properties["companion.enabled"]?.value).toBe(false);
    expect(st.properties["companion.speed"]?.value).toBe(1);
  });

  test("runtime observability unavailable", () => {
    expect(st.runtime.observable).toBe(false);
    expect(st.runtime.reasonUnavailable.length).toBeGreaterThan(0);
  });

  test("activation facts present", () => {
    expect(st.activation.some((l) => l.includes("restart required"))).toBe(true);
    expect(st.activation.some((l) => l.includes("PID lock"))).toBe(true);
    expect(st.activation.some((l) => l.includes("no-op"))).toBe(true);
  });

  test("default binary path outside roots → never probed", () => {
    let calls = 0;
    const s = buildCompanionState(bundle, projDir, [userDir, projDir], {}, {
      existsProbe: () => {
        calls++;
        return true;
      },
    });
    expect(s.binary.resolutionSource).toBe("default");
    expect(s.binary.withinAuthorizedScope).toBe(false);
    expect(s.binary.inspected).toBe(false);
    expect(s.binary.exists).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("companion state: user-only config", () => {
  const { bundle, userDir, projDir } = setup({
    companion: { enabled: true, speed: 2, position: "top-left" },
  });
  const st = buildCompanionState(bundle, projDir, [userDir, projDir], {});

  test("effective reflects user values", () => {
    expect(st.effective.enabled).toBe(true);
    expect(st.effective.speed).toBe(2);
    expect(st.effective.position).toBe("top-left");
    expect(st.effective.size).toBe("medium");
  });

  test("provenance winners user-config", () => {
    expect(st.properties["companion.speed"]?.winner.stage).toBe("user-config");
    expect(st.properties["companion.position"]?.winner.stage).toBe("user-config");
    expect(st.properties["companion.size"]?.winner.stage).toBe("builtin");
  });

  test("raw fragments user-only", () => {
    expect(st.raw.user).toEqual({ enabled: true, speed: 2, position: "top-left" });
    expect(st.raw.project).toBeUndefined();
  });
});

describe("companion state: project overrides user", () => {
  const { bundle, userDir, projDir } = setup(
    { companion: { speed: 2, position: "top-left" } },
    { companion: { speed: 3 } },
  );
  const st = buildCompanionState(bundle, projDir, [userDir, projDir], {});

  test("merged effective: speed from project, position from user", () => {
    expect(st.effective.speed).toBe(3);
    expect(st.effective.position).toBe("top-left");
  });

  test("per-leaf provenance winners", () => {
    const speed = st.properties["companion.speed"];
    expect(speed?.winner.stage).toBe("project-config");
    expect(speed?.overridden.some((o) => o.stage === "user-config" && o.value === 2)).toBe(true);
    expect(st.properties["companion.position"]?.winner.stage).toBe("user-config");
  });

  test("raw fragments per scope", () => {
    expect(st.raw.user).toEqual({ speed: 2, position: "top-left" });
    expect(st.raw.project).toEqual({ speed: 3 });
  });
});

describe("companion state: unknown raw fields", () => {
  const { bundle, userDir, projDir } = setup({
    companion: { fooBar: true, enabled: true },
  });
  const st = buildCompanionState(bundle, projDir, [userDir, projDir], {});

  test("preserved in raw, not surfaced in effective/fields", () => {
    expect(st.raw.user?.fooBar).toBe(true);
    expect("fooBar" in st.effective).toBe(false);
    expect("fooBar" in st.fields).toBe(false);
    expect(st.properties["companion.fooBar"]).toBeUndefined();
    expect(st.effective.enabled).toBe(true);
  });
});

describe("companion state: invalid values warn + fall back", () => {
  const { bundle, userDir, projDir } = setup({
    companion: { position: "sideways", speed: 99, enabled: "yes", debug: 1 },
  });
  const st = buildCompanionState(bundle, projDir, [userDir, projDir], {});

  test("effective falls back to defaults", () => {
    expect(st.effective.position).toBe("bottom-right");
    expect(st.effective.speed).toBe(1);
    expect(st.effective.enabled).toBe(false);
    expect(st.effective.debug).toBe(false);
  });

  test("warnings emitted", () => {
    expect(st.warnings.some((w) => w.includes("position"))).toBe(true);
    expect(st.warnings.some((w) => w.includes("speed"))).toBe(true);
    expect(st.warnings.some((w) => w.includes("enabled"))).toBe(true);
    expect(st.warnings.some((w) => w.includes("debug"))).toBe(true);
  });
});

describe("companion binary resolution boundary", () => {
  test("configured binaryPath outside roots → exists null, probe NOT called", () => {
    const { bundle, userDir, projDir } = setup({
      companion: { enabled: true, binaryPath: "/opt/companion/bin/outside" },
    });
    let calls = 0;
    const st = buildCompanionState(bundle, projDir, [userDir, projDir], {}, {
      existsProbe: () => {
        calls++;
        return true;
      },
    });
    expect(st.binary.configuredPath).toBe("/opt/companion/bin/outside");
    expect(st.binary.resolutionSource).toBe("configured");
    expect(st.binary.withinAuthorizedScope).toBe(false);
    expect(st.binary.inspected).toBe(false);
    expect(st.binary.exists).toBeNull();
    expect(calls).toBe(0);
  });

  test("configured binaryPath inside roots → probe called once, exists reported", () => {
    const bin = join(ROOT, "proj", "bin", "companion");
    const { bundle, userDir, projDir } = setup({
      companion: { enabled: true, binaryPath: bin },
    });
    const seen: string[] = [];
    const st = buildCompanionState(bundle, projDir, [userDir, projDir], {}, {
      existsProbe: (p) => {
        seen.push(p);
        return true;
      },
    });
    expect(st.binary.withinAuthorizedScope).toBe(true);
    expect(st.binary.inspected).toBe(true);
    expect(st.binary.exists).toBe(true);
    expect(seen).toEqual([bin]);

    const stMissing = buildCompanionState(bundle, projDir, [userDir, projDir], {}, {
      existsProbe: () => false,
    });
    expect(stMissing.binary.exists).toBe(false);
    expect(stMissing.binary.inspected).toBe(true);
  });

  test("default path honors absolute XDG_DATA_HOME", () => {
    expect(companionDefaultBinaryPath({ XDG_DATA_HOME: "/xdg/data" })).toBe(
      join("/xdg/data", "opencode", "storage", "oh-my-opencode-slim", "bin", "oh-my-opencode-slim-companion") +
        (process.platform === "win32" ? ".exe" : ""),
    );
  });

  test("default path falls back to ~/.local/share for relative/unset XDG", () => {
    const expectedBase = join(
      homedir(),
      ".local",
      "share",
      "opencode",
      "storage",
      "oh-my-opencode-slim",
      "bin",
    );
    expect(companionDefaultBinaryPath({}).startsWith(expectedBase)).toBe(true);
    expect(
      companionDefaultBinaryPath({ XDG_DATA_HOME: "relative/xdg" }).startsWith(
        expectedBase,
      ),
    ).toBe(true);
  });
});
