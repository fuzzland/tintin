import { useMemo } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { DiffEntry } from "../types";

interface DiffViewerProps {
  diff: DiffEntry | null;
  fileIndex: number;
  onFileChange: (index: number) => void;
}

function languageFromPath(p: string): string {
  if (p.endsWith(".ts") || p.endsWith(".tsx")) return "typescript";
  if (p.endsWith(".js") || p.endsWith(".jsx")) return "javascript";
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".go")) return "go";
  if (p.endsWith(".rs")) return "rust";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".md")) return "markdown";
  if (p.endsWith(".css")) return "css";
  if (p.endsWith(".html")) return "html";
  return "text";
}

export default function DiffViewer({ diff, fileIndex, onFileChange }: DiffViewerProps) {
  const file = diff?.files[fileIndex] ?? null;
  const language = useMemo(() => (file ? languageFromPath(file.path) : "text"), [file]);

  if (!diff || !file) {
    return <div className="diff-empty">No diff data yet.</div>;
  }

  return (
    <div className="diff-viewer">
      <div className="diff-header">
        <div>
          <div className="diff-path">{file.path}</div>
          <div className="muted">{diff.timestamp ? new Date(diff.timestamp).toLocaleString() : ""}</div>
        </div>
        <div className="diff-files">
          {diff.files.map((f, idx) => (
            <button
              key={f.path + idx}
              className={idx === fileIndex ? "chip active" : "chip"}
              onClick={() => onFileChange(idx)}
            >
              {f.path.split("/").pop()}
            </button>
          ))}
        </div>
      </div>
      <div className="diff-editor">
        <DiffEditor
          original={file.before}
          modified={file.after}
          language={language}
          options={{
            readOnly: true,
            renderSideBySide: true,
            minimap: { enabled: false },
            wordWrap: "on",
            renderOverviewRuler: false,
          }}
          height="320px"
        />
      </div>
    </div>
  );
}
