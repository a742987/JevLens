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
    model: env.TYPESAFE_DEFAULT_MODEL ?? (pick('model', undefined) as string | undefined),
    overlapThreshold: Number(pick('overlapThreshold', DEFAULTS.overlapThreshold)),
  };

  config.confidenceThreshold = clamp(config.confidenceThreshold, 0, 1);
  config.overlapThreshold = clamp(config.overlapThreshold, 0, 1);
  if (!Number.isFinite(config.maxRecordsPerFile) || config.maxRecordsPerFile < 1) {
    config.maxRecordsPerFile = DEFAULTS.maxRecordsPerFile;
  }
  return config;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
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
  return /^127(\.\d{1,3}){3}$/.test(cleaned);
}
