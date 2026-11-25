// OpenCode 2.4+ stores assistant content blocks in `session_part`, one row per
// block in `ordinal` order, and leaves `session_message.data.content` empty.
// Earlier releases kept the blocks inline. Every reader goes through these
// helpers so it sees the blocks wherever they live.
import type { Database } from "bun:sqlite";

type Db = InstanceType<typeof Database>;
export type ContentBlock = Record<string, any>;
export type PartsByMessage = Map<string, ContentBlock[]>;

export function hasSessionParts(db: Db): boolean {
  try {
    return Boolean(
      db
        .query(
          "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'session_part'",
        )
        .get(),
    );
  } catch {
    return false;
  }
}

// Rows must arrive ordered by message, then ordinal.
function groupParts(
  rows: Array<{ message_id: string; data: string }>,
): PartsByMessage {
  const parts: PartsByMessage = new Map();
  for (const row of rows) {
    let block: unknown;
    try {
      block = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const list = parts.get(row.message_id);
    if (list) list.push(block as ContentBlock);
    else parts.set(row.message_id, [block as ContentBlock]);
  }
  return parts;
}

// Reasoning blocks are never shown to the advisor or the gate, and their
// signatures are large, so they are filtered in SQL. `toolsOnly` narrows
// further for readers that only look at tool calls.
function partTypeFilter(toolsOnly: boolean): string {
  return toolsOnly ? "type = 'tool'" : "type != 'reasoning'";
}

// One query for a whole session instead of one per message.
export function loadSessionParts(
  db: Db,
  sessionId: string,
  options: { toolsOnly?: boolean } = {},
): PartsByMessage {
  if (!hasSessionParts(db)) return new Map();
  try {
    return groupParts(
      db
        .query<{ message_id: string; data: string }, [string]>(
          `SELECT message_id, data FROM session_part WHERE session_id = ? AND ${partTypeFilter(options.toolsOnly ?? false)} ORDER BY message_id, ordinal`,
        )
        .all(sessionId),
    );
  } catch {
    return new Map();
  }
}

export function loadMessageParts(
  db: Db,
  messageId: string,
  options: { toolsOnly?: boolean } = {},
): ContentBlock[] {
  if (!hasSessionParts(db)) return [];
  try {
    return (
      groupParts(
        db
          .query<{ message_id: string; data: string }, [string]>(
            `SELECT message_id, data FROM session_part WHERE message_id = ? AND ${partTypeFilter(options.toolsOnly ?? false)} ORDER BY ordinal`,
          )
          .all(messageId),
      ).get(messageId) ?? []
    );
  } catch {
    return [];
  }
}

// Tool names only, as `{ type: "tool", name }` blocks, for reports that
// count calls over long windows without loading every tool's output.
export function loadToolNamesInWindow(
  db: Db,
  startMs: number,
  endMs: number,
): PartsByMessage {
  const names: PartsByMessage = new Map();
  if (!hasSessionParts(db)) return names;
  try {
    const rows = db
      .query<{ message_id: string; name: string | null }, [number, number]>(
        "SELECT p.message_id AS message_id, json_extract(p.data, '$.name') AS name FROM session_message m JOIN session_part p ON p.message_id = m.id " +
          "WHERE m.type = 'assistant' AND m.time_created >= ? AND m.time_created < ? AND p.type = 'tool' " +
          "ORDER BY p.message_id, p.ordinal",
      )
      .all(startMs, endMs);
    for (const row of rows) {
      const block: ContentBlock = { type: "tool", name: row.name ?? "" };
      const list = names.get(row.message_id);
      if (list) list.push(block);
      else names.set(row.message_id, [block]);
    }
  } catch {}
  return names;
}

// Tool parts of assistant messages created in [startMs, endMs). `dataLike`
// narrows the scan to parts whose JSON contains the given text.
export function loadToolPartsInWindow(
  db: Db,
  startMs: number,
  endMs: number,
  dataLike?: string,
): PartsByMessage {
  if (!hasSessionParts(db)) return new Map();
  const filter = dataLike === undefined ? "" : " AND p.data LIKE ?";
  const params: Array<string | number> = [startMs, endMs];
  if (dataLike !== undefined) params.push(`%${dataLike}%`);
  try {
    return groupParts(
      db
        .query<{ message_id: string; data: string }, Array<string | number>>(
          "SELECT p.message_id AS message_id, p.data AS data FROM session_message m JOIN session_part p ON p.message_id = m.id " +
            `WHERE m.type = 'assistant' AND m.time_created >= ? AND m.time_created < ? AND p.type = 'tool'${filter} ` +
            "ORDER BY p.message_id, p.ordinal",
        )
        .all(...params),
    );
  } catch {
    return new Map();
  }
}

// The message data with its content blocks filled in from parts when the
// inline content is missing or empty.
export function withPartContent(
  data: ContentBlock,
  parts: ContentBlock[] | undefined,
): ContentBlock {
  if (Array.isArray(data.content) && data.content.length > 0) return data;
  if (!parts || parts.length === 0) return data;
  return { ...data, content: parts };
}
