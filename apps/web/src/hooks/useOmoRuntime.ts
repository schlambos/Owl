import { useEffect, useState } from "react";
import type { OmoRuntimeSnapshot } from "../pages/omo-runtime-types";

/**
 * Read-only poll of /api/omo/runtime. Independent try/catch per tick so a
 * failing endpoint never breaks the hosting page; last good snapshot is kept.
 */
export function useOmoRuntime(pollMs = 15000) {
  const [snapshot, setSnapshot] = useState<OmoRuntimeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/omo/runtime");
        if (!r.ok) throw new Error(`/api/omo/runtime → ${r.status}`);
        const json = (await r.json()) as OmoRuntimeSnapshot;
        if (!cancelled) {
          setSnapshot(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    const t = setInterval(tick, pollMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [pollMs]);

  return { snapshot, error };
}
