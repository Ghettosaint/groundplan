/**
 * Application state, history and the change bus.
 *
 * Everything — a human dragging a wall, an agent calling a tool — funnels
 * through `commit()`. That is what makes agent edits undoable, attributable and
 * visible in the activity feed, and it is why the page can hand an agent write
 * access without the user losing control of their own document.
 */

import { analyse, type Analysis } from './rules';
import type { Journey } from './route';
import { loadUnderlay, saveUnderlay, type Underlay } from './underlay';
import { DEFAULT_SETTINGS, type Plan, type Selection } from './types';
import { starterPlan } from './samples';

export type Actor = 'human' | 'agent' | 'system';

export type Mode = 'design' | 'review';

export interface ActivityEntry {
  id: string;
  ts: number;
  actor: Actor;
  label: string;
  detail?: string;
  /** Tool name when the change arrived over WebMCP. */
  tool?: string;
  /** Index into the undo stack, so a single step can be rolled back later. */
  revertTo?: number;
}

export interface Overlays {
  heatmap: boolean;
  reach: boolean;
  swings: boolean;
  approach: boolean;
  grid: boolean;
  dimensions: boolean;
}

export interface Proposal {
  id: string;
  title: string;
  summary: string;
  tool: string;
  /** Plan as it would be if approved. */
  next: Plan;
  /** Human-readable list of what changes. */
  changes: string[];
  created: number;
  resolve: (approved: boolean, note?: string) => void;
}

export interface Highlight {
  ids: string[];
  until: number;
  label?: string;
}

/** A route being played back on the drawing. */
export interface JourneyPlayback {
  journey: Journey;
  startedAt: number;
  /** How long the body takes to walk the route, ms. */
  travelMs: number;
  /** How long the result stays on screen once it arrives or stops, ms. */
  holdMs: number;
}

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

type Listener = () => void;

class Store {
  plan: Plan = starterPlan();
  selection: Selection | null = null;
  mode: Mode = 'design';
  overlays: Overlays = {
    heatmap: false,
    reach: true,
    swings: true,
    approach: false,
    grid: true,
    dimensions: true,
  };
  activity: ActivityEntry[] = [];
  proposal: Proposal | null = null;
  highlight: Highlight | null = null;
  playback: JourneyPlayback | null = null;
  /**
   * A picture to trace over. Kept outside the Plan on purpose — plans travel in
   * share links and exports, and a photograph would make both unusable.
   */
  underlay: Underlay | null = loadUnderlay();
  /** When true, every mutating tool call has to be approved in the page first. */
  requireApproval = true;
  /** Set while an agent tool is running, so the canvas can show presence. */
  agentBusy: string | null = null;
  /** Bumped when something asks the drawing to refit; the canvas watches it. */
  fitRequest = 0;
  /**
   * True while the drawing is still whatever it was loaded as — a sample, or
   * the starter flat. Dropping a picture onto a pristine plan can clear it
   * without asking; dropping one onto work in progress must not.
   */
  pristine = true;
  lastAgentSeen = 0;

  private undoStack: Plan[] = [];
  private redoStack: Plan[] = [];
  private listeners = new Set<Listener>();
  private cache: { key: string; value: Analysis } | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Cached rule run. Recomputed whenever the plan actually changes. */
  get analysis(): Analysis {
    const key = JSON.stringify(this.plan);
    if (this.cache && this.cache.key === key) return this.cache.value;
    const value = analyse(this.plan);
    this.cache = { key, value };
    return value;
  }

  clone(): Plan {
    return structuredClone(this.plan);
  }

