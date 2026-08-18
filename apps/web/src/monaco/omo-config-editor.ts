/**
 * Locally bundled Monaco wiring for the OMO raw config workspace.
 *
 * Tests inject a factory. Production uses Vite `?worker` imports and
 * `loader.config({ monaco })`. Schema diagnostics are registered only when
 * the cache key or source format changes.
 */
import type { OmoFormat } from "@omo/shared";

export interface OmoMonacoModelOptions {
  uri: string;
  value: string;
  format: OmoFormat;
  readOnly?: boolean;
  wordWrap?: boolean;
}

export interface OmoMonacoSchemaOptions {
  schemaUri: string;
  cacheKey: string;
  format: OmoFormat;
  sourceUri: string;
  schema: Record<string, unknown>;
}

export interface OmoMonacoHandle {
  getValue(): string;
  setValue(value: string): void;
  setWordWrap?(enabled: boolean): void;
  revealPath?(path: string): void;
  dispose(): void;
}

export interface OmoMonacoDiffHandle {
  dispose(): void;
}

export interface OmoMonacoFactory {
  mountEditor(
    el: HTMLElement,
    options: OmoMonacoModelOptions,
    onChange: (value: string) => void,
  ): OmoMonacoHandle;
  mountDiff(
    el: HTMLElement,
    original: { uri: string; value: string },
    modified: { uri: string; value: string },
  ): OmoMonacoDiffHandle;
  registerSchema(options: OmoMonacoSchemaOptions): void;
  lastSchemaKey?: string;
}

export const DEFAULT_EDITOR_OPTIONS = {
  minimap: { enabled: false },
  lineNumbers: "on" as const,
  folding: true,
  matchBrackets: "always" as const,
  find: { addExtraSpaceOnTop: false },
  wordBasedSuggestions: "off" as const,
  formatOnPaste: false,
  formatOnType: false,
  autoIndent: "none" as const,
  tabSize: 2,
  insertSpaces: true,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  quickSuggestions: true,
  suggestOnTriggerCharacters: true,
  hover: { enabled: true },
  codeActionsOnSave: undefined,
};

let productionFactory: OmoMonacoFactory | null = null;
let injectedFactory: OmoMonacoFactory | null = null;
let monacoConfigured = false;
let themeObserver: MutationObserver | null = null;

const OMO_MONACO_THEME_LIGHT = "omo-control-light";
const OMO_MONACO_THEME_DARK = "omo-control-dark";

export function setOmoMonacoFactory(factory: OmoMonacoFactory | null): void {
  injectedFactory = factory;
}

export function getOmoMonacoFactory(): OmoMonacoFactory {
  if (injectedFactory) return injectedFactory;
  productionFactory ??= createProductionFactory();
  return productionFactory;
}

export function schemaRegistrationKey(opts: OmoMonacoSchemaOptions): string {
  return `${opts.cacheKey}|${opts.format}|${opts.sourceUri}`;
}

export function jsonDiagnosticsOptions(opts: OmoMonacoSchemaOptions) {
  const jsonc = opts.format === "jsonc";
  return {
    validate: true,
    allowComments: jsonc,
    comments: jsonc ? "ignore" : "error",
    trailingCommas: jsonc ? "ignore" : "error",
    schemas: [
      {
        uri: opts.schemaUri,
        fileMatch: [opts.sourceUri],
        schema: opts.schema,
      },
    ],
  };
}

