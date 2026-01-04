import { useEffect, useState } from "react";
import type { CommandEntry, DiffEntry, ScreenshotItem } from "../types";
import ArtifactTimeline from "./ArtifactTimeline";
import DiffViewer from "./DiffViewer";
import TerminalPlayback from "./TerminalPlayback";
import ScreenshotCarousel from "./ScreenshotCarousel";

interface ComputerPanelProps {
  diffs: DiffEntry[];
  commands: CommandEntry[];
  screenshots: ScreenshotItem[];
}

export default function ComputerPanel({ diffs, commands, screenshots }: ComputerPanelProps) {
  const [diffIndex, setDiffIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState(0);
  const [commandIndex, setCommandIndex] = useState(0);
  const [shotIndex, setShotIndex] = useState(0);

  useEffect(() => {
    setFileIndex(0);
  }, [diffIndex]);

  const activeDiff = diffs[diffIndex] ?? null;
  const activeCommand = commands[commandIndex] ?? null;

  return (
    <div className="computer-panel">
      <div className="computer-bezel">
        <div className="computer-header">
          <div className="dot red" />
          <div className="dot amber" />
          <div className="dot green" />
          <span className="muted">Run playback</span>
        </div>
        <ArtifactTimeline
          diffs={diffs.length}
          commands={commands.length}
          screenshots={screenshots.length}
          selectedDiff={diffIndex}
          selectedCommand={commandIndex}
          selectedScreenshot={shotIndex}
          onSelectDiff={(idx) => setDiffIndex(idx)}
          onSelectCommand={(idx) => setCommandIndex(idx)}
          onSelectScreenshot={(idx) => setShotIndex(idx)}
        />
        <div className="computer-body">
          <div className="computer-section">
            <div className="section-title">Diff</div>
            <DiffViewer diff={activeDiff} fileIndex={fileIndex} onFileChange={setFileIndex} />
          </div>
          <div className="computer-section">
            <div className="section-title">Terminal</div>
            <TerminalPlayback command={activeCommand} />
          </div>
          <div className="computer-section">
            <div className="section-title">Browser</div>
            <ScreenshotCarousel screenshots={screenshots} index={shotIndex} onSelect={setShotIndex} />
          </div>
        </div>
      </div>
    </div>
  );
}
