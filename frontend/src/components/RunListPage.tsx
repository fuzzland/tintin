import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchJson } from "../api";
import type { RunSummary } from "../types";

interface RunsResponse {
  runs: RunSummary[];
  nextCursor: number | null;
}

export default function RunListPage({ token }: { token: string }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchJson<RunsResponse>("/api/cloud/runs", token)
      .then((data) => {
        if (cancelled) return;
        setRuns(data.runs ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message ?? "Failed to load runs");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Tintin Cloud Runs</h1>
          <p className="muted">Recent runs you can access with this link.</p>
        </div>
        <div className="chip">Cloud UI</div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="run-grid">
        {runs.map((run) => (
          <Link key={run.id} to={`/run/${run.id}`} className="run-card">
            <div className="run-card-top">
              <span className={`status status-${run.status}`}>{run.status}</span>
              <span className="muted">{new Date(run.created_at).toLocaleString()}</span>
            </div>
            <h3>{run.id}</h3>
            <div className="run-meta">
              <span>Provider: {run.provider}</span>
              <span>Repo: {run.primary_repo_id ?? "Playground"}</span>
            </div>
            <div className="run-card-footer">Open →</div>
          </Link>
        ))}
        {runs.length === 0 && !error && (
          <div className="empty-state">No runs available for this token.</div>
        )}
      </div>
    </div>
  );
}
