import { useEffect, useRef } from "react";
import type { OmoFormat } from "@omo/shared";
import {
  getOmoMonacoFactory,
  type OmoMonacoHandle,
  type OmoMonacoSchemaOptions,
} from "./omo-config-editor";

export function OmoMonacoEditor(props: {
  uri: string;
  value: string;
  format: OmoFormat;
  readOnly?: boolean;
  wordWrap?: boolean;
  schema?: OmoMonacoSchemaOptions;
  onChange?: (value: string) => void;
  revealPath?: string | null;
  ariaLabel?: string;
  testId?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<OmoMonacoHandle | null>(null);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const factory = getOmoMonacoFactory();
    handle.current = factory.mountEditor(
      el,
      {
        uri: props.uri,
        value: props.value,
        format: props.format,
        readOnly: props.readOnly,
        wordWrap: props.wordWrap,
      },
      (next) => onChangeRef.current?.(next),
    );
    return () => {
      handle.current?.dispose();
      handle.current = null;
    };
    // Recreate when the logical model identity or wrap mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.uri, props.format, props.readOnly, props.wordWrap]);

  useEffect(() => {
    handle.current?.setValue(props.value);
  }, [props.value]);

  useEffect(() => {
    handle.current?.setWordWrap?.(props.wordWrap === true);
  }, [props.wordWrap]);

  useEffect(() => {
    if (props.schema) getOmoMonacoFactory().registerSchema(props.schema);
  }, [props.schema]);

  useEffect(() => {
    if (props.revealPath) handle.current?.revealPath?.(props.revealPath);
  }, [props.revealPath]);

  return (
    <div
      ref={host}
      className="omo-monaco-host"
      role="region"
      aria-label={props.ariaLabel ?? "Configuration editor"}
      data-testid={props.testId ?? "omo-monaco-editor"}
      data-uri={props.uri}
      data-format={props.format}
      data-readonly={props.readOnly ? "true" : "false"}
    />
  );
}

export function OmoMonacoDiff(props: {
  originalUri: string;
  original: string;
  modifiedUri: string;
  modified: string;
  ariaLabel?: string;
  testId?: string;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const factory = getOmoMonacoFactory();
    const mounted = factory.mountDiff(
      el,
      { uri: props.originalUri, value: props.original },
      { uri: props.modifiedUri, value: props.modified },
    );
    return () => mounted.dispose();
  }, [props.originalUri, props.original, props.modifiedUri, props.modified]);

  return (
    <div
      ref={host}
      className="omo-monaco-host omo-monaco-diff"
      role="region"
      aria-label={props.ariaLabel ?? "Configuration diff"}
      data-testid={props.testId ?? "omo-monaco-diff"}
      data-original-uri={props.originalUri}
      data-modified-uri={props.modifiedUri}
    />
  );
}
