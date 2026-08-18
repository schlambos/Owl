/**
 * Installed-schema introspection for typed Interview capability (Slice 18 D0).
 *
 * Extracts `properties.interview.properties` from the authorized installed
 * schema document. Never invents fields. Typed writes stay closed unless the
 * extracted set matches the audited 2.2.10 InterviewConfigSchema exactly.
 */

export const AUDITED_INTERVIEW_PACKAGE_VERSION = "2.2.10";

/**
 * Full SHA-256 of the currently installed
 * `oh-my-opencode-slim@2.2.10` schema file under the active OpenCode
 * config directory. Re-verify on package change.
 */
export const AUDITED_INTERVIEW_SCHEMA_HASH =
  "947ac72a9035e0b7d7ce80c6e8f16ccdf930677b6b80b61d83b054cedbd30e8b";

export const AUDITED_INTERVIEW_FIELD_NAMES = [
  "maxQuestions",
  "outputFolder",
  "autoOpenBrowser",
  "port",
  "dashboard",
] as const;

export type AuditedInterviewFieldName =
  (typeof AUDITED_INTERVIEW_FIELD_NAMES)[number];

export interface ExtractedSchemaField {
  name: string;
  schemaType?: string;
  defaultValue?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  description?: string;
}

export interface InterviewSchemaIntrospection {
  ok: boolean;
  reason?: string;
  fields: ExtractedSchemaField[];
  fieldNames: string[];
}

const AUDITED_FIELDS: Record<
  AuditedInterviewFieldName,
  {
    schemaType: string;
    defaultValue: unknown;
    minimum?: number;
    maximum?: number;
    minLength?: number;
  }
> = {
  maxQuestions: {
    schemaType: "integer",
    defaultValue: 2,
    minimum: 1,
    maximum: 10,
  },
  outputFolder: {
    schemaType: "string",
    defaultValue: "interview",
    minLength: 1,
  },
  autoOpenBrowser: {
    schemaType: "boolean",
    defaultValue: true,
  },
  port: {
    schemaType: "integer",
    defaultValue: 0,
    minimum: 0,
    maximum: 65535,
  },
  dashboard: {
    schemaType: "boolean",
    defaultValue: false,
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Read `properties.interview.properties` from an installed schema document.
 * Missing interview object → not ok.
 */
export function extractInterviewSchemaFields(
  schema: unknown,
): InterviewSchemaIntrospection {
  if (!isPlainObject(schema)) {
    return { ok: false, reason: "schema-root-not-object", fields: [], fieldNames: [] };
  }
  const properties = schema.properties;
  if (!isPlainObject(properties)) {
    return { ok: false, reason: "schema-properties-missing", fields: [], fieldNames: [] };
  }
  const interview = properties.interview;
  if (!isPlainObject(interview)) {
    return {
      ok: false,
      reason: "interview-schema-missing",
      fields: [],
      fieldNames: [],
    };
  }
  const interviewProps = interview.properties;
  if (!isPlainObject(interviewProps)) {
    return {
      ok: false,
      reason: "interview-properties-missing",
      fields: [],
      fieldNames: [],
    };
  }

  const fields: ExtractedSchemaField[] = [];
  for (const [name, raw] of Object.entries(interviewProps)) {
    if (!isPlainObject(raw)) {
      fields.push({ name });
      continue;
    }
    const schemaType = typeof raw.type === "string" ? raw.type : undefined;
    const field: ExtractedSchemaField = { name };
    if (schemaType) field.schemaType = schemaType;
    if ("default" in raw) field.defaultValue = raw.default;
    const minimum = asNumber(raw.minimum);
    const maximum = asNumber(raw.maximum);
    const minLength = asNumber(raw.minLength);
    if (minimum !== undefined) field.minimum = minimum;
    if (maximum !== undefined) field.maximum = maximum;
    if (minLength !== undefined) field.minLength = minLength;
    if (typeof raw.description === "string") field.description = raw.description;
    fields.push(field);
  }

  return {
    ok: true,
    fields,
    fieldNames: fields.map((f) => f.name),
  };
}

export function interviewFieldsMatchAudited(
  extracted: InterviewSchemaIntrospection,
): { ok: true } | { ok: false; reason: string } {
  if (!extracted.ok) {
    return { ok: false, reason: extracted.reason ?? "interview-introspection-failed" };
  }
  const names = [...extracted.fieldNames].sort();
  const expected = [...AUDITED_INTERVIEW_FIELD_NAMES].sort();
  if (names.length !== expected.length || names.some((n, i) => n !== expected[i])) {
    return {
      ok: false,
      reason: `interview-field-set-mismatch: installed=[${extracted.fieldNames.join(",")}] audited=[${AUDITED_INTERVIEW_FIELD_NAMES.join(",")}]`,
    };
  }
  for (const field of extracted.fields) {
    const audited = AUDITED_FIELDS[field.name as AuditedInterviewFieldName];
    if (!audited) {
      return { ok: false, reason: `interview-unknown-field:${field.name}` };
    }
    if (field.schemaType !== audited.schemaType) {
      return {
        ok: false,
        reason: `interview-type-mismatch:${field.name}:${field.schemaType ?? "missing"}`,
      };
    }
    if (JSON.stringify(field.defaultValue) !== JSON.stringify(audited.defaultValue)) {
      return { ok: false, reason: `interview-default-mismatch:${field.name}` };
    }
    if (audited.minimum !== undefined && field.minimum !== audited.minimum) {
      return { ok: false, reason: `interview-minimum-mismatch:${field.name}` };
    }
    if (audited.maximum !== undefined && field.maximum !== audited.maximum) {
      return { ok: false, reason: `interview-maximum-mismatch:${field.name}` };
    }
    if (audited.minLength !== undefined && field.minLength !== audited.minLength) {
      return { ok: false, reason: `interview-minLength-mismatch:${field.name}` };
    }
  }
  return { ok: true };
}

export function auditedInterviewFieldMetadata(): ExtractedSchemaField[] {
  return AUDITED_INTERVIEW_FIELD_NAMES.map((name) => ({
    name,
    ...AUDITED_FIELDS[name],
  }));
}
