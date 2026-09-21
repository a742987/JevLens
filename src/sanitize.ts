import type { JsonValue } from './types.ts';

const SENSITIVE_KEY =
  /(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|bearer|token|secret|password|passwd|credential|authorization|cookie)/i;

const REDACTED = '[redacted]';
const MAX_STRING_CHARS = 20_000;
const LOOKS_LIKE_KEY = /\b(sk|pk|pat|ghp|xoxb|ai)[A-Za-z0-9_-]{12,}\b/g;

/** Environment values that must never reach disk. */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 12) continue;
    if (SENSITIVE_KEY.test(key)) out.push(value);
  }
  return out;
}

/**
 * Defence in depth for trace files and exports: values stored under a
 * credential-shaped key are dropped, credential-shaped strings and any known
 * secret value are masked, and oversized strings are truncated.
 */
export function scrub(value: JsonValue, secrets: string[] = [], depth = 0): JsonValue {
  if (depth > 12) return '[truncated: too deep]';
  if (typeof value === 'string') return maskStrings(value, secrets);
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets, depth + 1));
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrub(item, secrets, depth + 1);
  }
  return out;
}

function maskStrings(value: string, secrets: string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  out = out.replace(LOOKS_LIKE_KEY, REDACTED);
  if (out.length > MAX_STRING_CHARS) {
    out = `${out.slice(0, MAX_STRING_CHARS)}\n[truncated ${out.length - MAX_STRING_CHARS} chars]`;
  }
  return out;
}