function createProductionFactory(): OmoMonacoFactory {
  let lastSchemaKey: string | undefined;
  return {
    get lastSchemaKey() {
      return lastSchemaKey;
    },
    mountEditor(el, options, onChange) {
      let disposed = false;
      let handle: OmoMonacoHandle | null = null;
      let ownedModel: MonacoModel | null = null;
      void loadMonaco().then((monaco) => {
        if (disposed) return;
        const model = ensureModel(monaco, options.uri, options.value, "json");
        ownedModel = model;
        applyOmoMonacoTheme(monaco);
        const editor = monaco.editor.create(el, {
          ...DEFAULT_EDITOR_OPTIONS,
          model,
          readOnly: options.readOnly === true,
          wordWrap: options.wordWrap ? "on" : "off",
          theme: currentOmoMonacoTheme(),
          fontFamily: cssVar(
            "--omo-font-mono",
            'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
          ),
          ariaLabel: el.getAttribute("aria-label") ?? "Configuration editor",
        });
        const sub = editor.onDidChangeModelContent(() => {
          onChange(editor.getValue());
        });
        handle = {
          getValue: () => editor.getValue(),
          setValue: (value) => {
            if (editor.getValue() !== value) editor.setValue(value);
          },
          setWordWrap: (enabled) => {
            editor.updateOptions?.({ wordWrap: enabled ? "on" : "off" });
          },
          revealPath: (path) => revealJsonPath(editor, path),
          dispose: () => {
            sub.dispose();
            editor.dispose();
            ownedModel?.dispose?.();
            ownedModel = null;
          },
        };
      });
      return {
        getValue: () => handle?.getValue() ?? options.value,
        setValue: (value) => handle?.setValue(value),
        setWordWrap: (enabled) => handle?.setWordWrap?.(enabled),
        revealPath: (path) => handle?.revealPath?.(path),
        dispose: () => {
          disposed = true;
          handle?.dispose();
        },
      };
    },
    mountDiff(el, original, modified) {
      let disposed = false;
      let dispose = () => {};
      void loadMonaco().then((monaco) => {
        if (disposed) return;
        const originalModel = ensureModel(monaco, original.uri, original.value, "json");
        const modifiedModel = ensureModel(monaco, modified.uri, modified.value, "json");
        applyOmoMonacoTheme(monaco);
        const editor = monaco.editor.createDiffEditor(el, {
          readOnly: true,
          renderSideBySide: true,
          automaticLayout: true,
          minimap: { enabled: false },
          theme: currentOmoMonacoTheme(),
          fontFamily: cssVar(
            "--omo-font-mono",
            'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
          ),
          ariaLabel: el.getAttribute("aria-label") ?? "Configuration diff",
        });
        editor.setModel({ original: originalModel, modified: modifiedModel });
        dispose = () => {
          editor.dispose();
          originalModel.dispose?.();
          modifiedModel.dispose?.();
        };
      });
      return {
        dispose: () => {
          disposed = true;
          dispose();
        },
      };
    },
    registerSchema(options) {
      const key = schemaRegistrationKey(options);
      if (lastSchemaKey === key) return;
      lastSchemaKey = key;
      void loadMonaco().then((monaco) => {
        const defaults =
          monaco.json?.jsonDefaults ?? monaco.languages.json.jsonDefaults;
        defaults.setDiagnosticsOptions(jsonDiagnosticsOptions(options));
      });
    },
  };
}

async function loadMonaco(): Promise<MonacoNs> {
  const [mod, workers] = await Promise.all([
    import("monaco-editor"),
    import("./omo-monaco-workers"),
  ]);
  const monaco = (asNamespace(mod) ?? asNamespace((mod as { default?: unknown }).default)) as MonacoNs;
  if (!monacoConfigured) {
    const env = globalThis as unknown as {
      MonacoEnvironment?: { getWorker: (_: unknown, label: string) => Worker };
    };
    env.MonacoEnvironment = {
      getWorker: (_: unknown, label: string) =>
        label === "json" ? new workers.JsonWorker() : new workers.EditorWorker(),
    };
    const { loader } = await import("@monaco-editor/react");
    loader.config({ monaco });
    applyOmoMonacoTheme(monaco);
    watchOmoMonacoTheme(monaco);
    monacoConfigured = true;
  }
  return monaco;
}

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

function currentOmoMonacoTheme(): string {
  if (typeof document === "undefined") return OMO_MONACO_THEME_LIGHT;
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? OMO_MONACO_THEME_DARK
    : OMO_MONACO_THEME_LIGHT;
}

