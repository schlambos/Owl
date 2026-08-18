import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { SessionsDto } from "@omo/shared";
import { WorkspaceHeader } from "../components/layout/WorkspaceHeader";
import { Button } from "../components/ui/Button";
import { StatusDot } from "../components/ui/StatusDot";
import { useRuntime } from "../runtime/RuntimeContext";
import { OmoJobsPanel } from "./sessions/OmoJobsPanel";
import { SessionInspector } from "./sessions/SessionInspector";
import { SessionTree, statusTone } from "./sessions/SessionTree";
import "../styles/sessions.css";

export function SessionsPage() {
  const { sessions, loading, error, refreshAll, connection, runtime } =
    useRuntime();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState("");

  // ── URL selection (?session=<id>, two-way) ────────────────────────
  // Unrelated params preserved; selection changes are history entries.
  const selectedId = searchParams.get("session");

  const selectSession = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("session", id);
    else next.delete("session");
    setSearchParams(next);
  };

  // Control-plane probe sessions are hidden by default (server filters them
  // out of the SSE bootstrap); opt-in refetches with the include flag.
  const [showCpProbes, setShowCpProbes] = useState(false);
  const [cpSessions, setCpSessions] = useState<SessionsDto | null>(null);

  useEffect(() => {
    if (!showCpProbes) {
      setCpSessions(null);
      return;
    }
    let cancelled = false;
    fetch("/api/sessions?includeControlPlaneProbes=1")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setCpSessions(d as SessionsDto);
      })
      .catch(() => {
        if (!cancelled) setCpSessions(null);
      });
    return () => {
      cancelled = true;
    };
    // Re-pull alongside runtime refreshes so the visible tree stays current.
  }, [showCpProbes, sessions]);

  const roots =
    showCpProbes && cpSessions ? cpSessions.roots : (sessions?.roots ?? []);

  // Auto-select first root if none (URL stays shareable, no history spam).
  useEffect(() => {
    if (!selectedId && sessions?.roots[0]) {
      const next = new URLSearchParams(searchParams);
      next.set("session", sessions.roots[0].id);
      setSearchParams(next, { replace: true });
    }
  }, [sessions, selectedId, searchParams, setSearchParams]);

  const toggleCpProbes = (checked: boolean) => {
    setShowCpProbes(checked);
    if (!checked && selectedId) {
      // Toggling off hides CP probe sessions; a selection pointing at one
      // must reset to something visible.
      const stillVisible = (sessions?.flat ?? []).some(
        (s) => s.id === selectedId,
      );
      if (!stillVisible) selectSession(sessions?.roots[0]?.id ?? null);
    }
  };

  // If selected deleted from tree, keep selection (inspector handles missing)
  return (
    <div className="omo-sessions omo-sess">
      <WorkspaceHeader
        title="Sessions"
        description="Live OpenCode session tree, OMO jobs, and per-session inspection."
        meta={
          sessions
            ? `${sessions.total} sessions · OpenCode SSE ${connection.sse}`
            : undefined
        }
        actions={
          <Button onClick={() => void refreshAll()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </Button>
        }
      />
      {error ? (
        <div className="error omo-sess-banner" role="alert">
          {error}
        </div>
      ) : null}
      {connection.stale ? (
        <div className="error omo-sess-banner" role="status">
          Runtime may be stale (REST {connection.rest}, SSE {connection.sse}).
        </div>
      ) : null}

      <div className="omo-sess-frame">
        <aside className="omo-sess-side">
          <OmoJobsPanel
            selectedId={selectedId ?? undefined}
            onSelect={selectSession}
          />
          <div className="omo-sess-controls">
            <input
              className="omo-sess-input"
              aria-label="Filter session tree"
              placeholder="Filter tree…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <label className="omo-sess-check">
              <input
                type="checkbox"
                checked={showCpProbes}
                onChange={(e) => toggleCpProbes(e.target.checked)}
              />{" "}
              Show control-plane probe sessions
            </label>
          </div>
          {runtime?.sessions.byStatus ? (
            <div className="omo-sess-legend" aria-label="Sessions by status">
              {Object.entries(runtime.sessions.byStatus).map(([k, v]) => (
                <span key={k} className="omo-sess-legend-item">
                  <StatusDot tone={statusTone(k)} />
                  {k} {v}
                </span>
              ))}
            </div>
          ) : null}
          <SessionTree
            roots={roots}
            selectedId={selectedId ?? undefined}
            onSelect={selectSession}
            filter={filter}
          />
        </aside>
        <section className="omo-sess-pane">
          <SessionInspector sessionId={selectedId} onSelect={selectSession} />
        </section>
      </div>
    </div>
  );
}
