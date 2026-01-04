import { useEffect, useMemo, useState } from "react";
import Anser from "anser";
import type { CommandEntry } from "../types";

interface TerminalPlaybackProps {
  command: CommandEntry | null;
}

function renderAnsi(text: string) {
  const parsed = Anser.ansiToJson(text, { use_classes: false, remove_empty: true });
  return parsed.map((chunk: any, idx: number) => {
    const style: React.CSSProperties = {
      color: chunk.fg ? chunk.fg : undefined,
      backgroundColor: chunk.bg ? chunk.bg : undefined,
      fontWeight: chunk.bold ? 600 : undefined,
      fontStyle: chunk.italic ? "italic" : undefined,
      textDecoration: chunk.underline ? "underline" : undefined,
    };
    return (
      <span key={idx} style={style}>
        {chunk.content}
      </span>
    );
  });
}

export default function TerminalPlayback({ command }: TerminalPlaybackProps) {
  const [instant, setInstant] = useState(false);
  const [playKey, setPlayKey] = useState(0);
  const [display, setDisplay] = useState("");

  useEffect(() => {
    if (!command) return;
    if (instant) {
      setDisplay(command.output);
      return;
    }
    setDisplay("");
    let i = 0;
    const output = command.output ?? "";
    const interval = setInterval(() => {
      i += Math.max(1, Math.floor(output.length / 200));
      setDisplay(output.slice(0, i));
      if (i >= output.length) clearInterval(interval);
    }, 16);
    return () => clearInterval(interval);
  }, [command?.id, playKey, instant]);

  const exitBadge = useMemo(() => {
    if (!command) return null;
    const cls = command.exitCode === 0 ? "exit ok" : "exit bad";
    return <span className={cls}>exit {command.exitCode ?? "?"}</span>;
  }, [command]);

  if (!command) {
    return <div className="terminal-empty">No command output yet.</div>;
  }

  return (
    <div className="terminal">
      <div className="terminal-toolbar">
        <div className="terminal-title">Terminal</div>
        <div className="terminal-actions">
          <button className="ghost" onClick={() => setPlayKey((k) => k + 1)}>
            Replay
          </button>
          <label className="toggle">
            <input type="checkbox" checked={instant} onChange={(e) => setInstant(e.target.checked)} />
            Instant
          </label>
        </div>
      </div>
      <div className="terminal-body">
        <div className="terminal-line">
          <span className="prompt">{command.cwd ? `[${command.cwd}] ` : ""}$</span>
          <span className="cmd">{command.command}</span>
          {exitBadge}
        </div>
        <pre className="terminal-output">{renderAnsi(display)}</pre>
      </div>
    </div>
  );
}
