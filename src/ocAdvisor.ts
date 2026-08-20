import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { Database } from 'bun:sqlite';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DB_PATH = join(homedir(), '.local/share/opencode/opencode.db');
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ADVISOR_MODEL = 'claude-fable-5';
const MAX_TOKENS = 4096;
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FABLE_DISABLED =
  'ocAdvisor is disabled for anthropic/claude-fable-* sessions — the current model is already Fable.';

const ENV_SEARCH_PATHS = [
  join(PROJECT_ROOT, '.env'),
  join(homedir(), '.config/opencode/tool/.env'),
  join(homedir(), '.config/opencode/.env'),
  join(homedir(), '.env'),
];

const SYSTEM_BASE = `You are a senior advisor reviewing a coding agent's work. You have the full session transcript.
Respond in 500-750 words with structured analysis and enumerated steps. Be direct and actionable.`;

const SYSTEM_PROMPTS: Record<string, string> = {
  general: `${SYSTEM_BASE}
You are a senior software engineer. Analyze the conversation, identify issues, misunderstandings, or missed opportunities. Suggest corrections and improvements. If the agent is on the right track, confirm and suggest optimizations.`,
  review: `${SYSTEM_BASE}
You are a code reviewer. Focus on correctness, edge cases, security vulnerabilities, performance issues, and adherence to best practices. Evaluate the code changes in context of the broader codebase patterns visible in the transcript.`,
  plan: `${SYSTEM_BASE}
You are a software architect. Evaluate the current approach and plan. Identify risks, suggest alternatives, flag missing considerations. Assess whether the scope is appropriate and dependencies are accounted for.`,
  debug: `${SYSTEM_BASE}
You are a debugger. Analyze error patterns, stack traces, and failed attempts in the transcript. Identify root causes, explain why previous fixes didn't work, and propose targeted solutions.`,
};

const TOOL_DESCRIPTION = `Consult an advanced model as a senior advisor. Reads the full session transcript directly from the OpenCode database — including parent sessions for subagents — and sends it to Fable 5 for high-quality analysis.

Use this when you need a second opinion on your approach, want a thorough code review, need help debugging a persistent issue, or want architectural guidance before committing to a plan.

Modes: "general" (default), "review" (code review), "plan" (architecture), "debug" (error analysis).
`;

const OCADVISOR_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['general', 'review', 'plan', 'debug'],
      description: 'Advisory mode: general, review, plan, or debug',
    },
    question: {
      type: 'string',
      description: 'Optional specific question to focus the advisor on',
    },
  },
};

interface SessionRow {
  id: string;
  parent_id: string | null;
  title: string;
  directory: string;
}

interface MessageRow {
  id: string;
  data: string;
  time_created: number;
}

interface PartRow {
  data: string;
  time_created: number;
}

interface SessionMessageRow {
  type: string;
  data: string;
}

interface SessionModel {
  id?: string;
  modelID?: string;
  providerID?: string;
  provider?: string;
}

async function loadEnvKey(varName: string): Promise<string | null> {
  for (const envPath of ENV_SEARCH_PATHS) {
    try {
      const content = await readFile(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const eqIdx = trimmed.indexOf('=');
        const key = trimmed.slice(0, eqIdx).trim();
        if (key !== varName) continue;
        let value = trimmed.slice(eqIdx + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (value) return value;
      }
    } catch {
      // File not found, try next
    }
  }
  return null;
}

async function getApiKey(): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  const envKey = await loadEnvKey('ANTHROPIC_API_KEY');
  if (envKey) return envKey;

  return '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';
}

function openDb(): InstanceType<typeof Database> {
  return new Database(DB_PATH, { readonly: true });
}

function tableExists(db: InstanceType<typeof Database>, name: string): boolean {
  const row = db
    .query(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name) as { ok?: number } | null;
  return Boolean(row);
}

function parseModelJson(raw: string | null | undefined): SessionModel | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as SessionModel;
  } catch {}
  return null;
}