function applyOmoMonacoTheme(monaco: MonacoNs): void {
  monaco.editor.defineTheme?.(OMO_MONACO_THEME_LIGHT, {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": cssVar("--omo-surface-muted", "#f4f6f8"),
      "editor.foreground": cssVar("--omo-text", "#1a1f26"),
      "editorLineNumber.foreground": cssVar("--omo-text-faint", "#8b95a3"),
      "editorLineNumber.activeForeground": cssVar("--omo-text-muted", "#5b6573"),
      "editor.selectionBackground": cssVar("--omo-action-soft", "#eff6ff"),
      "editorWidget.background": cssVar("--omo-surface", "#ffffff"),
      "editorWidget.border": cssVar("--omo-border", "#e4e8ee"),
      "editorCursor.foreground": cssVar("--omo-action", "#3b82f6"),
      "editorIndentGuide.background": cssVar("--omo-border", "#e4e8ee"),
      "editorGutter.background": cssVar("--omo-surface-muted", "#f4f6f8"),
      "diffEditor.insertedTextBackground": "#3f8f6b26",
      "diffEditor.removedTextBackground": "#c4475a26",
    },
  });
  monaco.editor.defineTheme?.(OMO_MONACO_THEME_DARK, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": cssVar("--omo-surface-muted", "#232a33"),
      "editor.foreground": cssVar("--omo-text", "#e8ecf1"),
      "editorLineNumber.foreground": cssVar("--omo-text-faint", "#6b7380"),
      "editorLineNumber.activeForeground": cssVar("--omo-text-muted", "#9aa3b0"),
      "editor.selectionBackground": cssVar("--omo-action-soft", "#1b2a44"),
      "editorWidget.background": cssVar("--omo-surface", "#1d232a"),
      "editorWidget.border": cssVar("--omo-border", "#2c343e"),
      "editorCursor.foreground": cssVar("--omo-action", "#3b82f6"),
      "editorIndentGuide.background": cssVar("--omo-border", "#2c343e"),
      "editorGutter.background": cssVar("--omo-surface-muted", "#232a33"),
      "diffEditor.insertedTextBackground": "#5aa88233",
      "diffEditor.removedTextBackground": "#d46a7833",
    },
  });
  monaco.editor.setTheme?.(currentOmoMonacoTheme());
}

function watchOmoMonacoTheme(monaco: MonacoNs): void {
  if (themeObserver || typeof MutationObserver === "undefined") return;
  themeObserver = new MutationObserver(() => applyOmoMonacoTheme(monaco));
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

function asNamespace(mod: unknown): MonacoNs | null {
  if (!mod || typeof mod !== "object") return null;
  const m = mod as Partial<MonacoNs>;
  if (m.editor && (m.Uri || m.languages || m.json)) return m as MonacoNs;
  return null;
}

interface MonacoNs {
  Uri: { parse: (uri: string) => unknown };
  editor: {
    getModel: (uri: unknown) => MonacoModel | null;
    createModel: (value: string, language: string, uri: unknown) => MonacoModel;
    create: (el: HTMLElement, opts: Record<string, unknown>) => MonacoStandalone;
    createDiffEditor: (el: HTMLElement, opts: Record<string, unknown>) => MonacoDiff;
    defineTheme?: (name: string, theme: Record<string, unknown>) => void;
    setTheme?: (name: string) => void;
  };
  languages: {
    json: {
      jsonDefaults: {
        setDiagnosticsOptions: (opts: unknown) => void;
      };
    };
  };
  json?: {
    jsonDefaults: {
      setDiagnosticsOptions: (opts: unknown) => void;
    };
  };
}

interface MonacoModel {
  setValue: (value: string) => void;
  getValue: () => string;
  dispose?: () => void;
}

interface MonacoStandalone {
  getValue: () => string;
  setValue: (value: string) => void;
  updateOptions?: (opts: Record<string, unknown>) => void;
  onDidChangeModelContent: (fn: () => void) => { dispose: () => void };
  dispose: () => void;
  revealLineInCenter?: (line: number) => void;
  setPosition?: (pos: { lineNumber: number; column: number }) => void;
}

interface MonacoDiff {
  setModel: (models: { original: MonacoModel; modified: MonacoModel }) => void;
  dispose: () => void;
}

function ensureModel(
  monaco: MonacoNs,
  uri: string,
  value: string,
  language: string,
): MonacoModel {
  const parsed = monaco.Uri.parse(uri);
  const existing = monaco.editor.getModel(parsed);
  if (existing) {
    if (existing.getValue() !== value) existing.setValue(value);
    return existing;
  }
  return monaco.editor.createModel(value, language, parsed);
}

function revealJsonPath(editor: MonacoStandalone, path: string): void {
  const text = editor.getValue();
  const leaf = path.split(".").filter(Boolean).pop();
  if (!leaf) return;
  const idx = text.indexOf(`"${leaf}"`);
  if (idx < 0) return;
  const line = text.slice(0, idx).split(/\r?\n/).length;
  editor.revealLineInCenter?.(line);
  editor.setPosition?.({ lineNumber: line, column: 1 });
}
