/**
 * PromptService — loads, caches, and interpolates LLM prompt templates.
 *
 * Templates are stored as plain-text `.txt` files under `src/prompts/` with
 * `{{variable}}` placeholders. The service:
 *
 * 1. Loads all templates from disk at startup (or on first use) and caches
 *    them in memory to avoid repeated I/O.
 * 2. Interpolates `{{variable}}` placeholders with the supplied values map.
 * 3. Rejects prompts that exceed 8 000 characters with a `PromptTooLongError`
 *    before the string reaches Venice AI.
 * 4. Logs the SHA-256 hash of the final prompt (never the raw content) for
 *    debugging/tracing.
 */
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createLogger } from '../utils/logger';

const log = createLogger({ component: 'prompt-service' });

/** Maximum characters allowed in a prompt sent to Venice AI. */
export const MAX_PROMPT_CHARS = 8_000;

/** Names of all built-in agent template files (without the `.txt` extension). */
export const AGENT_TEMPLATE_NAMES = [
  'research',
  'risk',
  'coding',
  'design',
  'report',
] as const;

export type AgentTemplateName = (typeof AGENT_TEMPLATE_NAMES)[number];

export class PromptTooLongError extends Error {
  constructor(
    public readonly length: number,
    public readonly max: number = MAX_PROMPT_CHARS,
  ) {
    super(
      `Prompt exceeds the ${max.toLocaleString()}-character limit (got ${length.toLocaleString()} characters). Shorten your inputs or split into multiple requests.`,
    );
    this.name = 'PromptTooLongError';
  }
}

export class TemplateNotFoundError extends Error {
  constructor(public readonly templateName: string) {
    super(`Prompt template "${templateName}" was not found.`);
    this.name = 'TemplateNotFoundError';
  }
}

export interface PromptServiceOptions {
  /** Absolute path to the directory that contains the `.txt` template files.
   *  Defaults to `<repo-root>/backend/src/prompts/`. */
  promptsDir?: string;
  /** Override the character limit (useful in tests). */
  maxChars?: number;
}

/**
 * PromptService — singleton-friendly, fully synchronous after the initial
 * load so it can be called from any async context without await.
 */
export class PromptService {
  private readonly promptsDir: string;
  private readonly maxChars: number;
  /** In-memory template cache: template name → raw template text. */
  private readonly cache: Map<string, string> = new Map();
  private loaded = false;

  constructor(options: PromptServiceOptions = {}) {
    this.promptsDir =
      options.promptsDir ??
      resolve(__dirname, '../prompts');
    this.maxChars = options.maxChars ?? MAX_PROMPT_CHARS;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Load all agent templates from disk into the in-memory cache.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  loadAll(): void {
    if (this.loaded) return;

    for (const name of AGENT_TEMPLATE_NAMES) {
      this.loadTemplate(name);
    }

    this.loaded = true;
    log.info({ count: this.cache.size }, 'Prompt templates loaded');
  }

  /**
   * Build a prompt from the named template, substituting `{{variable}}`
   * placeholders with the provided `variables` map.
   *
   * @throws {TemplateNotFoundError} if the template has not been loaded.
   * @throws {PromptTooLongError}    if the interpolated prompt exceeds the
   *                                  character limit.
   */
  build(
    templateName: string,
    variables: Record<string, string> = {},
  ): string {
    // Ensure the template is in cache; attempt a lazy load if not.
    if (!this.cache.has(templateName)) {
      this.loadTemplate(templateName);
    }

    const raw = this.cache.get(templateName);
    if (raw === undefined) {
      throw new TemplateNotFoundError(templateName);
    }

    const interpolated = this.interpolate(raw, variables);

    if (interpolated.length > this.maxChars) {
      throw new PromptTooLongError(interpolated.length, this.maxChars);
    }

    // Log the SHA-256 hash for tracing without exposing prompt content.
    const hash = sha256(interpolated);
    log.debug({ templateName, promptHash: hash, length: interpolated.length }, 'Prompt built');

    return interpolated;
  }

  /**
   * Return the raw (un-interpolated) template text.
   * @throws {TemplateNotFoundError} if the template is not loaded.
   */
  getRawTemplate(templateName: string): string {
    if (!this.cache.has(templateName)) {
      this.loadTemplate(templateName);
    }
    const raw = this.cache.get(templateName);
    if (raw === undefined) throw new TemplateNotFoundError(templateName);
    return raw;
  }

  /** Returns true if the named template is currently cached. */
  has(templateName: string): boolean {
    return this.cache.has(templateName);
  }

  /** List all cached template names. */
  list(): string[] {
    return Array.from(this.cache.keys());
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Load a single template file from disk into the cache.
   * Silently skips if the file does not exist (logs a warning).
   */
  private loadTemplate(name: string): void {
    const filePath = resolve(this.promptsDir, `${name}.txt`);
    if (!existsSync(filePath)) {
      log.warn({ templateName: name, filePath }, 'Prompt template file not found — skipping');
      return;
    }
    const content = readFileSync(filePath, 'utf8');
    this.cache.set(name, content);
    log.debug({ templateName: name }, 'Prompt template cached');
  }

  /**
   * Interpolate `{{variable}}` placeholders in `template` with the values
   * from `variables`.
   *
   * - Unrecognised placeholders are left as-is (permissive).
   * - Handlebars-style block helpers `{{#variable}}...{{/variable}}` are
   *   rendered when the variable is truthy and stripped when falsy.
   */
  private interpolate(template: string, variables: Record<string, string>): string {
    let result = template;

    // 1. Handle conditional blocks: {{#key}}...{{/key}}
    //    Render the block content when `key` is non-empty, remove when empty.
    result = result.replace(
      /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
      (_match, key: string, block: string) => {
        const value = variables[key];
        if (value !== undefined && value.trim() !== '') {
          // Replace the inner placeholder too.
          return block.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
        }
        return '';
      },
    );

    // 2. Replace plain `{{variable}}` placeholders.
    result = result.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      return key in variables ? variables[key] : _match;
    });

    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let _instance: PromptService | null = null;

/** Return (or lazily create) the process-wide PromptService singleton. */
export function getPromptService(): PromptService {
  if (!_instance) {
    _instance = new PromptService();
    _instance.loadAll();
  }
  return _instance;
}

/** Replace the singleton (useful in tests). */
export function setPromptService(service: PromptService): void {
  _instance = service;
}
