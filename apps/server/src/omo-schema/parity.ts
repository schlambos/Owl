/**
 * Supplemental dist-parity checks.
 *
 * The shipped `oh-my-opencode-slim.schema.json` JSON Schema UNDER-EXPRESSES
 * the runtime zod validator in a few places (e.g. cross-field superRefine
 * rules, zod-transform-enforced council member shapes). Those rules are what
 * actually reject a config at plugin load, so a write can pass AJV yet still
 * be rejected by OMO-Slim. These checks close the gap.
 *
 * VERSION SCOPING: rules below are a direct port of the installed
 * oh-my-opencode-slim@2.2.10 dist/index.js (line refs in comments). Like
 * omo/catalog.ts, they describe the installed version; if the installed
 * package version changes, re-derive these from the new dist.
 *
 * Applied AFTER AJV passes.
 */

import type { SchemaValidationIssue } from "./types";

/** dist:18556 — ModelIdSchema: /^[^/\s]+\/[^\s]+$/ */
const PROVIDER_MODEL_ID = /^[^/\s]+\/[^\s]+$/;
const PROVIDER_MODEL_MESSAGE = 'Expected provider/model format (e.g. "openai/gpt-5.6-luna")';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * dist:18833-18844 rejectOrchestratorPromptOnOrchestrator + root
 * superRefine dist:18865-18877: `orchestratorPrompt` is forbidden on the
 * orchestrator agent, both at the root `agents` map and inside every preset.
 */
function checkOrchestratorPrompt(doc: Record<string, unknown>): SchemaValidationIssue[] {
  const out: SchemaValidationIssue[] = [];

  const agents = doc.agents;
  if (isObject(agents)) {
    const orch = agents.orchestrator;
    if (isObject(orch) && orch.orchestratorPrompt !== undefined) {
      out.push({
        path: "agents.orchestrator.orchestratorPrompt",
        keyword: "parity",
        message:
          "orchestratorPrompt is not supported for the orchestrator agent (dist/index.js:18833-18844, 18865-18877)",
      });
    }
  }

  const presets = doc.presets;
  if (isObject(presets)) {
    for (const [presetName, preset] of Object.entries(presets)) {
      if (!isObject(preset)) continue;
      const orch = preset.orchestrator;
      if (isObject(orch) && orch.orchestratorPrompt !== undefined) {
        out.push({
          path: `presets.${presetName}.orchestrator.orchestratorPrompt`,
          keyword: "parity",
          message:
            "orchestratorPrompt is not supported for the orchestrator agent (dist/index.js:18833-18844, 18865-18877)",
        });
      }
    }
  }

  return out;
}

/**
 * dist:18561-18564 — CouncillorModelSchema:
 *   ModelIdSchema | array(min 1) of (ModelIdSchema | { id: ModelIdSchema, variant?: string })
 * enforced per council member by CouncillorConfigSchema (dist:18565-18577)
 * via the CouncilPresetSchema transform (dist:18578-18604). The shipped JSON
 * Schema leaves `council.presets.*.*` as free-form objects, so AJV cannot
 * catch this.
 */
function checkCouncillorModel(
  model: unknown,
  path: string,
): SchemaValidationIssue[] {
  if (typeof model === "string") {
    return PROVIDER_MODEL_ID.test(model)
      ? []
      : [{ path, keyword: "parity", message: PROVIDER_MODEL_MESSAGE, expected: "provider/model string", received: model }];
  }
  if (Array.isArray(model)) {
    if (model.length === 0) {
      return [{
        path,
        keyword: "parity",
        message: "councillor model fallback chain must have at least 1 entry",
        expected: "array with minItems 1",
        received: model,
      }];
    }
    const out: SchemaValidationIssue[] = [];
    model.forEach((entry, i) => {
      const ep = `${path}.${i}`;
      if (typeof entry === "string") {
        if (!PROVIDER_MODEL_ID.test(entry)) {
          out.push({ path: ep, keyword: "parity", message: PROVIDER_MODEL_MESSAGE, expected: "provider/model string", received: entry });
        }
      } else if (isObject(entry) && typeof entry.id === "string") {
        if (!PROVIDER_MODEL_ID.test(entry.id)) {
          out.push({ path: `${ep}.id`, keyword: "parity", message: PROVIDER_MODEL_MESSAGE, expected: "provider/model string", received: entry.id });
        }
        if (entry.variant !== undefined && typeof entry.variant !== "string") {
          out.push({ path: `${ep}.variant`, keyword: "parity", message: "variant must be a string", expected: "string", received: entry.variant });
        }
      } else {
        out.push({ path: ep, keyword: "parity", message: "councillor model entry must be a string or { id, variant? } object", expected: "string | { id: string, variant?: string }", received: entry });
      }
    });
    return out;
  }
  return [{
    path,
    keyword: "parity",
    message: "councillor model is required: provider/model string or fallback chain",
    expected: "string | array(min 1) of string | { id, variant? }",
    received: model,
  }];
}

function checkCouncil(doc: Record<string, unknown>): SchemaValidationIssue[] {
  const council = doc.council;
  if (!isObject(council)) return [];
  const presets = council.presets;
  if (!isObject(presets)) return [];
  const out: SchemaValidationIssue[] = [];
  for (const [presetName, preset] of Object.entries(presets)) {
    if (!isObject(preset)) continue;
    for (const [key, member] of Object.entries(preset)) {
      // dist:18581 — "master" key is skipped by the runtime parser.
      if (key === "master") continue;
      // dist:18583-18594 — legacy nested "councillors" map is parsed member-wise.
      if (key === "councillors" && isObject(member)) {
        for (const [inner, innerMember] of Object.entries(member)) {
          if (!isObject(innerMember)) continue;
          out.push(
            ...checkCouncillorModel(
              innerMember.model,
              `council.presets.${presetName}.councillors.${inner}.model`,
            ),
          );
        }
        continue;
      }
      if (!isObject(member)) continue;
      out.push(
        ...checkCouncillorModel(
          member.model,
          `council.presets.${presetName}.${key}.model`,
        ),
      );
    }
  }
  return out;
}

/**
 * NOTE — ACP `acpAgents.<name>.wrapperModel` (dist:18820-18832,
 * ProviderModelIdSchema dist:18828+18676): the shipped JSON Schema DOES carry
 * the equivalent `pattern` for wrapperModel, so AJV already enforces it —
 * intentionally NOT duplicated here.
 */
export function parityIssues(doc: unknown): SchemaValidationIssue[] {
  if (!isObject(doc)) return [];
  return [...checkOrchestratorPrompt(doc), ...checkCouncil(doc)];
}
