import { PromptService, PromptTooLongError, TemplateNotFoundError, MAX_PROMPT_CHARS } from './promptService';
import { resolve } from 'path';

/** Path to the real prompts directory. */
const REAL_PROMPTS_DIR = resolve(__dirname, '../prompts');

describe('PromptService', () => {
  // ─── loadAll & has ────────────────────────────────────────────────────────

  it('loads all five agent templates on loadAll()', () => {
    const svc = new PromptService({ promptsDir: REAL_PROMPTS_DIR });
    svc.loadAll();

    for (const name of ['research', 'risk', 'coding', 'design', 'report']) {
      expect(svc.has(name)).toBe(true);
    }
    expect(svc.list()).toHaveLength(5);
  });

  it('loadAll() is idempotent — calling twice does not duplicate templates', () => {
    const svc = new PromptService({ promptsDir: REAL_PROMPTS_DIR });
    svc.loadAll();
    svc.loadAll(); // second call is a no-op
    expect(svc.list()).toHaveLength(5);
  });

  // ─── interpolation ────────────────────────────────────────────────────────

  it('interpolates {{variable}} placeholders correctly', () => {
    const svc = new PromptService({ promptsDir: REAL_PROMPTS_DIR });
    // Build a lightweight in-memory template for isolation.
    (svc as any).cache.set('test', 'Hello {{name}}, your task is {{task}}.');

    const result = svc.build('test', { name: 'Alice', task: 'research Stellar' });
    expect(result).toBe('Hello Alice, your task is research Stellar.');
  });

  it('leaves unrecognised placeholders unchanged', () => {
    const svc = new PromptService({ promptsDir: REAL_PROMPTS_DIR });
    (svc as any).cache.set('test', 'Value: {{known}} and {{unknown}}.');

    const result = svc.build('test', { known: 'hello' });
    expect(result).toContain('{{unknown}}');
    expect(result).toContain('hello');
  });

  it('renders conditional blocks when the key is present', () => {
    const svc = new PromptService({ promptsDir: REAL_PROMPTS_DIR });
    (svc as any).cache.set('test', 'Start. {{#extra}}Extra: {{extra}}{{/extra}} End.');

    const result = svc.build('test', { extra: 'bonus content' });
    expect(result).toContain('Extra: bonus content');
  });

  it('strips conditional blocks when the key is absent', () => {
    const svc = new PromptService({ promptsDir: REAL_PROMPTS_DIR });
    (svc as any).cache.set('test', 'Start. {{#extra}}SHOULD NOT APPEAR{{/extra}} End.');

    const result = svc.build('test', {});
    expect(result).not.toContain('SHOULD NOT APPEAR');
    expect(result).toContain('Start.');
    expect(result).toContain('End.');
  });

  it('strips conditional blocks when the key is an empty string', () => {
    const svc = new PromptService({ promptsDir: REAL_PROMPTS_DIR });
    (svc as any).cache.set('test', 'A {{#ctx}}ctx={{ctx}}{{/ctx}} B.');

    const result = svc.build('test', { ctx: '' });
    expect(result).not.toContain('ctx=');
  });

  // ─── character limit ──────────────────────────────────────────────────────

  it(`throws PromptTooLongError when the prompt exceeds ${MAX_PROMPT_CHARS} characters`, () => {
    const svc = new PromptService({ promptsDir: REAL_PROMPTS_DIR });
    // Template whose interpolated output will exceed the limit.
    (svc as any).cache.set('test', '{{content}}');

    const longContent = 'x'.repeat(MAX_PROMPT_CHARS + 1);
    expect(() => svc.build('test', { content: longContent })).toThrow(PromptTooLongError);
  });

  it('accepts a prompt at exactly the character limit', () => {
    const svc = new PromptService({ promptsDir: REAL_PROMPTS_DIR });
    (svc as any).cache.set('test', '{{content}}');

    const exactContent = 'x'.repeat(MAX_PROMPT_CHARS);
    expect(() => svc.build('test', { content: exactContent })).not.toThrow();
  });

  it('PromptTooLongError carries the correct length and max values', () => {
    const svc = new PromptService({ promptsDir: REAL_PROMPTS_DIR });
    (svc as any).cache.set('test', '{{content}}');

    const overContent = 'y'.repeat(MAX_PROMPT_CHARS + 500);
    let caught: PromptTooLongError | null = null;
    try {
      svc.build('test', { content: overContent });
    } catch (err) {
      caught = err as PromptTooLongError;
    }
    expect(caught).toBeInstanceOf(PromptTooLongError);
    expect(caught!.length).toBe(MAX_PROMPT_CHARS + 500);
    expect(caught!.max).toBe(MAX_PROMPT_CHARS);
  });

  it('respects a custom maxChars option', () => {
    const svc = new PromptService({ promptsDir: REAL_PROMPTS_DIR, maxChars: 10 });
    (svc as any).cache.set('test', '{{content}}');

    expect(() => svc.build('test', { content: '12345678901' })).toThrow(PromptTooLongError);
    expect(() => svc.build('test', { content: '1234567890' })).not.toThrow();
  });

  // ─── TemplateNotFoundError ────────────────────────────────────────────────

  it('throws TemplateNotFoundError for an unknown template name', () => {
    const svc = new PromptService({ promptsDir: '/nonexistent-directory' });
    expect(() => svc.build('does-not-exist', {})).toThrow(TemplateNotFoundError);
  });

  it('TemplateNotFoundError carries the template name', () => {
    const svc = new PromptService({ promptsDir: '/nonexistent-directory' });
    let caught: TemplateNotFoundError | null = null;
    try {
      svc.build('ghost-template', {});
    } catch (err) {
      caught = err as TemplateNotFoundError;
    }
    expect(caught).toBeInstanceOf(TemplateNotFoundError);
    expect(caught!.templateName).toBe('ghost-template');
  });

  // ─── hash logging (side-effect only — no content leak) ───────────────────

  it('does not include raw prompt content in log output', () => {
    const svc = new PromptService({ promptsDir: REAL_PROMPTS_DIR });
    const secretContent = 'SUPER_SECRET_PROMPT_DO_NOT_LOG';
    (svc as any).cache.set('test', secretContent);

    // Spy on the internal logger's debug method.
    const debugSpy = jest.spyOn((svc as any).log ?? { debug: () => {} }, 'debug');

    // Build the prompt — debug logging fires internally but should never
    // pass the raw content.
    try {
      svc.build('test', {});
    } catch {
      // PromptTooLongError may or may not fire depending on length; irrelevant.
    }

    for (const call of debugSpy.mock.calls) {
      const stringified = JSON.stringify(call);
      expect(stringified).not.toContain(secretContent);
    }
  });

  // ─── real templates smoke-test ────────────────────────────────────────────

  it('builds a research prompt with topic variable', () => {
    const svc = new PromptService({ promptsDir: REAL_PROMPTS_DIR });
    svc.loadAll();

    const prompt = svc.build('research', { topic: 'Stellar blockchain adoption' });
    expect(prompt).toContain('Stellar blockchain adoption');
    // Should not contain unreplaced placeholders for the used variable.
    expect(prompt).not.toContain('{{topic}}');
  });

  it('builds a risk prompt with topic and optional context', () => {
    const svc = new PromptService({ promptsDir: REAL_PROMPTS_DIR });
    svc.loadAll();

    const prompt = svc.build('risk', {
      topic: 'DeFi protocol launch',
      context: 'Targeting Southeast Asia market',
    });
    expect(prompt).toContain('DeFi protocol launch');
    expect(prompt).not.toContain('{{topic}}');
  });

  it('builds a coding prompt without optional context', () => {
    const svc = new PromptService({ promptsDir: REAL_PROMPTS_DIR });
    svc.loadAll();

    const prompt = svc.build('coding', { task: 'Write a Stellar payment function' });
    expect(prompt).toContain('Stellar payment function');
    expect(prompt).not.toContain('{{task}}');
    // No context block should appear.
    expect(prompt).not.toContain('{{/context}}');
  });

  it('builds a design prompt', () => {
    const svc = new PromptService({ promptsDir: REAL_PROMPTS_DIR });
    svc.loadAll();

    const prompt = svc.build('design', { brief: 'Agent marketplace dashboard' });
    expect(prompt).toContain('Agent marketplace dashboard');
    expect(prompt).not.toContain('{{brief}}');
  });

  it('builds a report prompt with upstream results', () => {
    const svc = new PromptService({ promptsDir: REAL_PROMPTS_DIR });
    svc.loadAll();

    const upstream = JSON.stringify([{ summary: 'Research done' }]);
    const prompt = svc.build('report', {
      subject: 'Solar energy market entry',
      upstreamResults: upstream,
    });
    expect(prompt).toContain('Solar energy market entry');
    expect(prompt).toContain('Research done');
    expect(prompt).not.toContain('{{subject}}');
    expect(prompt).not.toContain('{{upstreamResults}}');
  });
});