  /**
   * Applies a mutation as one atomic, undoable step.
   * `mutate` receives a draft it is free to modify; returning false aborts.
   */
  commit(
    label: string,
    actor: Actor,
    mutate: (draft: Plan) => void | false,
    meta?: { tool?: string; detail?: string },
  ): boolean {
    const draft = this.clone();
    if (mutate(draft) === false) return false;
    this.pristine = false;
    this.undoStack.push(this.plan);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.plan = draft;
    this.activity.unshift({
      id: uid('act'),
      ts: Date.now(),
      actor,
      label,
      detail: meta?.detail,
      tool: meta?.tool,
      revertTo: this.undoStack.length - 1,
    });
    if (this.activity.length > 120) this.activity.pop();
    if (actor === 'agent') this.lastAgentSeen = Date.now();
    this.emit();
    return true;
  }

  /** Replaces the whole plan in one step, used when a proposal is approved. */
  commitPlan(label: string, actor: Actor, next: Plan, meta?: { tool?: string; detail?: string }): void {
    this.commit(label, actor, (draft) => {
      draft.rooms = next.rooms;
      draft.openings = next.openings;
      draft.furniture = next.furniture;
      draft.settings = next.settings;
      draft.name = next.name;
    }, meta);
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.plan);
    this.plan = prev;
    this.activity.unshift({ id: uid('act'), ts: Date.now(), actor: 'human', label: 'Undo' });
    this.emit();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.plan);
    this.plan = next;
    this.activity.unshift({ id: uid('act'), ts: Date.now(), actor: 'human', label: 'Redo' });
    this.emit();
    return true;
  }

  /** Rewinds to the snapshot taken before a specific activity entry. */
  revertTo(index: number): boolean {
    const snapshot = this.undoStack[index];
    if (!snapshot) return false;
    this.redoStack.push(this.plan);
    this.undoStack.length = index;
    this.plan = snapshot;
    this.activity.unshift({
      id: uid('act'),
      ts: Date.now(),
      actor: 'human',
      label: 'Reverted an agent edit',
    });
    this.emit();
    return true;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  select(sel: Selection | null): void {
    this.selection = sel;
    this.emit();
  }

  requestFit(): void {
    this.fitRequest += 1;
    this.emit();
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.emit();
  }

  flash(ids: string[], label?: string, ms = 2600): void {
    this.highlight = { ids, until: Date.now() + ms, label };
    this.emit();
    setTimeout(() => {
      if (this.highlight && this.highlight.until <= Date.now()) {
        this.highlight = null;
        this.emit();
      }
    }, ms + 30);
  }

  setUnderlay(next: Underlay | null): void {
    this.underlay = next;
    saveUnderlay(next);
    this.emit();
  }

  /** Starts a route animation, replacing whatever was playing. */
  play(journey: Journey, travelMs = 2400, holdMs = 5500): void {
    this.playback = { journey, startedAt: Date.now(), travelMs, holdMs };
    this.emit();
    const total = travelMs + holdMs;
    setTimeout(() => {
      if (this.playback && Date.now() - this.playback.startedAt >= total - 20) {
        this.playback = null;
        this.emit();
      }
    }, total + 40);
  }

  note(label: string, actor: Actor, detail?: string, tool?: string): void {
    this.activity.unshift({ id: uid('act'), ts: Date.now(), actor, label, detail, tool });
    if (this.activity.length > 120) this.activity.pop();
    if (actor === 'agent') this.lastAgentSeen = Date.now();
    this.emit();
  }

  /**
   * Swaps in a different building: a sample, a blank page, a shared link.
   *
   * The tracing picture goes with it. It is a photograph of one particular
   * home, so leaving it under a different drawing is never what anyone meant —
   * and "Blank page" that leaves a picture on screen is not a blank page.
   */
  reset(plan: Plan): void {
    this.undoStack.push(this.plan);
    this.plan = plan;
    this.selection = null;
    this.pristine = true;
    if (this.underlay) this.setUnderlay(null);
    this.emit();
  }

  newPlan(name: string): void {
    this.reset({
      id: uid('plan'),
      name,
      rooms: [],
      openings: [],
      furniture: [],
      settings: { ...DEFAULT_SETTINGS },
    });
  }
}

export const store = new Store();
