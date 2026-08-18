import { useCallback, useEffect, useState } from "react";
import type { OmoSchemaStatus } from "@omo/shared";

/**
 * Window event consumers of useOmoSchemaStatus listen to; call
 * notifyOmoSchemaStatusRefresh() after a successful config write/apply so the
 * schema-status surfaces (banner, SCHEMA panel) re-read GET /api/omo/schema.
 */
export const OMO_SCHEMA_STATUS_REFRESH = "omo:schema-status-refresh";

export function notifyOmoSchemaStatusRefresh(): void {
  window.dispatchEvent(new Event(OMO_SCHEMA_STATUS_REFRESH));
}

/**
 * Shared reader for GET /api/omo/schema.
 *
 * Refetch triggers: mount, window focus, and the
 * OMO_SCHEMA_STATUS_REFRESH event dispatched after config writes.
 */
export function useOmoSchemaStatus(): {
  status: OmoSchemaStatus | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<OmoSchemaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/omo/schema");
      if (!r.ok) throw new Error(`/api/omo/schema → ${r.status}`);
      setStatus((await r.json()) as OmoSchemaStatus);
      setError(null);
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const guarded = () => {
      if (!cancelled) void refresh();
    };
    guarded();
    window.addEventListener(OMO_SCHEMA_STATUS_REFRESH, guarded);
    window.addEventListener("focus", guarded);
    return () => {
      cancelled = true;
      window.removeEventListener(OMO_SCHEMA_STATUS_REFRESH, guarded);
      window.removeEventListener("focus", guarded);
    };
  }, [refresh]);

  return { status, error, loading, refresh };
}
