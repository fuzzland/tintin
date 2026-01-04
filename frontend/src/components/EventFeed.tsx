import type { EventFragment } from "../types";

interface EventFeedProps {
  events: EventFragment[];
}

function mergeContinuous(events: EventFragment[]): EventFragment[] {
  const out: EventFragment[] = [];
  for (const ev of events) {
    if (ev.kind === "text" && ev.continuous && out.length > 0) {
      const prev = out[out.length - 1];
      if (prev.kind === "text") {
        out[out.length - 1] = { ...prev, text: prev.text + ev.text };
        continue;
      }
    }
    out.push(ev);
  }
  return out;
}

export default function EventFeed({ events }: EventFeedProps) {
  const merged = mergeContinuous(events);
  return (
    <div className="event-feed">
      <div className="section-header">
        <h2>Run Events</h2>
        <span className="muted">Live stream</span>
      </div>
      <div className="event-list">
        {merged.map((ev, idx) => {
          if (ev.kind === "plan_update") {
            return (
              <div key={idx} className="event-card plan">
                <div className="event-title">Plan update</div>
                {ev.explanation && <div className="event-text">{ev.explanation}</div>}
                <ul className="plan-list">
                  {ev.plan.map((item, i) => (
                    <li key={i} className={`plan-${item.status}`}>
                      <span className="plan-step">{item.step}</span>
                      <span className="plan-status">{item.status}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          }
          if (ev.kind === "tool_call") {
            return (
              <div key={idx} className="event-card tool-call">
                <div className="event-title">Tool call</div>
                <pre>{ev.text}</pre>
              </div>
            );
          }
          if (ev.kind === "tool_output") {
            return (
              <div key={idx} className="event-card tool-output">
                <div className="event-title">Tool output</div>
                <pre>{ev.text}</pre>
              </div>
            );
          }
          return (
            <div key={idx} className="event-card message">
              <pre>{ev.text}</pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}
