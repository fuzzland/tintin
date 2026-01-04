import type { ScreenshotItem } from "../types";

interface ScreenshotCarouselProps {
  screenshots: ScreenshotItem[];
  index: number;
  onSelect: (index: number) => void;
}

export default function ScreenshotCarousel({ screenshots, index, onSelect }: ScreenshotCarouselProps) {
  if (screenshots.length === 0) {
    return <div className="screenshot-empty">No screenshots yet.</div>;
  }
  const current = screenshots[index] ?? screenshots[0]!;
  return (
    <div className="screenshot-carousel">
      <div className="screenshot-frame">
        <img src={current.url} alt={current.tool ?? "Screenshot"} />
      </div>
      <div className="screenshot-meta">
        <span>{current.tool ?? "Browser"}</span>
        <span className="muted">{new Date(current.created_at).toLocaleTimeString()}</span>
      </div>
      <div className="screenshot-controls">
        <button className="ghost" onClick={() => onSelect(Math.max(0, index - 1))}>
          Prev
        </button>
        <span className="muted">
          {index + 1} / {screenshots.length}
        </span>
        <button className="ghost" onClick={() => onSelect(Math.min(screenshots.length - 1, index + 1))}>
          Next
        </button>
      </div>
    </div>
  );
}
