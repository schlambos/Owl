import { useEffect, useState } from "react";
import type {
  ConfigMutation,
  ConfigWriteScope,
  SimulationResult,
} from "@omo/shared";
import { FocusTrapDialog } from "../components/FocusTrapDialog";
import { Button } from "../components/ui/Button";
import "../styles/policy.css";

const CAP_EDIT_TITLE_ID = "capability-edit-title";

export function CapabilityEditModal(props: {
  agent: string;
  onClose: () => void;
  onApplied: () => void;
  returnFocus?: HTMLElement | null | (() => HTMLElement | null);
}) {
  const [scope, setScope] = useState<ConfigWriteScope>("user");
  const [dest, setDest] = useState<"preset" | "root-agent">("root-agent");
  const [preset, setPreset] = useState("openai");
  const [hash, setHash] = useState<string | undefined>();
  const [temp, setTemp] = useState("");
  const [removeTemp, setRemoveTemp] = useState(false);
  const [skillsExpr, setSkillsExpr] = useState("");
  const [removeSkills, setRemoveSkills] = useState(false);
  const [mcpsExpr, setMcpsExpr] = useState("");
  const [removeMcps, setRemoveMcps] = useState(false);
  const [permJson, setPermJson] = useState("");
  const [removePerm, setRemovePerm] = useState(false);
  const [sim, setSim] = useState<SimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const st = await fetch("/api/config/edit-state").then((r) => r.json());
      setPreset(st.preset || "openai");
      setHash(scope === "user" ? st.user.hash : st.project.hash);
      const omo = await fetch("/api/omo/effective").then((r) => r.json());
      const a = omo.agents?.[props.agent];
      if (a) {
        if (a.temperature != null) setTemp(String(a.temperature));
        if (a.skills?.length) setSkillsExpr(JSON.stringify(a.skills));
        if (a.mcps?.length) setMcpsExpr(JSON.stringify(a.mcps));
        if (a.permission != null) setPermJson(JSON.stringify(a.permission, null, 2));
      }
    })();
  }, [props.agent, scope]);

  const buildMutation = (): ConfigMutation => {
    const destination =
      dest === "preset"
        ? { kind: "preset" as const, preset }
        : { kind: "root-agent" as const };

    const parseArr = (s: string): string[] => {
      const t = s.trim();
      if (!t) return [];
      if (t.startsWith("[")) return JSON.parse(t) as string[];
      return t.split(",").map((x) => x.trim()).filter(Boolean);
    };

    const mut: ConfigMutation = {
      kind: "agent-capabilities",
      scope,
      destination,
      agent: props.agent,
      expectedSourceHash: hash,
    };

    if (removeTemp) mut.temperature = { op: "remove" };
    else if (temp.trim() !== "")
      mut.temperature = { op: "set", value: Number(temp) };

    if (removeSkills) mut.skills = { op: "remove" };
    else if (skillsExpr.trim() !== "")
      mut.skills = { op: "set", value: parseArr(skillsExpr) };

    if (removeMcps) mut.mcps = { op: "remove" };
    else if (mcpsExpr.trim() !== "")
      mut.mcps = { op: "set", value: parseArr(mcpsExpr) };

    if (removePerm) mut.permission = { op: "remove" };
    else if (permJson.trim() !== "")
      mut.permission = { op: "set", value: JSON.parse(permJson) };

    return mut;
  };

  const preview = async () => {
    setBusy(true);
    setError(null);
    try {
      // refresh hash
      const st = await fetch("/api/config/edit-state").then((r) => r.json());
      setHash(scope === "user" ? st.user.hash : st.project.hash);
      const mut = buildMutation();
      mut.expectedSourceHash =
        scope === "user" ? st.user.hash : st.project.hash;
      const r = await fetch("/api/config/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mut),
      });
      const data = (await r.json()) as SimulationResult;
      setSim(data);
      if (!data.ok) setError(data.errors.join("; ") || "sim failed");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!sim?.ok) return;
    setBusy(true);
    try {
      const st = await fetch("/api/config/edit-state").then((r) => r.json());
      const mut = buildMutation();
      mut.expectedSourceHash =
        scope === "user" ? st.user.hash : st.project.hash;
      const r = await fetch("/api/config/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mut),
      });
      const data = await r.json();
      if (!data.ok) {
        setError((data.errors || []).join("; ") || "apply failed");
        return;
      }
      props.onApplied();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FocusTrapDialog
      variant="modal"
      labelledBy={CAP_EDIT_TITLE_ID}
      onClose={props.onClose}
      returnFocus={props.returnFocus}
      className="omo-policy-modal"
    >
      <div className="omo-policy-modal-body">
        <div className="omo-policy-head">
          <h2
            className="omo-policy-title omo-policy-title-xl"
            id={CAP_EDIT_TITLE_ID}
            tabIndex={-1}
          >
            Edit capabilities — {props.agent}
          </h2>
          <Button size="sm" onClick={props.onClose}>
            Close
          </Button>
        </div>
        {error ? <div className="error">{error}</div> : null}

        <div className="omo-policy-inset">
          <h2>Scope / destination</h2>
          <div className="omo-policy-field">
            <div className="omo-policy-choices">
              <label className="omo-policy-choice">
                <input
                  type="radio"
                  checked={scope === "user"}
                  onChange={() => setScope("user")}
                />
                User
              </label>
              <label className="omo-policy-choice">
                <input
                  type="radio"
                  checked={scope === "project"}
                  onChange={() => setScope("project")}
                />
                Project
              </label>
            </div>
            <div className="omo-policy-choices">
              <label className="omo-policy-choice">
                <input
                  type="radio"
                  checked={dest === "preset"}
                  onChange={() => setDest("preset")}
                />
                Preset “{preset}”
              </label>
              <label className="omo-policy-choice">
                <input
                  type="radio"
                  checked={dest === "root-agent"}
                  onChange={() => setDest("root-agent")}
                />
                Root agent override
              </label>
            </div>
          </div>
        </div>

        <div className="omo-policy-inset">
          <h2>Temperature (0–2)</h2>
          <div className="omo-policy-field">
            <input
              className="omo-policy-input"
              value={temp}
              onChange={(e) => setTemp(e.target.value)}
              disabled={removeTemp}
              placeholder="e.g. 0.2"
            />
            <label className="omo-policy-choice">
              <input
                type="checkbox"
                checked={removeTemp}
                onChange={(e) => setRemoveTemp(e.target.checked)}
              />
              Remove override
            </label>
          </div>
        </div>

        <div className="omo-policy-inset">
          <h2>Skills expression</h2>
          <p className="omo-policy-field-hint">
            e.g. ["*"], ["codemap","deepwork"], ["*","!simplify"], ["!*"], []
          </p>
          <div className="omo-policy-field">
            <input
              className="omo-policy-input omo-mono"
              value={skillsExpr}
              disabled={removeSkills}
              onChange={(e) => setSkillsExpr(e.target.value)}
            />
            <label className="omo-policy-choice">
              <input
                type="checkbox"
                checked={removeSkills}
                onChange={(e) => setRemoveSkills(e.target.checked)}
              />
              Remove override
            </label>
          </div>
        </div>

        <div className="omo-policy-inset">
          <h2>MCPs expression</h2>
          <p className="omo-policy-field-hint">
            e.g. ["*","!context7"], ["context7","gh_grep"], []
          </p>
          <div className="omo-policy-field">
            <input
              className="omo-policy-input omo-mono"
              value={mcpsExpr}
              disabled={removeMcps}
              onChange={(e) => setMcpsExpr(e.target.value)}
            />
            <label className="omo-policy-choice">
              <input
                type="checkbox"
                checked={removeMcps}
                onChange={(e) => setRemoveMcps(e.target.checked)}
              />
              Remove override
            </label>
          </div>
        </div>

        <div className="omo-policy-inset">
          <h2>Permission (JSON)</h2>
          <div className="omo-policy-field">
            <textarea
              className="omo-policy-textarea omo-mono"
              value={permJson}
              disabled={removePerm}
              onChange={(e) => setPermJson(e.target.value)}
              placeholder='{"read":"allow","edit":"deny"}'
            />
            <label className="omo-policy-choice">
              <input
                type="checkbox"
                checked={removePerm}
                onChange={(e) => setRemovePerm(e.target.checked)}
              />
              Remove override
            </label>
          </div>
        </div>

        <div className="omo-policy-actions">
          <Button disabled={busy} onClick={() => void preview()}>
            Preview
          </Button>
          <Button
            variant="primary"
            disabled={busy || !sim?.ok}
            onClick={() => void apply()}
          >
            Apply
          </Button>
        </div>

        {sim ? (
          <div className="omo-policy-inset">
            <h2>Preview</h2>
            <dl className="row-kv">
              <dt>File</dt>
              <dd className="omo-mono">{sim.targetPath}</dd>
              <dt>Paths</dt>
              <dd className="omo-mono">{sim.jsonPath.join(".")}</dd>
              <dt>Effective changes</dt>
              <dd className="omo-mono">
                {sim.effectiveChanged.length
                  ? sim.effectiveChanged
                      .map(
                        (c) =>
                          `${c.path}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`,
                      )
                      .join("\n")
                  : "none"}
              </dd>
              <dt>Masked</dt>
              <dd>{sim.masked ? "yes" : "no"}</dd>
            </dl>
            {sim.warnings.map((w, i) => (
              <div key={i} className="error">
                {w}
              </div>
            ))}
            <pre className="msg-pre">{sim.textDiff}</pre>
          </div>
        ) : null}
      </div>
    </FocusTrapDialog>
  );
}
