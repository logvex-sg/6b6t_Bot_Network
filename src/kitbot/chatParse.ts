/**
 * Chat parsing for the kit bot.
 *
 * The bot only ever reacts to a line that (a) looks like a player chat line and (b) starts with the
 * configured prefix. Everything else — system messages, join/leave notices, our own output — is ignored.
 * Pure and synchronous so the matching rules are testable without a server.
 *
 * Supported line shapes (vanilla / 6b6t / most plugins):
 *   `<Steve> !kit`            vanilla public chat
 *   `Steve: !kit`             common plugin format
 *   `[Rank] Steve: !kit`      ranked plugin format
 *   `Steve » !kit`            some chat plugins
 *   `[Steve -> me] !kit`      whisper to the bot
 *   `Steve whispers to you: !kit`
 */

/** Characters that may appear in a Minecraft username (Bedrock/Geyser names can add . and spaces). */
const NAME = "[A-Za-z0-9_]{3,16}";

const CHAT_PATTERNS: RegExp[] = [
  // <Steve> !kit   /   <[Rank] Steve> !kit
  new RegExp(`^<\\s*(?:\\[[^\\]]+\\]\\s*)*(?<name>${NAME})\\s*>\\s*(?<msg>.*)$`),
  // [Rank] Steve: !kit   /   Steve: !kit
  new RegExp(`^(?:\\[[^\\]]+\\]\\s*)*(?<name>${NAME})\\s*:\\s*(?<msg>.*)$`),
  // Steve » !kit
  new RegExp(`^(?:\\[[^\\]]+\\]\\s*)*(?<name>${NAME})\\s*»\\s*(?<msg>.*)$`),
  // [Steve -> me] !kit   /   [Steve → me] !kit
  new RegExp(`^\\[\\s*(?<name>${NAME})\\s*(?:->|→)\\s*[^\\]]+\\]\\s*(?<msg>.*)$`),
  // Steve whispers to you: !kit
  new RegExp(`^(?<name>${NAME})\\s+whispers?\\s+to\\s+you\\s*:\\s*(?<msg>.*)$`, "i"),
];

export interface ChatCommand {
  /** The player who sent the line. */
  username: string;
  /** The message text with the speaker stripped, trimmed. */
  message: string;
}

/**
 * Extracts the speaker and message from a chat line. Returns `null` for anything that is not recognisably
 * a player chat line (system text, our own plain output, blank lines).
 */
export function parseChatLine(raw: string): ChatCommand | null {
  const line = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return null;
  for (const pattern of CHAT_PATTERNS) {
    const m = pattern.exec(line);
    if (!m?.groups) continue;
    const username = m.groups.name?.trim();
    const message = (m.groups.msg ?? "").trim();
    if (!username) continue;
    return { username, message };
  }
  return null;
}

export interface KitRequest {
  username: string;
  /** The command word after the prefix, lower-cased (e.g. "kit", "stock", "help"). */
  command: string;
  /** Anything after the command word. */
  args: string[];
}

/**
 * Matches a chat line against the configured prefix and returns the request, or `null` when the line is not
 * a kit-bot request. Matching is case-insensitive on the prefix so `!Kit` and `!kit` both work.
 */
export function parseKitRequest(raw: string, prefix: string): KitRequest | null {
  const parsed = parseChatLine(raw);
  if (!parsed) return null;
  const pfx = (prefix || "!").trim();
  if (!pfx) return null;
  if (!parsed.message.toLowerCase().startsWith(pfx.toLowerCase())) return null;

  const after = parsed.message.slice(pfx.length).trim();
  if (!after) return { username: parsed.username, command: "", args: [] };
  const parts = after.split(/\s+/).filter(Boolean);
  return {
    username: parsed.username,
    command: (parts[0] ?? "").toLowerCase(),
    args: parts.slice(1),
  };
}

/** Normalises a username for comparison (Minecraft names are case-insensitive in practice). */
export function normaliseName(name: string): string {
  return String(name ?? "").trim().toLowerCase();
}
