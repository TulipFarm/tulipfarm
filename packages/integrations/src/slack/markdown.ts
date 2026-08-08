const CODE_MARKER = "";

/** Converts CommonMark (the LLM's answer format) into Slack mrkdwn for the top-level `text` field. */
export function toSlackMrkdwn(markdown: string): string {
  const code: string[] = [];
  const protect = (match: string): string => {
    code.push(match);
    return `${CODE_MARKER}${code.length - 1}${CODE_MARKER}`;
  };

  let text = markdown.replace(/```[\s\S]*?```/g, protect).replace(/`[^`\n]+`/g, protect);

  text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>");
  text = text.replace(/^(\s*)[-*]\s+/gm, "$1• ");
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*");
  text = text.replace(/__(.+?)__/g, "*$1*");
  text = text.replace(/~~(.+?)~~/g, "~$1~");

  return text.replace(/(\d+)/g, (_, i: string) => code[Number(i)] ?? "");
}
