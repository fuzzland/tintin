export function mergeTextIntoSlackBlocks(text: string, blocks?: unknown[]): unknown[] | undefined {
  if (!blocks || blocks.length === 0) return blocks;
  const trimmed = text.trim();
  if (!trimmed) return blocks;
  const first = blocks[0];
  if (
    first &&
    typeof first === "object" &&
    (first as { type?: unknown }).type === "section" &&
    typeof (first as { text?: unknown }).text === "object"
  ) {
    return blocks;
  }
  const maxLen = 3000;
  const sectionText = trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 3)}...` : trimmed;
  return [{ type: "section", text: { type: "mrkdwn", text: sectionText } }, ...blocks];
}