function getSessionModel(
  db: InstanceType<typeof Database>,
  sessionId: string,
): SessionModel | null {
  if (tableExists(db, 'session_v2')) {
    const row = db
      .query<
        { model: string | null },
        [string]
      >('SELECT model FROM session_v2 WHERE id = ?')
      .get(sessionId);
    const model = parseModelJson(row?.model);
    if (model) return model;
  }
  if (tableExists(db, 'session')) {
    const row = db
      .query<
        { model: string | null },
        [string]
      >('SELECT model FROM session WHERE id = ?')
      .get(sessionId);
    return parseModelJson(row?.model);
  }
  return null;
}

function isFableModel(
  model:
    | {
        providerID?: string;
        provider?: string;
        id?: string;
        modelID?: string;
      }
    | null
    | undefined,
): boolean {
  if (!model) return false;
  const provider = String(
    model.providerID || model.provider || '',
  ).toLowerCase();
  const id = String(model.id || model.modelID || '').toLowerCase();
  return provider.includes('anthropic') && id.includes('fable');
}

function isFableSession(
  db: InstanceType<typeof Database>,
  sessionId: string,
): boolean {
  return isFableModel(getSessionModel(db, sessionId));
}

function getSession(
  db: InstanceType<typeof Database>,
  sessionId: string,
): SessionRow | null {
  return db
    .query<
      SessionRow,
      [string]
    >('SELECT id, parent_id, title, directory FROM session WHERE id = ?')
    .get(sessionId);
}

function getSessionV2(
  db: InstanceType<typeof Database>,
  sessionId: string,
): SessionRow | null {
  return db
    .query<
      SessionRow,
      [string]
    >('SELECT id, parent_id, title, directory FROM session_v2 WHERE id = ?')
    .get(sessionId);
}

function getMessages(
  db: InstanceType<typeof Database>,
  sessionId: string,
): MessageRow[] {
  return db
    .query<
      MessageRow,
      [string]
    >('SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC')
    .all(sessionId);
}

function getParts(
  db: InstanceType<typeof Database>,
  messageId: string,
): PartRow[] {
  return db
    .query<
      PartRow,
      [string]
    >('SELECT data, time_created FROM part WHERE message_id = ? ORDER BY time_created ASC')
    .all(messageId);
}

function getSessionMessages(
  db: InstanceType<typeof Database>,
  sessionId: string,
): SessionMessageRow[] {
  return db
    .query<
      SessionMessageRow,
      [string]
    >('SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq ASC')
    .all(sessionId);
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + '\n... (truncated)' : value;
}

