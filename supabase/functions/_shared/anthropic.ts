// Minimal Anthropic Messages API client (raw HTTP, as the brief specifies).
export const ANTHROPIC_MODEL = 'claude-sonnet-5-5';

type TextBlock = { type: 'text'; text: string };
type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
export type ContentBlock = TextBlock | ImageBlock;

type ApiResponse = {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  error?: { type?: string; message?: string };
};

export class ClaudeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Sends one user turn and returns the concatenated text reply.
 * Opts into server-side refusal fallbacks; if the account rejects that beta (400),
 * retries once without it.
 */
export async function askClaude(opts: {
  apiKey: string;
  system: string;
  content: ContentBlock[];
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
}): Promise<string> {
  const base = {
    model: ANTHROPIC_MODEL,
    max_tokens: opts.maxTokens ?? 4000,
    system: opts.system,
    output_config: { effort: opts.effort ?? 'low' },
    messages: [{ role: 'user', content: opts.content }],
  };

  const send = (withFallback: boolean) =>
    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': opts.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(withFallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
      },
      body: JSON.stringify(withFallback ? { ...base, fallbacks: 'default' } : base),
    });

  let res = await send(true);
  if (res.status === 400) res = await send(false);
  const data = (await res.json().catch(() => ({}))) as ApiResponse;
  if (!res.ok) throw new ClaudeError(data.error?.message ?? `Anthropic request failed (${res.status})`, res.status);
  if (data.stop_reason === 'refusal') throw new ClaudeError('The model declined this request', 422);
  return (data.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}

/** Pull the first JSON object out of a model reply (tolerates code fences / stray prose). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v: unknown = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const stringArray = (v: unknown, max = 20): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()).slice(0, max) : [];
