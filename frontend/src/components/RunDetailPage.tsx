import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { createEventSource, fetchJson } from "../api";
import type {
  ArtifactsResponse,
  EventFragment,
  RunDetailResponse,
  ScreenshotResponse,
} from "../types";
import EventFeed from "./EventFeed";
import ComputerPanel from "./ComputerPanel";

export default function RunDetailPage({ token }: { token: string }) {
  const { runId } = useParams();
  const [detail, setDetail] = useState<RunDetailResponse | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactsResponse>({ diffs: [], commands: [] });
  const [screenshots, setScreenshots] = useState<ScreenshotResponse>({ screenshots: [] });
  const [events, setEvents] = useState<EventFragment[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    fetchJson<RunDetailResponse>(`/api/cloud/runs/${runId}`, token)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message ?? "Failed to load run");
      });
    return () => {
      cancelled = true;
    };
  }, [runId, token]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    fetchJson<ArtifactsResponse>(`/api/cloud/runs/${runId}/artifacts`, token)
      .then((data) => {
        if (cancelled) return;
        setArtifacts(data);
      })
      .catch(() => {
        if (cancelled) return;
      });
    return () => {
      cancelled = true;
    };
  }, [runId, token]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    fetchJson<ScreenshotResponse>(`/api/cloud/screenshots?runId=${runId}`, token)
      .then((data) => {
        if (cancelled) return;
        setScreenshots(data);
      })
      .catch(() => {
        if (cancelled) return;
      });
    return () => {
      cancelled = true;
    };
  }, [runId, token]);

  useEffect(() => {
    if (!runId) return;
    const source = createEventSource(`/api/cloud/runs/${runId}/events`, token);
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as EventFragment;
        setEvents((prev) => [...prev, data]);
      } catch {
        // ignore
      }
    };
    source.addEventListener("ready", () => {
      // noop
    });
    source.onerror = () => {
      source.close();
    };
    return () => {
      source.close();
    };
  }, [runId, token]);

  const run = detail?.run;
  const identity = detail?.identity;

  const headerMeta = useMemo(() => {
    if (!run) return [] as string[];
    const items = [run.provider, run.status];
    if (run.started_at) items.push(`started ${new Date(run.started_at).toLocaleString()}`);
    if (run.finished_at) items.push(`finished ${new Date(run.finished_at).toLocaleString()}`);
    return items;
  }, [run]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <div className="breadcrumbs">
            <Link to="/">Runs</Link>
            <span> / </span>
            <span>{runId}</span>
          </div>
          <h1>Run {runId}</h1>
          <div className="meta-row">
            {headerMeta.map((item) => (
              <span key={item} className="meta-pill">
                {item}
              </span>
            ))}
          </div>
        </div>
        <div className="chip">Live</div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="layout">
        <div className="left">
          <section className="card">
            <h2>User details</h2>
            <div className="detail-grid">
              <div>
                <span className="label">Platform</span>
                <span>{identity?.platform ?? "-"}</span>
              </div>
              <div>
                <span className="label">User ID</span>
                <span>{identity?.user_id ?? "-"}</span>
              </div>
              <div>
                <span className="label">Workspace</span>
                <span>{identity?.workspace_id ?? "-"}</span>
              </div>
              <div>
                <span className="label">Onboarded</span>
                <span>{identity?.onboarded_at ? new Date(identity.onboarded_at).toLocaleDateString() : "-"}</span>
              </div>
            </div>
          </section>

          <section className="card">
            <h2>Repositories</h2>
            <div className="repo-list">
              {detail?.repos.map((repo) => (
                <div key={repo.id} className="repo-item">
                  <div>
                    <div className="repo-name">{repo.name}</div>
                    <div className="muted">{repo.url}</div>
                  </div>
                  <div className="repo-path">{repo.mount_path}</div>
                </div>
              ))}
              {detail?.repos.length === 0 && <div className="muted">Playground (no repo).</div>}
            </div>
          </section>

          <section className="card">
            <EventFeed events={events} />
          </section>
        </div>

        <div className="right">
          <ComputerPanel
            diffs={artifacts.diffs}
            commands={artifacts.commands}
            screenshots={screenshots.screenshots}
          />
        </div>
      </div>
    </div>
  );
}