function stringifyUnknown(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function formatPartContent(part: Record<string, any>): string | null {
  switch (part.type) {
    case 'text':
      return part.text || null;
    case 'tool': {
      const name = part.tool || part.name || 'unknown';
      const status = part.state?.status || 'unknown';
      const lines: string[] = [`[Tool: ${name}] (${status})`];
      if (part.state?.input) {
        lines.push(
          `Input: ${truncate(stringifyUnknown(part.state.input), 2000)}`,
        );
      }
      const output = part.state?.output ?? part.state?.content;
      if (output) {
        lines.push(`Output: ${truncate(stringifyUnknown(output), 3000)}`);
      }
      if (part.state?.error) lines.push(`Error: ${part.state.error}`);
      return lines.join('\n');
    }
    case 'compaction':
      return `[Context compaction occurred${part.auto ? ' (auto)' : ' (manual)'}]`;
    default:
      return null;
  }
}

function formatV2Content(block: Record<string, any>): string | null {
  switch (block.type) {
    case 'text':
      return block.text || null;
    case 'reasoning':
      return null;
    case 'tool':
      return formatPartContent({
        type: 'tool',
        tool: block.name || block.tool,
        state: block.state,
      });
    default:
      return typeof block.text === 'string' && block.text ? block.text : null;
  }
}

function formatV2Message(
  type: string,
  data: Record<string, any>,
): string | null {
  if (type === 'user') {
    const text = typeof data.text === 'string' ? data.text : '';
    return text ? `## User\n${text}` : null;
  }
  if (type === 'assistant') {
    const agent = data.agent ? ` (agent: ${data.agent})` : '';
    const modelId = data.model?.id || data.model?.modelID;
    const model = modelId ? ` [${modelId}]` : '';
    const parts: string[] = [];
    for (const block of data.content || []) {
      if (!block || typeof block !== 'object') continue;
      const content = formatV2Content(block);
      if (content) parts.push(content);
    }
    if (parts.length === 0) return null;
    return `## Assistant${agent}${model}\n${parts.join('\n\n')}`;
  }
  if (type === 'compaction') {
    const auto = data.reason === 'auto' || data.auto;
    const summary =
      typeof data.summary === 'string' && data.summary
        ? `\n${truncate(data.summary, 2000)}`
        : '';
    return `[Context compaction occurred${auto ? ' (auto)' : ' (manual)'}]${summary}`;
  }
  if (type === 'synthetic' && typeof data.text === 'string' && data.text) {
    return `## Synthetic\n${truncate(data.text, 3000)}`;
  }
  if (type === 'system' && typeof data.text === 'string' && data.text) {
    return `## System\n${truncate(data.text, 2000)}`;
  }
  return null;
}

function buildTranscriptV1(
  db: InstanceType<typeof Database>,
  sessionId: string,
  visited = new Set<string>(),
): string {
  if (visited.has(sessionId)) return '';
  visited.add(sessionId);

  const session = getSession(db, sessionId);
  if (!session) return '';

  const sections: string[] = [];

  if (session.parent_id && !visited.has(session.parent_id)) {
    const parentTranscript = buildTranscriptV1(db, session.parent_id, visited);
    if (parentTranscript) {
      sections.push(
        `═══ Parent Session: ${getSession(db, session.parent_id)?.title || session.parent_id} ═══\n`,
        parentTranscript,
        `\n═══ Current Subagent Session: ${session.title} ═══\n`,
      );
    }
  }

  const messages = getMessages(db, sessionId);
  for (const msg of messages) {
    let msgData: Record<string, any>;
    try {
      msgData = JSON.parse(msg.data);
    } catch {
      continue;
    }

    const role = msgData.role === 'assistant' ? 'Assistant' : 'User';
    const agent = msgData.agent ? ` (agent: ${msgData.agent})` : '';
    const model = msgData.model?.modelID ? ` [${msgData.model.modelID}]` : '';

    const parts = getParts(db, msg.id);
    const partTexts: string[] = [];
    for (const part of parts) {
      let partData: Record<string, any>;
      try {
        partData = JSON.parse(part.data);
      } catch {
        continue;
      }
      const content = formatPartContent(partData);
      if (content) partTexts.push(content);
    }

    if (partTexts.length > 0) {
      sections.push(`## ${role}${agent}${model}\n${partTexts.join('\n\n')}`);
    }
  }

  return sections.join('\n\n');
}

function buildTranscriptV2(
  db: InstanceType<typeof Database>,
  sessionId: string,
  visited = new Set<string>(),
): string {
  if (visited.has(sessionId)) return '';
  visited.add(sessionId);

  const session = getSessionV2(db, sessionId);
  if (!session) return '';

  const sections: string[] = [];

  if (session.parent_id && !visited.has(session.parent_id)) {
    const parentTranscript = buildTranscriptV2(db, session.parent_id, visited);
    if (parentTranscript) {
      sections.push(
        `═══ Parent Session: ${getSessionV2(db, session.parent_id)?.title || session.parent_id} ═══\n`,
        parentTranscript,
        `\n═══ Current Subagent Session: ${session.title} ═══\n`,
      );
    }
  }

  for (const msg of getSessionMessages(db, sessionId)) {
    let data: Record<string, any>;
    try {
      data = JSON.parse(msg.data);
    } catch {
      continue;
    }
    const formatted = formatV2Message(msg.type, data);
    if (formatted) sections.push(formatted);
  }

  return sections.join('\n\n');
}

function buildTranscript(
  db: InstanceType<typeof Database>,
  sessionId: string,
): string {
  if (tableExists(db, 'session_message')) {
    const row = db
      .query('SELECT 1 AS ok FROM session_message WHERE session_id = ? LIMIT 1')
      .get(sessionId) as { ok?: number } | null;
    if (row) return buildTranscriptV2(db, sessionId);
  }
  return buildTranscriptV1(db, sessionId);
}

async function callAdvisor(
  systemPrompt: string,
  transcript: string,
  question: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = await getApiKey();

  const userContent = question
    ? `Here is the full session transcript:\n\n${transcript}\n\n---\n\nSpecific question: ${question}`
    : `Here is the full session transcript:\n\n${transcript}\n\n---\n\nPlease analyze the above session and provide your advisory guidance.`;

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ADVISOR_MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errorBody}`);
  }

  const result = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = result.content
    ?.filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const usage = result.usage;
  const usageStr = usage
    ? `\n\n---\n_ocAdvisor: ${usage.input_tokens?.toLocaleString()} input + ${usage.output_tokens?.toLocaleString()} output tokens (${ADVISOR_MODEL})_`
    : '';

  return (text || '(No response from advisor)') + usageStr;
}

async function runAdvisor(opts: {
  sessionId?: string;
  mode?: string;
  question?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const sessionId = opts.sessionId;
  if (!sessionId) {
    return 'Error: No session ID available. ocAdvisor requires a valid OpenCode session context.';
  }

  let db: InstanceType<typeof Database> | null = null;
  try {
    db = openDb();
    if (isFableSession(db, sessionId)) return FABLE_DISABLED;

    const transcript = buildTranscript(db, sessionId);
    if (!transcript?.trim()) {
      return `No transcript found for session ${sessionId}.`;
    }

    const systemPrompt =
      SYSTEM_PROMPTS[opts.mode || 'general'] || SYSTEM_PROMPTS.general;
    return await callAdvisor(
      systemPrompt,
      transcript,
      opts.question,
      opts.signal,
    );
  } catch (err) {
    return `Error calling advisor: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    db?.close();
  }
}

