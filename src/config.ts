import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const DEFAULTS = {
  dirName: '.jevlens',
  confidenceThreshold: 0.7,
  maxRecordsPerFile: 5000,
  host: '127.0.0.1',
  port: 8787,
  overlapThreshold: 0.5,
} as const;

export interface JevLensConfig {
  /** Directory holding the JSONL trace files, config and exports. */
  storageDir: string;
  /** Decisions below this confidence are highlighted in the panel. */
  confidenceThreshold: number;
  /** Rotate to a new JSONL file after this many records. */
  maxRecordsPerFile: number;
  /** UI bind address. Keep it on localhost; JevLens has no auth. */
  host: string;
  /** UI port. */
  port: number;
  /** Force the offline mock provider (no API calls) even when a key exists. */
  mock: boolean;
  /**
   * Which Jev-compatible backend to call: `auto` (TypeSafe Jev when a key is
   * set, a local CLM server when CLM_BASE_URL is set, otherwise mock), `live`
   * (TypeSafe Jev), or `clm` (a self-hosted CLM server such as CLM-8B).
   */
  provider: 'auto' | 'live' | 'clm';
  /**
   * Endpoint override for whichever backend is selected, as a fallback for
   * `TYPESAFE_BASE_URL` / `CLM_BASE_URL`. URLs are not secret, so unlike the
   * API key this may live in the config file.
   */
  baseUrl?: string;
  /** Override the Jev model used for every call. */
  model?: string;
  /** Similarity above which two Choice options are flagged as overlapping. */
  overlapThreshold: number;
}

export type ConfigKey = keyof JevLensConfig;

const FILE_KEYS = new Set<string>([
  'storageDir',
  'confidenceThreshold',
  'maxRecordsPerFile',
  'host',
  'port',
  'mock',
  'provider',
  'baseUrl',
  'model',
  'overlapThreshold',
]);

function num(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function configFileFor(storageDir: string): string {
  return join(storageDir, 'config.json');
}

/**
 * Resolution order: built-in defaults < `.jevlens/config.json` < environment.
 * The API key is deliberately absent from this object — it is only ever read
 * from `process.env` by the Jev client and never persisted.
 */
export function loadConfig(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): JevLensConfig {
  const dirFromEnv = env.JEVLENS_DIR ? resolve(cwd, env.JEVLENS_DIR) : join(cwd, DEFAULTS.dirName);
  let file: Record<string, unknown> = {};
  try {
    const raw = readFileSync(configFileFor(dirFromEnv), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (FILE_KEYS.has(key)) file[key] = value;
      }
    }
  } catch {
    /* missing or unreadable config file is fine */
  }

  const pick = <T>(key: ConfigKey, fallback: T): T => {
    const value = file[key];
    if (value !== undefined && value !== null) return value as T;
    return fallback;
  };

  const thresholdFromEnv = num(env.JEVLENS_CONFIDENCE_THRESHOLD);
  const portFromEnv = num(env.JEVLENS_PORT);
  const maxFromEnv = num(env.JEVLENS_MAX_RECORDS);
  const mockFromEnv = bool(env.JEVLENS_MOCK);

  const config: JevLensConfig = {
    storageDir: env.JEVLENS_DIR
      ? dirFromEnv
      : resolve(cwd, String(pick('storageDir', DEFAULTS.dirName))),
    confidenceThreshold:
      thresholdFromEnv ?? Number(pick('confidenceThreshold', DEFAULTS.confidenceThreshold)),
    maxRecordsPerFile: maxFromEnv ?? Number(pick('maxRecordsPerFile', DEFAULTS.maxRecordsPerFile)),
    host: env.JEVLENS_HOST ?? String(pick('host', DEFAULTS.host)),
    port: portFromEnv ?? Number(pick('port', DEFAULTS.port)),
    mock: mockFromEnv ?? Boolean(pick('mock', false)),
    provider: parseProvider(pick('provider', 'auto')),
    baseUrl: pick('baseUrl', undefined) as string | undefined,
    model: env.TYPESAFE_DEFAULT_MODEL ?? (pick('model', undefined) as string | undefined),
    overlapThreshold: Number(pick('overlapThreshold', DEFAULTS.overlapThreshold)),
  };

  // A non-numeric value from a typoed config key falls back to the default,
  // never to a degenerate bound: clamp(NaN) → 0 would silently flag every
  // decision, and port NaN would surface only as an opaque listen error.
  const clamp01Or = (value: number, fallback: number): number =>
    Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
  config.confidenceThreshold = clamp01Or(config.confidenceThreshold, DEFAULTS.confidenceThreshold);
  config.overlapThreshold = clamp01Or(config.overlapThreshold, DEFAULTS.overlapThreshold);
  if (!Number.isFinite(config.maxRecordsPerFile) || config.maxRecordsPerFile < 1) {
    config.maxRecordsPerFile = DEFAULTS.maxRecordsPerFile;
  }
  if (!Number.isFinite(config.port)) config.port = DEFAULTS.port;
  return config;
}

function parseProvider(value: unknown): 'auto' | 'live' | 'clm' {
  const normalized = String(value ?? 'auto').toLowerCase().trim();
  return normalized === 'live' || normalized === 'clm' ? normalized : 'auto';
}

/** Persist a subset of keys into `<storageDir>/config.json` and return the stored file. */
export function saveConfig(storageDir: string, patch: Partial<JevLensConfig>): Partial<JevLensConfig> {
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configFileFor(storageDir), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    /* start from empty */
  }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'storageDir' || !FILE_KEYS.has(key)) continue;
    if (value === undefined) delete existing[key];
    else existing[key] = value;
  }
  mkdirSync(dirname(configFileFor(storageDir)), { recursive: true });
  writeFileSync(configFileFor(storageDir), `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  return existing as Partial<JevLensConfig>;
}

export function exportsDir(storageDir: string): string {
  return join(storageDir, 'exports');
}

/**
 * Addresses the panel may bind to.
 *
 * JevLens has no authentication, so the panel is loopback-only by design. Note
 * that `0.0.0.0` is *not* accepted here even though it looks harmless: the
 * request handler refuses every non-loopback peer, so binding all interfaces
 * would only expose a port that answers 403 to everyone who can reach it.
 */
export function isLoopbackHost(host: string): boolean {
  const cleaned = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (cleaned === 'localhost') return true;
  if (cleaned === '::1') return true;
  const match = /^127(\.\d{1,3}){3}$/.exec(cleaned);
  if (!match) return false;
  // The regex only bounds the digit count; `127.999.0.1` would be accepted
  // without this and then fail at listen time with an unrelated error.
  return cleaned
    .split('.')
    .slice(1)
    .every((octet) => Number(octet) <= 255);
}
