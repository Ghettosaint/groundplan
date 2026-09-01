/**
 * WebMCP runtime.
 *
 * Two things happen here.
 *
 * 1. We find a Model Context implementation — Chrome's native
 *    `document.modelContext`, the deprecated `navigator.modelContext` alias, or
 *    the `@mcp-b/global` polyfill loaded on demand — and normalise the
 *    differences away.
 *
 * 2. We keep the *registered* tool set in sync with the *desired* tool set. The
 *    desired set is a function of application state, so the agent's menu of
 *    capabilities narrows and widens as the user works: read-only in review
 *    mode, a `fix_violation` tool only while something is actually broken, an
 *    `edit_selection` tool only while the user has something selected, and no
 *    mutations at all while an approval is on screen.
 */

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * A tool result block. Text is the workhorse; an image block exists so the page
 * can hand a picture the person dropped on it straight to the model, which is
 * what turns "trace this floor plan" from two steps into one. Hosts that do not
 * surface images simply ignore the block, so the text has to stand alone.
 */
export type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolContent {
  content: ToolContentBlock[];
  isError?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  execute: (args: Record<string, unknown>) => Promise<ToolContent> | ToolContent;
}

export type HostStatus = 'native' | 'polyfill' | 'unavailable';

interface ModelContextLike {
  registerTool?: (tool: unknown, options?: { signal?: AbortSignal }) => unknown;
  provideContext?: (context: { tools: unknown[] }) => unknown;
  unregisterTool?: (name: string) => unknown;
}

function readModelContext(): ModelContextLike | null {
  const fromDocument = (document as unknown as { modelContext?: ModelContextLike }).modelContext;
  if (fromDocument) return fromDocument;
  const fromNavigator = (navigator as unknown as { modelContext?: ModelContextLike }).modelContext;
  return fromNavigator ?? null;
}

/** Anything watching the host — the badge in the header, mostly. */
type StatusListener = (status: HostStatus, toolNames: string[]) => void;

class ToolHost {
  status: HostStatus = 'unavailable';
  /** True when the page had to install the polyfill itself. */
  polyfilled = false;
  lastError: string | null = null;

  private ctx: ModelContextLike | null = null;
  private registered = new Map<string, { hash: string; dispose: () => void }>();
  private listeners = new Set<StatusListener>();
  private ready: Promise<void> | null = null;
  private useProvideContext = false;
  private desired: ToolSpec[] = [];

  onStatus(fn: StatusListener): () => void {
    this.listeners.add(fn);
    fn(this.status, this.toolNames);
    return () => this.listeners.delete(fn);
  }

  get toolNames(): string[] {
    return [...this.registered.keys()].sort();
  }

  private announce(): void {
    for (const fn of this.listeners) fn(this.status, this.toolNames);
  }

  /**
   * Resolves once a Model Context host exists. Native first — a browser that
   * ships the API should always win — and only then the polyfill, so we never
   * shadow a real implementation.
   */
  init(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const native = readModelContext();
      if (native?.registerTool || native?.provideContext) {
        this.ctx = native;
        this.status = 'native';
      } else {
        try {
          await import('@mcp-b/global');
          const polyfilled = readModelContext();
          if (polyfilled?.registerTool || polyfilled?.provideContext) {
            this.ctx = polyfilled;
            this.status = 'polyfill';
            this.polyfilled = true;
          }
        } catch (err) {
          this.lastError = err instanceof Error ? err.message : String(err);
        }
      }
      if (this.ctx) {
        this.useProvideContext =
          typeof this.ctx.registerTool !== 'function' && typeof this.ctx.provideContext === 'function';
      }
      this.announce();
    })();
    return this.ready;
  }

  /**
   * Makes the live registration match `tools`: adds what is new, drops what is
   * gone, re-registers anything whose schema changed.
   *
   * @param keepAlive names that must survive regardless, because a tool call is
   * in flight through them. Aborting a registration cancels its running call,
   * which would strand any tool waiting on a human to approve something.
   */
  async sync(tools: ToolSpec[], keepAlive: string[] = []): Promise<void> {
    this.desired = tools;
    const protectedNames = new Set(keepAlive);
    await this.init();
    if (!this.ctx) return;

    if (this.useProvideContext) {
      try {
        this.ctx.provideContext?.({ tools: tools.map(toDescriptor) });
        this.registered = new Map(tools.map((t) => [t.name, { hash: hashOf(t), dispose: () => {} }]));
        this.announce();
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
      return;
    }

    const wanted = new Map(tools.map((t) => [t.name, t]));

    for (const [name, entry] of [...this.registered]) {
      if (protectedNames.has(name)) continue;
      const next = wanted.get(name);
      if (!next || hashOf(next) !== entry.hash) {
        entry.dispose();
        this.registered.delete(name);
      }
    }

    for (const tool of tools) {
      if (this.registered.has(tool.name)) continue;
      try {
        const controller = new AbortController();
        const handle = this.ctx.registerTool?.(toDescriptor(tool), { signal: controller.signal });
        // Registration may hand back a promise that settles when the signal
        // fires. Aborting the signal *is* how we unregister, so that rejection
        // is expected — but an unhandled one fills the console with red.
        if (handle && typeof (handle as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(handle).catch(() => undefined);
        }
        const dispose = () => {
          controller.abort();
          if (typeof handle === 'function') {
            try {
              (handle as () => void)();
            } catch {
              /* the signal already did the job */
            }
          }
          try {
            this.ctx?.unregisterTool?.(tool.name);
          } catch {
            /* not every host implements it */
          }
        };
        this.registered.set(tool.name, { hash: hashOf(tool), dispose });
      } catch (err) {
        this.lastError = `${tool.name}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    this.announce();
  }

  /** The tool the page thinks is registered, for the in-page inspector. */
  spec(name: string): ToolSpec | undefined {
    return this.desired.find((t) => t.name === name);
  }

  get specs(): ToolSpec[] {
    return this.desired;
  }
}

function toDescriptor(tool: ToolSpec) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    execute: tool.execute,
  };
}

/** Cheap structural fingerprint, so we only re-register when something changed. */
function hashOf(tool: ToolSpec): string {
  return `${tool.description.length}:${JSON.stringify(tool.inputSchema).length}:${JSON.stringify(
    tool.annotations ?? {},
  )}`;
}

export const host = new ToolHost();

// ── Result helpers ───────────────────────────────────────────────────────────

/**
 * Every tool answers with one JSON object. Agents read it reliably, and the
 * `summary` line means a model that only glances at the first sentence still
 * gets the point.
 */
export function reply(payload: Record<string, unknown>): ToolContent {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * A result that carries a picture as well as the words. The text goes first so
 * a host that drops the image still returns something useful.
 */
export function replyWithImage(
  payload: Record<string, unknown>,
  dataUrl: string,
): ToolContent {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return reply(payload);
  return {
    content: [
      { type: 'text', text: JSON.stringify(payload, null, 2) },
      { type: 'image', mimeType: match[1]!, data: match[2]! },
    ],
  };
}

export function replyError(summary: string, extra?: Record<string, unknown>): ToolContent {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, summary, ...extra }, null, 2) }],
    isError: true,
  };
}
