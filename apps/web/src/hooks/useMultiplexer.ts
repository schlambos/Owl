import { useCallback, useEffect, useState } from "react";
import type { MultiplexerSystemDto } from "@omo/shared";

/**
 * Read-only fetch of GET /api/system/multiplexer. Independent try/catch so a
 * failing endpoint never breaks the hosting page; last good DTO is kept.
 * Polls only when `pollMs` > 0 — the endpoint probes backend commands with
 * `command -v`, so callers should poll sparingly (default: fetch once).
 */
export function useMultiplexer(pollMs = 0) {
  const [dto, setDto] = useState<MultiplexerSystemDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/system/multiplexer");
      if (!r.ok) throw new Error(`/api/system/multiplexer → ${r.status}`);
      setDto((await r.json()) as MultiplexerSystemDto);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await refresh();
    };
    void tick();
    const t = pollMs > 0 ? setInterval(tick, pollMs) : undefined;
    return () => {
      cancelled = true;
      if (t) clearInterval(t);
    };
  }, [pollMs, refresh]);

  return { dto, error, loading, refresh };
}