export const OcAdvisorPlugin: Plugin = async () => {
  return {
    tool: {
      ocAdvisor: tool({
        description: TOOL_DESCRIPTION,
        args: {
          mode: tool.schema
            .enum(['general', 'review', 'plan', 'debug'])
            .default('general')
            .describe('Advisory mode: general, review, plan, or debug'),
          question: tool.schema
            .string()
            .optional()
            .describe('Optional specific question to focus the advisor on'),
        },
        async execute(args, context) {
          return runAdvisor({
            sessionId: context.sessionID,
            mode: args.mode,
            question: args.question,
            signal: context.abort,
          });
        },
      }),
    },
  };
};

export async function setupOcAdvisorV2(ctx: {
  tool?: { transform?: Function };
  session?: { hook?: Function };
}): Promise<(() => void) | void> {
  const registrations: Array<{ dispose?: () => Promise<void> | void }> = [];

  if (typeof ctx.tool?.transform === 'function') {
    const reg = await ctx.tool.transform(
      (draft: { add: (tool: unknown) => void }) => {
        draft.add({
          name: 'ocAdvisor',
          description: TOOL_DESCRIPTION,
          input: OCADVISOR_INPUT_SCHEMA,
          async execute(
            input: { mode?: string; question?: string },
            context: { sessionID?: string },
          ) {
            const text = await runAdvisor({
              sessionId: context.sessionID,
              mode: input?.mode,
              question: input?.question,
            });
            return { content: text };
          },
        });
      },
    );
    if (reg) registrations.push(reg);
  }

  if (typeof ctx.session?.hook === 'function') {
    const reg = await ctx.session.hook(
      'context',
      (event: {
        model?: { providerID?: string; id?: string; modelID?: string };
        tools?: Record<string, { description: string; input: unknown }>;
      }) => {
        if (!event.tools) return;
        for (const key of Object.keys(event.tools)) {
          if (key.toLowerCase().replace(/[^a-z]/g, '') === 'ocadvisor') {
            delete event.tools[key];
          }
        }
        if (isFableModel(event.model)) return;
        event.tools.ocAdvisor = {
          description: TOOL_DESCRIPTION,
          input: OCADVISOR_INPUT_SCHEMA,
        };
      },
    );
    if (reg) registrations.push(reg);
  }

  return () => {
    for (const reg of registrations) {
      try {
        reg.dispose?.();
      } catch {}
    }
  };
}

const plugin = {
  id: 'oc-advisor',
  setup: setupOcAdvisorV2,
  server: OcAdvisorPlugin,
};

export const OcAdvisorPluginV2 = plugin;
export default plugin;
