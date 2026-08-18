import { useMemo, useState } from "react";
import { useOmoRuntime } from "../../hooks/useOmoRuntime";
import { useMultiplexer } from "../../hooks/useMultiplexer";
import { StatusDot, type StatusTone } from "../../components/ui/StatusDot";
import type { OmoJob, OmoJobState } from "../omo-runtime-types";
import { mappingAuthoritative, terminalLabel } from "../system/multiplexer-utils";

export function jobLabel(job: OmoJob): string {
  return job.alias ?? `${job.taskId.slice(0, 8)}`;
}

/** Job state → quiet tone (running healthy, error bad, cancelled neutral). */
export function jobTone(state: OmoJobState): StatusTone {
  if (state === "running" || state === "completed") return "ok";
  if (state === "error") return "bad";
  return "neutral";
}

export function jobAge(job: OmoJob): string {
  const at = job.state === "running" ? job.launchedAt : (job.completedAt ?? job.launchedAt);
  if (at == null) return "—";
  const d = Date.now() - at;
  if (d < 0) return "—";
  if (d < 1000) return "just now";
  if (d < 60_000) return `${Math.floor(d / 1000)}s`;
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m`;
  return `${Math.floor(d / 3600_000)}h`;
}

export function OmoJobRow(props: {
  job: OmoJob;
  selected?: boolean;
  onSelect: (sessionId: string) => void;
  /**
   * Terminal mapping label (`type paneId`, or "Terminal Unavailable") — only
   * provided when the multiplexer runtime mapping is authoritative; null/undefined
   * renders nothing (mapping unobservable is neutral).
   */
  terminal?: string | null;
}) {
  const { job } = props;
  return (
    <button
      type="button"
      role="option"
      className="omo-sess-row"
      aria-selected={props.selected}
      aria-current={props.selected ? "true" : undefined}
      title={`task ${job.taskId} · child session ${job.childSessionId}`}
      onClick={() => props.onSelect(job.childSessionId)}
    >
      <StatusDot
        tone={jobTone(job.state)}
        className={job.state === "running" ? "pulse" : undefined}
      />
      <span className="omo-sess-row-title">{jobLabel(job)}</span>
      <span className="omo-sess-row-meta">
        {job.agent} · {jobAge(job)}
        {props.terminal != null ? (
          <>
            {" · "}
            <span data-testid="job-terminal">{props.terminal}</span>
          </>
        ) : null}
      </span>
      <span
        className={`omo-sess-status ${jobTone(job.state) !== "neutral" ? jobTone(job.state) : ""}`}
      >
        {job.state}
      </span>
      {job.timedOut ? (
        <span className="omo-badge omo-badge-warn">Timed out (OMO)</span>
      ) : null}
      {job.resumeRequested ? (
        <span className="omo-badge">Resume requested</span>
      ) : null}
    </button>
  );
}

export function sortJobsRecent(jobs: OmoJob[]): OmoJob[] {
  return jobs
    .slice()
    .sort((a, b) => (b.launchedAt ?? 0) - (a.launchedAt ?? 0));
}

/**
 * Compact collapsible OMO jobs block for the top of the sessions sidebar.
 * Clicking a job selects its child session in the inspector.
 */
export function OmoJobsPanel(props: {
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const { snapshot, error } = useOmoRuntime();
  // Multiplexer mapping is joined by exact child session ID (bridge v2
  // authoritative only). Fetch once on mount + slow poll — the endpoint
  // probes backend commands, so no fast polling here.
  const { dto: mux } = useMultiplexer(30000);
  const [open, setOpen] = useState(true);

  const jobs = useMemo(
    () => sortJobsRecent(snapshot?.jobs ?? []).slice(0, 10),
    [snapshot],
  );

  /** Per-job terminal label; null for every job when mapping is unobservable. */
  const terminalFor = useMemo(() => {
    if (!mux || !mappingAuthoritative(mux)) return () => null;
    return (job: OmoJob): string => {
      const rec = mux.runtime.mapping.bySessionId[job.childSessionId];
      return rec ? terminalLabel(mux, rec) : "Terminal Unavailable";
    };
  }, [mux]);

  return (
    <div className="omo-sess-jobs">
      <button
        type="button"
        className="omo-sess-jobs-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="omo-sess-jobs-chevron" aria-hidden="true">
          ▶
        </span>
        OMO jobs ({snapshot ? snapshot.jobs.length : "—"})
      </button>{" "}
      {snapshot?.stale ? <span className="omo-badge">stale</span> : null}
      {open ? (
        <div role="listbox" aria-label="OMO jobs">
          {error && !snapshot ? (
            <div className="omo-sess-jobs-empty">
              telemetry unavailable: {error}
            </div>
          ) : jobs.length === 0 ? (
            <div className="omo-sess-jobs-empty">No OMO jobs observed.</div>
          ) : (
            jobs.map((j) => (
              <OmoJobRow
                key={j.taskId}
                job={j}
                selected={j.childSessionId === props.selectedId}
                onSelect={props.onSelect}
                terminal={terminalFor(j)}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
