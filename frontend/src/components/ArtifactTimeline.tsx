interface LaneProps {
  label: string;
  count: number;
  selected: number;
  onSelect: (index: number) => void;
}

function Lane({ label, count, selected, onSelect }: LaneProps) {
  const ticks = Array.from({ length: Math.max(count, 1) }, (_, i) => i);
  return (
    <div className="timeline-lane">
      <span className="lane-label">{label}</span>
      <div className="lane-track">
        {ticks.map((idx) => {
          const isActive = idx === selected;
          const left = count <= 1 ? "50%" : `${(idx / (count - 1)) * 100}%`;
          return (
            <button
              key={`${label}-${idx}`}
              className={`lane-tick${isActive ? " active" : ""}`}
              style={{ left }}
              onClick={() => onSelect(idx)}
              aria-label={`${label} ${idx + 1}`}
            />
          );
        })}
      </div>
    </div>
  );
}

export default function ArtifactTimeline(props: {
  diffs: number;
  commands: number;
  screenshots: number;
  selectedDiff: number;
  selectedCommand: number;
  selectedScreenshot: number;
  onSelectDiff: (index: number) => void;
  onSelectCommand: (index: number) => void;
  onSelectScreenshot: (index: number) => void;
}) {
  return (
    <div className="artifact-timeline">
      <Lane label="Edits" count={props.diffs} selected={props.selectedDiff} onSelect={props.onSelectDiff} />
      <Lane label="Terminal" count={props.commands} selected={props.selectedCommand} onSelect={props.onSelectCommand} />
      <Lane
        label="Browser"
        count={props.screenshots}
        selected={props.selectedScreenshot}
        onSelect={props.onSelectScreenshot}
      />
    </div>
  );
}
