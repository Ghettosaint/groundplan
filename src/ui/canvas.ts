/**
 * The drawing sheet.
 *
 * Renders the plan to a 2D canvas and handles direct manipulation. The sheet
 * deliberately stays light in both colour themes — it is paper, and drawings
 * live on paper.
 *
 * The overlays matter as much as the plan itself: they are how the page shows
 * the *same* measurements the agent's tools return, so a person can see why a
 * tool said what it said.
 */

import { ROOM_TYPES } from '../core/catalog';
import {
  approachRect,
  furnitureRect,
  openingRect,
  planBounds,
  pointInRect,
  roomRect,
  wallRuns,
} from '../core/geometry';
import { positionAt } from '../core/route';
import type { Analysis } from '../core/rules';
import { store } from '../core/store';
import type { Furniture, Opening, Plan, Rect } from '../core/types';

const PAPER = '#fbfaf7';
const GRIDLINE = '#e9e4da';
const GRIDLINE_MAJOR = '#ddd6c8';
const WALL = '#2a2823';
const INK = '#403c33';
const MUTED = '#8b8577';
const SELECT = '#1a63d8';
const AGENT = '#7b45d6';
const ERROR = '#c8372f';
const WARN = '#c07a17';

interface View {
  scale: number;
  tx: number;
  ty: number;
}

export class PlanCanvas {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private view: View = { scale: 0.05, tx: 0, ty: 0 };
  private dpr = 1;
  private raster: { key: unknown; canvas: HTMLCanvasElement } | null = null;
  private drag:
    | { kind: 'pan'; x: number; y: number; tx: number; ty: number }
    | { kind: 'furniture'; id: string; ox: number; oy: number; moved: boolean }
    | { kind: 'room'; id: string; ox: number; oy: number; moved: boolean }
    | { kind: 'opening'; id: string; start: number; grab: number; moved: boolean }
    | { kind: 'underlay'; ox: number; oy: number; moved: boolean }
    | null = null;
  private hover: string | null = null;
  /** Decoded tracing image, cached by its data URL. */
  private underlayImage: { src: string; el: HTMLImageElement; ready: boolean } | null = null;
  /** Cleared by fit(); set the moment the user pans or zooms by hand. */
  private userAdjusted = false;

  constructor(host: HTMLElement) {
    this.el = document.createElement('canvas');
    this.el.className = 'sheet';
    // A drawing surface is unusable by keyboard unless we say so and mean it.
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'application');
    this.el.setAttribute(
      'aria-label',
      'Floor plan drawing. Press the full stop and comma keys to move between rooms, doors and furniture; arrow keys to move the selection; Escape to deselect; plus and minus to zoom; zero to fit.',
    );
    host.appendChild(this.el);
    const ctx = this.el.getContext('2d');
    if (!ctx) throw new Error('This browser cannot give us a 2D canvas.');
    this.ctx = ctx;

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.bind();
    store.subscribe(() => this.draw());
  }

  // ── View maths ─────────────────────────────────────────────────────────────

  private toWorld(px: number, py: number): [number, number] {
    return [(px - this.view.tx) / this.view.scale, (py - this.view.ty) / this.view.scale];
  }

  fit(): void {
    const b = planBounds(store.plan);
    const pad = 900;
    const w = this.el.clientWidth || 800;
    const h = this.el.clientHeight || 600;
    const scale = Math.min(w / (b.w + pad * 2), h / (b.h + pad * 2));
    this.view.scale = scale;
    this.view.tx = w / 2 - (b.x + b.w / 2) * scale;
    this.view.ty = h / 2 - (b.y + b.h / 2) * scale;
    this.userAdjusted = false;
    this.draw();
  }

  zoomBy(factor: number, cx?: number, cy?: number): void {
    this.userAdjusted = true;
    const px = cx ?? this.el.clientWidth / 2;
    const py = cy ?? this.el.clientHeight / 2;
    const [wx, wy] = this.toWorld(px, py);
    this.view.scale = Math.max(0.008, Math.min(0.6, this.view.scale * factor));
    this.view.tx = px - wx * this.view.scale;
    this.view.ty = py - wy * this.view.scale;
    this.draw();
  }

  /** The current view as a PNG data URL, for the export menu. */
  toPng(): string {
    return this.el.toDataURL('image/png');
  }

  private resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    this.el.width = Math.max(1, Math.round(w * this.dpr));
    this.el.height = Math.max(1, Math.round(h * this.dpr));
    // Stay fitted to the sheet until the user takes the view into their own
    // hands. Layout settles over several frames, so one early fit is not enough.
    if (!this.userAdjusted && w > 80 && h > 80) {
      this.fit();
      return;
    }
    this.draw();
  }

  // ── Interaction ────────────────────────────────────────────────────────────

  private bind(): void {
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('pointermove', (e) => this.onMove(e));
    this.el.addEventListener('pointerup', (e) => this.onUp(e));
    this.el.addEventListener('pointercancel', () => {
      this.drag = null;
    });
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.el.getBoundingClientRect();
      this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });
    this.el.addEventListener('dblclick', () => this.fit());
    this.el.addEventListener('keydown', (e) => this.onKey(e));
  }

  /**
   * Keyboard equivalents for everything the mouse can do. A tool about
   * accessible design that cannot itself be driven from the keyboard would be
   * a poor advertisement for the idea.
   */
  private onKey(e: KeyboardEvent): void {
    const step = e.shiftKey ? 10 : e.altKey ? 500 : 50;

    if (e.key === '.' || e.key === ',') {
      e.preventDefault();
      this.cycleSelection(e.key === '.' ? 1 : -1);
      return;
    }
    if (e.key === 'Escape') {
      store.select(null);
      return;
    }
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      this.zoomBy(1.25);
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      this.zoomBy(1 / 1.25);
      return;
    }
    if (e.key === '0') {
      e.preventDefault();
      this.fit();
      return;
    }

    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = deltas[e.key];
    if (!delta) return;
    e.preventDefault();
    const sel = store.selection;
    if (!sel) {
      // Nothing selected: pan the sheet instead.
      this.userAdjusted = true;
      this.view.tx -= delta[0] * this.view.scale;
      this.view.ty -= delta[1] * this.view.scale;
      this.draw();
      return;
    }
    store.commit(
      'Nudged the selection',
      'human',
      (draft) => {
        if (sel.kind === 'furniture') {
          const f = draft.furniture.find((x) => x.id === sel.id);
          if (!f) return false;
          f.cx += delta[0];
          f.cy += delta[1];
          return undefined;
        }
        if (sel.kind === 'room') {
          const room = draft.rooms.find((x) => x.id === sel.id);
          if (!room) return false;
          room.x += delta[0];
          room.y += delta[1];
          for (const f of draft.furniture) {
            if (pointInRect(f.cx - delta[0], f.cy - delta[1], roomRect(room))) {
              f.cx += delta[0];
              f.cy += delta[1];
            }
          }
          return undefined;
        }
        const op = draft.openings.find((x) => x.id === sel.id);
        const host = op && draft.rooms.find((r) => r.id === op.roomId);
        if (!op || !host) return false;
        const along = op.side === 'n' || op.side === 's' ? delta[0] : delta[1];
        if (along === 0) return false;
        const len = op.side === 'n' || op.side === 's' ? host.w : host.h;
        op.offset = Math.max(50, Math.min(len - op.width - 50, op.offset + along));
        return undefined;
      },
    );
  }

  /** Walks the selection through every room, opening and item in turn. */
  private cycleSelection(direction: 1 | -1): void {
    const plan = store.plan;
    const order: { kind: 'room' | 'opening' | 'furniture'; id: string }[] = [
      ...plan.rooms.map((r) => ({ kind: 'room' as const, id: r.id })),
      ...plan.openings.map((o) => ({ kind: 'opening' as const, id: o.id })),
      ...plan.furniture.map((f) => ({ kind: 'furniture' as const, id: f.id })),
    ];
    if (order.length === 0) return;
    const current = store.selection ? order.findIndex((x) => x.id === store.selection!.id) : -1;
    const next = (current + direction + order.length) % order.length;
    store.select(order[next]!);
  }

  private pointer(e: PointerEvent): [number, number] {
    const rect = this.el.getBoundingClientRect();
    return this.toWorld(e.clientX - rect.left, e.clientY - rect.top);
  }

  private onDown(e: PointerEvent): void {
    this.el.setPointerCapture(e.pointerId);
    const [wx, wy] = this.pointer(e);
    const rect = this.el.getBoundingClientRect();

    if (e.button === 1 || e.shiftKey) {
      this.drag = { kind: 'pan', x: e.clientX - rect.left, y: e.clientY - rect.top, tx: this.view.tx, ty: this.view.ty };
      return;
    }

    // An unlocked tracing image takes the drag: unlocked means "I am placing
    // this", and locking it hands the mouse back to the drawing.
    const under = store.underlay;
    if (under && !under.locked && pointInRect(wx, wy, { x: under.x, y: under.y, w: under.width, h: under.height })) {
      this.drag = { kind: 'underlay', ox: wx - under.x, oy: wy - under.y, moved: false };
      return;
    }

    const hit = this.hitTest(wx, wy);
    if (!hit) {
      store.select(null);
      this.drag = { kind: 'pan', x: e.clientX - rect.left, y: e.clientY - rect.top, tx: this.view.tx, ty: this.view.ty };
      return;
    }

    store.select({ kind: hit.kind, id: hit.id });
    if (hit.kind === 'furniture') {
      const f = store.plan.furniture.find((x) => x.id === hit.id)!;
      this.drag = { kind: 'furniture', id: hit.id, ox: wx - f.cx, oy: wy - f.cy, moved: false };
    } else if (hit.kind === 'opening') {
      const op = store.plan.openings.find((x) => x.id === hit.id)!;
      const along = op.side === 'n' || op.side === 's' ? wx : wy;
      this.drag = { kind: 'opening', id: hit.id, start: op.offset, grab: along, moved: false };
    } else {
      const r = store.plan.rooms.find((x) => x.id === hit.id)!;
      this.drag = { kind: 'room', id: hit.id, ox: wx - r.x, oy: wy - r.y, moved: false };
    }
  }

  private onMove(e: PointerEvent): void {
    const [wx, wy] = this.pointer(e);
    const rect = this.el.getBoundingClientRect();

    if (!this.drag) {
      const hit = this.hitTest(wx, wy);
      const id = hit?.id ?? null;
      if (id !== this.hover) {
        this.hover = id;
        this.el.style.cursor = hit ? 'grab' : 'default';
        this.draw();
      }
      return;
    }

    if (this.drag.kind === 'pan') {
      this.userAdjusted = true;
      this.view.tx = this.drag.tx + (e.clientX - rect.left - this.drag.x);
      this.view.ty = this.drag.ty + (e.clientY - rect.top - this.drag.y);
      this.draw();
      return;
    }

    // Live drags mutate the working plan directly and only land in history on
    // pointer-up, so a drag is one undo step rather than a hundred.
    const drag = this.drag;
    if (drag.kind === 'underlay') {
      const under = store.underlay;
      if (!under) return;
      under.x = Math.round((wx - drag.ox) / 10) * 10;
      under.y = Math.round((wy - drag.oy) / 10) * 10;
      drag.moved = true;
      store.emit();
      return;
    }
    if (drag.kind === 'furniture') {
      const item = store.plan.furniture.find((x) => x.id === drag.id);
      if (!item) return;
      item.cx = Math.round((wx - drag.ox) / 10) * 10;
      item.cy = Math.round((wy - drag.oy) / 10) * 10;
      drag.moved = true;
    } else if (drag.kind === 'room') {
      const room = store.plan.rooms.find((x) => x.id === drag.id);
      if (!room) return;
      const nx = Math.round((wx - drag.ox) / 50) * 50;
      const ny = Math.round((wy - drag.oy) / 50) * 50;
      const dx = nx - room.x;
      const dy = ny - room.y;
      for (const f of store.plan.furniture) {
        if (pointInRect(f.cx, f.cy, roomRect(room))) {
          f.cx += dx;
          f.cy += dy;
        }
      }
      room.x = nx;
      room.y = ny;
      drag.moved = true;
    } else if (drag.kind === 'opening') {
      const op = store.plan.openings.find((x) => x.id === drag.id);
      const room = op && store.plan.rooms.find((r) => r.id === op.roomId);
      if (!op || !room) return;
      const along = op.side === 'n' || op.side === 's' ? wx : wy;
      const len = op.side === 'n' || op.side === 's' ? room.w : room.h;
      const next = drag.start + (along - drag.grab);
      op.offset = Math.max(50, Math.min(len - op.width - 50, Math.round(next / 10) * 10));
      drag.moved = true;
    }
    store.emit();
  }

  private onUp(e: PointerEvent): void {
    this.el.releasePointerCapture(e.pointerId);
    const drag = this.drag;
    this.drag = null;
    if (drag?.kind === 'underlay') {
      if (drag.moved) store.setUnderlay(store.underlay);
      return;
    }
    if (!drag || drag.kind === 'pan' || !drag.moved) return;

    // Re-apply the same end state through commit() so it becomes one undoable,
    // attributed step in the shared history the agent can also read.
    const landed = structuredClone(store.plan);
    store.undo();
    const label =
      drag.kind === 'furniture'
        ? `Moved ${store.plan.furniture.find((f) => f.id === drag.id)?.label ?? 'furniture'}`
        : drag.kind === 'room'
          ? `Moved ${store.plan.rooms.find((r) => r.id === drag.id)?.name ?? 'a room'}`
          : 'Moved an opening';
    store.commitPlan(label, 'human', landed);
  }

  private hitTest(wx: number, wy: number): { kind: 'room' | 'furniture' | 'opening'; id: string } | null {
    const plan = store.plan;
    for (let i = plan.furniture.length - 1; i >= 0; i--) {
      const f = plan.furniture[i]!;
      if (pointInRect(wx, wy, furnitureRect(f))) return { kind: 'furniture', id: f.id };
    }
    for (const op of plan.openings) {
      const r = openingRect(plan, op);
      if (r && pointInRect(wx, wy, grow(r, 120))) return { kind: 'opening', id: op.id };
    }
    for (let i = plan.rooms.length - 1; i >= 0; i--) {
      const r = plan.rooms[i]!;
      if (pointInRect(wx, wy, roomRect(r))) return { kind: 'room', id: r.id };
    }
    return null;
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  draw(): void {
    const ctx = this.ctx;
    const plan = store.plan;
    const analysis = store.analysis;
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(this.view.tx, this.view.ty);
    ctx.scale(this.view.scale, this.view.scale);

    if (store.overlays.grid) this.drawGrid(w, h);
    this.drawRoomFills(plan);
    this.drawUnderlay();
    if (store.overlays.heatmap || store.overlays.reach) this.drawRaster(analysis);
    if (store.overlays.approach) this.drawApproach(plan);
    this.drawWalls(plan);
    if (store.overlays.swings) this.drawSwings(plan);
    this.drawFurniture(plan);
    this.drawOpeningDetail(plan);
    this.drawLabels(plan, analysis);
    if (store.overlays.dimensions) this.drawDimensions(plan);
    this.drawIssueMarkers(analysis);
    this.drawJourney();
    this.drawProposal(plan);
    this.drawSelection(plan);
    this.drawHighlight(plan);

    ctx.restore();
    ctx.restore();
  }

  private drawGrid(w: number, h: number): void {
    const ctx = this.ctx;
    const [x0, y0] = this.toWorld(0, 0);
    const [x1, y1] = this.toWorld(w, h);
    const step = this.view.scale > 0.045 ? 500 : 1000;
    ctx.lineWidth = 1 / this.view.scale;
    for (let x = Math.floor(x0 / step) * step; x < x1; x += step) {
      ctx.strokeStyle = x % 5000 === 0 ? GRIDLINE_MAJOR : GRIDLINE;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.stroke();
    }
    for (let y = Math.floor(y0 / step) * step; y < y1; y += step) {
      ctx.strokeStyle = y % 5000 === 0 ? GRIDLINE_MAJOR : GRIDLINE;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
    }
  }

  /**
   * The tracing image, over the room colours so it stays legible, and under the
   * walls and labels so the drawing always wins.
   */
  private drawUnderlay(): void {
    const under = store.underlay;
    if (!under) return;
    if (this.underlayImage?.src !== under.src) {
      const el = new Image();
      const entry = { src: under.src, el, ready: false };
      el.onload = () => {
        entry.ready = true;
        this.draw();
      };
      el.src = under.src;
      this.underlayImage = entry;
    }
    const cached = this.underlayImage;
    if (!cached?.ready) return;

    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = under.opacity;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(cached.el, under.x, under.y, under.width, under.height);
    ctx.restore();

    if (!under.locked) {
      // Unlocked means "I am positioning this", so say so on the drawing.
      ctx.save();
      ctx.strokeStyle = '#1a63d8';
      ctx.setLineDash([200, 140]);
      ctx.lineWidth = 40;
      ctx.strokeRect(under.x, under.y, under.width, under.height);
      ctx.restore();
    }
  }

  private drawRoomFills(plan: Plan): void {
    const ctx = this.ctx;
    for (const room of plan.rooms) {
      ctx.fillStyle = ROOM_TYPES[room.type].fill;
      ctx.fillRect(room.x, room.y, room.w, room.h);
    }
  }

  /**
   * Paints the clearance field. This is the single most useful thing on screen:
   * the same numbers `analyse_access` returns, as colour.
   */
  private drawRaster(analysis: Analysis): void {
    const key = `${analysis.stats.score}|${store.overlays.heatmap}|${store.overlays.reach}|${analysis.grid.cols}x${analysis.grid.rows}|${analysis.stats.reachableAreaM2}`;
    if (!this.raster || this.raster.key !== key) {
      const g = analysis.grid;
      const off = document.createElement('canvas');
      off.width = g.cols;
      off.height = g.rows;
      const octx = off.getContext('2d')!;
      const img = octx.createImageData(g.cols, g.rows);
      const radius = store.plan.settings.mobilityRadius;
      const turnRadius = store.plan.settings.turningCircle / 2;
      for (let i = 0; i < g.cols * g.rows; i++) {
        const p = i * 4;
        if (g.floor[i] !== 1 || g.blocked[i] === 1) continue;
        const clear = g.clearance[i]!;
        const reached = analysis.reach.mask[i] === 1;
        if (store.overlays.heatmap) {
          const [r, gg, b] = ramp(heatScale(clear, radius, turnRadius));
          img.data[p] = r;
          img.data[p + 1] = gg;
          img.data[p + 2] = b;
          img.data[p + 3] = 128;
        } else if (store.overlays.reach) {
          if (reached) {
            img.data[p] = 56;
            img.data[p + 1] = 142;
            img.data[p + 2] = 102;
            img.data[p + 3] = 34;
          } else {
            img.data[p] = 190;
            img.data[p + 1] = 60;
            img.data[p + 2] = 48;
            img.data[p + 3] = 46;
          }
        }
      }
      octx.putImageData(img, 0, 0);
      this.raster = { key, canvas: off };
    }
    const g = analysis.grid;
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.raster.canvas, g.ox, g.oy, g.cols * g.cell, g.rows * g.cell);
  }

  private drawApproach(plan: Plan): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(26, 99, 216, 0.10)';
    ctx.strokeStyle = 'rgba(26, 99, 216, 0.45)';
    ctx.setLineDash([120, 90]);
    ctx.lineWidth = 20;
    for (const f of plan.furniture) {
      const a = approachRect(f);
      if (!a) continue;
      ctx.fillRect(a.x, a.y, a.w, a.h);
      ctx.strokeRect(a.x, a.y, a.w, a.h);
    }
    ctx.restore();
  }

  private drawWalls(plan: Plan): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = WALL;
    for (const run of wallRuns(plan)) ctx.fillRect(run.x, run.y, run.w, run.h);
    ctx.restore();
  }

  private drawSwings(plan: Plan): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(64, 60, 51, 0.4)';
    ctx.lineWidth = 18;
    for (const op of plan.openings) {
      const arc = swingArc(plan, op);
      if (!arc) continue;
      ctx.beginPath();
      ctx.arc(arc.hinge.x, arc.hinge.y, arc.radius, arc.from, arc.to, arc.anticlockwise);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(arc.hinge.x, arc.hinge.y);
      ctx.lineTo(arc.hinge.x + Math.cos(arc.to) * arc.radius, arc.hinge.y + Math.sin(arc.to) * arc.radius);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawFurniture(plan: Plan): void {
    const ctx = this.ctx;
    ctx.save();
    for (const f of plan.furniture) {
      const r = furnitureRect(f);
      ctx.fillStyle = f.category === 'fixture' || f.category === 'appliance' ? '#dfe7ea' : '#f2ece1';
      ctx.strokeStyle = '#6f6a5d';
      ctx.lineWidth = 16;
      roundRect(ctx, r, 60);
      ctx.fill();
      ctx.stroke();

      // A tick on the face the item is used from.
      ctx.strokeStyle = '#9a9384';
      ctx.lineWidth = 26;
      const dir = facingOf(f);
      ctx.beginPath();
      if (dir === 's') {
        ctx.moveTo(r.x + 80, r.y + r.h - 60);
        ctx.lineTo(r.x + r.w - 80, r.y + r.h - 60);
      } else if (dir === 'n') {
        ctx.moveTo(r.x + 80, r.y + 60);
        ctx.lineTo(r.x + r.w - 80, r.y + 60);
      } else if (dir === 'e') {
        ctx.moveTo(r.x + r.w - 60, r.y + 80);
        ctx.lineTo(r.x + r.w - 60, r.y + r.h - 80);
      } else {
        ctx.moveTo(r.x + 60, r.y + 80);
        ctx.lineTo(r.x + 60, r.y + r.h - 80);
      }
      ctx.stroke();

      if (this.view.scale > 0.028) {
        ctx.fillStyle = MUTED;
        ctx.font = `${Math.round(150)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(shorten(f.label), r.x + r.w / 2, r.y + r.h / 2);
      }
    }
    ctx.restore();
  }

  private drawOpeningDetail(plan: Plan): void {
    const ctx = this.ctx;
    ctx.save();
    for (const op of plan.openings) {
      const r = openingRect(plan, op);
      if (!r) continue;
      if (op.kind === 'window') {
        ctx.fillStyle = '#cfd9de';
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = '#5d7480';
        ctx.lineWidth = 22;
        ctx.beginPath();
        if (op.side === 'n' || op.side === 's') {
          ctx.moveTo(r.x, r.y + r.h / 2);
          ctx.lineTo(r.x + r.w, r.y + r.h / 2);
        } else {
          ctx.moveTo(r.x + r.w / 2, r.y);
          ctx.lineTo(r.x + r.w / 2, r.y + r.h);
        }
        ctx.stroke();
      } else {
        // Threshold ticks, so a door reads as a door even with swings hidden.
        ctx.strokeStyle = '#b3ab99';
        ctx.lineWidth = 18;
        ctx.beginPath();
        if (op.side === 'n' || op.side === 's') {
          ctx.moveTo(r.x, r.y);
          ctx.lineTo(r.x, r.y + r.h);
          ctx.moveTo(r.x + r.w, r.y);
          ctx.lineTo(r.x + r.w, r.y + r.h);
        } else {
          ctx.moveTo(r.x, r.y);
          ctx.lineTo(r.x + r.w, r.y);
          ctx.moveTo(r.x, r.y + r.h);
          ctx.lineTo(r.x + r.w, r.y + r.h);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawLabels(plan: Plan, analysis: Analysis): void {
    if (this.view.scale < 0.018) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    for (const room of plan.rooms) {
      const stat = analysis.rooms.find((r) => r.id === room.id);
      // Sit the label in the emptiest part of the room rather than dead centre,
      // so it never lands on top of a bed.
      const title = room.name.toUpperCase();
      ctx.font = `600 ${220}px ui-sans-serif, system-ui, sans-serif`;
      const half = ctx.measureText(title).width / 2 + 120;
      // Keep the whole label inside its own room even when the open spot is
      // right up against a wall.
      const cx = clampTo(stat ? stat.openX : room.x + room.w / 2, room.x + half, room.x + room.w - half);
      const cy = clampTo(stat ? stat.openY : room.y + room.h / 2, room.y + 320, room.y + room.h - 300);
      ctx.fillStyle = INK;
      ctx.textBaseline = 'bottom';
      ctx.fillText(title, cx, cy - 40);
      ctx.fillStyle = MUTED;
      ctx.font = `${190}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(`${stat?.areaM2.toFixed(1) ?? '—'} m²`, cx, cy + 40);
    }
    ctx.restore();
  }

  private drawDimensions(plan: Plan): void {
    if (this.view.scale < 0.02) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(139, 133, 119, 0.6)';
    ctx.fillStyle = MUTED;
    ctx.lineWidth = 12;
    ctx.font = `${160}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const room of plan.rooms) {
      const inset = 190;
      ctx.beginPath();
      ctx.moveTo(room.x + inset, room.y + inset);
      ctx.lineTo(room.x + room.w - inset, room.y + inset);
      ctx.stroke();
      ctx.fillText(`${room.w}`, room.x + room.w / 2, room.y + inset + 130);
      ctx.save();
      ctx.translate(room.x + inset + 130, room.y + room.h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`${room.h}`, 0, 0);
      ctx.restore();
      ctx.beginPath();
      ctx.moveTo(room.x + inset, room.y + inset);
      ctx.lineTo(room.x + inset, room.y + room.h - inset);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawIssueMarkers(analysis: Analysis): void {
    const ctx = this.ctx;
    ctx.save();
    for (const v of analysis.violations) {
      if (!v.at || v.severity === 'info') continue;
      const colour = v.severity === 'error' ? ERROR : WARN;
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(v.at.x, v.at.y, 170, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${210}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(v.severity === 'error' ? '!' : '?', v.at.x, v.at.y + 12);
    }
    ctx.restore();
  }

  /**
   * Draws the change an agent is asking for, on the drawing itself, before it
   * exists. Violet is what the agent proposes; red is what it wants to remove.
   * Reading a list of edits is not the same as seeing where they land.
   */
  private drawProposal(plan: Plan): void {
    const proposal = store.proposal;
    if (!proposal) return;
    const next = proposal.next;
    const ctx = this.ctx;

    ctx.save();
    ctx.lineWidth = 44;
    ctx.setLineDash([220, 150]);
    ctx.lineJoin = 'round';

    const ghost = (rect: Rect, removed: boolean) => {
      ctx.strokeStyle = removed ? ERROR : AGENT;
      ctx.fillStyle = removed ? 'rgba(200, 55, 47, 0.12)' : 'rgba(154, 108, 240, 0.14)';
      roundRect(ctx, grow(rect, 60), 90);
      ctx.fill();
      ctx.stroke();
    };

    const arrow = (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.hypot(dx, dy);
      if (len < 200) return;
      ctx.save();
      ctx.setLineDash([]);
      ctx.strokeStyle = AGENT;
      ctx.lineWidth = 36;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      const a = Math.atan2(dy, dx);
      const head = 220;
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - Math.cos(a - 0.4) * head, to.y - Math.sin(a - 0.4) * head);
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - Math.cos(a + 0.4) * head, to.y - Math.sin(a + 0.4) * head);
      ctx.stroke();
      ctx.restore();
    };

    const roomsBefore = new Map(plan.rooms.map((r) => [r.id, r]));
    for (const r of next.rooms) {
      const prev = roomsBefore.get(r.id);
      if (!prev) ghost(roomRect(r), false);
      else if (prev.x !== r.x || prev.y !== r.y || prev.w !== r.w || prev.h !== r.h) {
        ghost(roomRect(r), false);
        arrow(rectCentreOf(roomRect(prev)), rectCentreOf(roomRect(r)));
      }
    }
    const roomsAfter = new Set(next.rooms.map((r) => r.id));
    for (const r of plan.rooms) if (!roomsAfter.has(r.id)) ghost(roomRect(r), true);

    const opsBefore = new Map(plan.openings.map((o) => [o.id, o]));
    for (const o of next.openings) {
      const prev = opsBefore.get(o.id);
      const changed =
        !prev || prev.width !== o.width || prev.offset !== o.offset || prev.side !== o.side;
      if (!changed) continue;
      const rect = openingRect(next, o);
      if (rect) ghost(rect, false);
    }
    const opsAfter = new Set(next.openings.map((o) => o.id));
    for (const o of plan.openings) {
      if (opsAfter.has(o.id)) continue;
      const rect = openingRect(plan, o);
      if (rect) ghost(rect, true);
    }

    const furBefore = new Map(plan.furniture.map((f) => [f.id, f]));
    for (const f of next.furniture) {
      const prev = furBefore.get(f.id);
      if (!prev) ghost(furnitureRect(f), false);
      else if (prev.cx !== f.cx || prev.cy !== f.cy || prev.rot !== f.rot) {
        ghost(furnitureRect(f), false);
        arrow({ x: prev.cx, y: prev.cy }, { x: f.cx, y: f.cy });
      }
    }
    const furAfter = new Set(next.furniture.map((f) => f.id));
    for (const f of plan.furniture) if (!furAfter.has(f.id)) ghost(furnitureRect(f), true);

    ctx.restore();
  }

  /**
   * Plays a route back at full scale: a body of the tested width sets off from
   * the front door, sweeps the corridor behind it, and stops dead at the point
   * where it stops fitting. The disc is drawn at its real diameter, so a 900 mm
   * body against an 800 mm doorway is not an argument — it is a picture.
   */
  private drawJourney(): void {
    const playback = store.playback;
    if (!playback) return;
    const { journey, startedAt, travelMs, holdMs } = playback;
    if (journey.points.length < 2) return;

    const ctx = this.ctx;
    const elapsed = Date.now() - startedAt;
    if (elapsed > travelMs + holdMs) return;

    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const progress = still ? 1 : Math.min(1, elapsed / travelMs);
    const eased = 1 - (1 - progress) ** 2;
    const limit = journey.travelled[journey.stopIndex] ?? 0;
    const here = positionAt(journey, eased * limit);
    const blocked = !journey.arrives;

    ctx.save();

    // The corridor the body sweeps, drawn at its true width.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(154, 108, 240, 0.16)';
    ctx.lineWidth = journey.radius * 2;
    ctx.beginPath();
    ctx.moveTo(journey.points[0]!.x, journey.points[0]!.y);
    for (let i = 1; i <= here.index; i++) ctx.lineTo(journey.points[i]!.x, journey.points[i]!.y);
    ctx.lineTo(here.x, here.y);
    ctx.stroke();

    // Centre line: solid where it has been, dashed ahead of it.
    ctx.strokeStyle = 'rgba(122, 78, 210, 0.85)';
    ctx.lineWidth = 40;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(journey.points[0]!.x, journey.points[0]!.y);
    for (let i = 1; i <= here.index; i++) ctx.lineTo(journey.points[i]!.x, journey.points[i]!.y);
    ctx.lineTo(here.x, here.y);
    ctx.stroke();

    ctx.strokeStyle = blocked ? 'rgba(200, 55, 47, 0.55)' : 'rgba(122, 78, 210, 0.3)';
    ctx.setLineDash([160, 130]);
    ctx.lineWidth = 34;
    ctx.beginPath();
    ctx.moveTo(here.x, here.y);
    for (let i = here.index + 1; i < journey.points.length; i++) {
      ctx.lineTo(journey.points[i]!.x, journey.points[i]!.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // The body itself: violet on the way, red where it stops, green when it
    // gets there. The state of the trip should be readable at a glance.
    const arrived = progress >= 1;
    const pulse = still ? 0 : (Math.sin(Date.now() / 180) + 1) / 2;
    const stalled = arrived && blocked;
    const madeIt = arrived && !blocked;
    ctx.fillStyle = stalled
      ? `rgba(200, 55, 47, ${0.18 + pulse * 0.18})`
      : madeIt
        ? 'rgba(46, 138, 106, 0.22)'
        : 'rgba(154, 108, 240, 0.22)';
    ctx.strokeStyle = stalled ? '#c8372f' : madeIt ? '#2e8a6a' : '#7a4ed2';
    ctx.lineWidth = stalled ? 60 + pulse * 30 : 55;
    ctx.beginPath();
    ctx.arc(here.x, here.y, journey.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Cross-hairs, so the disc reads as a measurement rather than a blob.
    ctx.lineWidth = 26;
    ctx.strokeStyle = stalled
      ? 'rgba(200,55,47,0.7)'
      : madeIt
        ? 'rgba(46,138,106,0.7)'
        : 'rgba(122,78,210,0.6)';
    ctx.beginPath();
    ctx.moveTo(here.x - journey.radius, here.y);
    ctx.lineTo(here.x + journey.radius, here.y);
    ctx.moveTo(here.x, here.y - journey.radius);
    ctx.lineTo(here.x, here.y + journey.radius);
    ctx.stroke();

    if (stalled && journey.pinch) {
      this.callout(journey.pinch, `${journey.widthMm} mm — needs ${journey.radius * 2} mm`, '#c8372f');
    } else if (madeIt) {
      this.callout(
        { x: here.x, y: here.y },
        `${journey.radius * 2} mm gets through — ${journey.widthMm} mm at the tightest point`,
        '#2e8a6a',
      );
    }

    ctx.restore();
    if (!still) requestAnimationFrame(() => this.draw());
  }

  /** A measurement label pinned to a point on the drawing. */
  private callout(at: { x: number; y: number }, text: string, colour: string): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `700 ${230}px ui-sans-serif, system-ui, sans-serif`;
    const width = ctx.measureText(text).width + 320;
    const bx = at.x - width / 2;
    const by = at.y - 1500;

    ctx.fillStyle = colour;
    roundRect(ctx, { x: bx, y: by, w: width, h: 460 }, 120);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(at.x - 130, by + 455);
    ctx.lineTo(at.x + 130, by + 455);
    ctx.lineTo(at.x, by + 720);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, at.x, by + 245);
    ctx.restore();
  }

  private drawSelection(plan: Plan): void {
    const sel = store.selection;
    if (!sel) return;
    const rect = this.rectOf(plan, sel.kind, sel.id);
    if (!rect) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = SELECT;
    ctx.lineWidth = 34;
    ctx.setLineDash([180, 120]);
    ctx.strokeRect(rect.x - 40, rect.y - 40, rect.w + 80, rect.h + 80);
    ctx.restore();
  }

  private drawHighlight(plan: Plan): void {
    const hl = store.highlight;
    if (!hl || hl.until < Date.now()) return;
    const ctx = this.ctx;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const phase = still ? 0.6 : (Math.sin(Date.now() / 220) + 1) / 2;
    ctx.save();
    ctx.strokeStyle = AGENT;
    ctx.globalAlpha = 0.45 + phase * 0.5;
    ctx.lineWidth = 60;
    for (const id of hl.ids) {
      const rect =
        this.rectOf(plan, 'room', id) ?? this.rectOf(plan, 'furniture', id) ?? this.rectOf(plan, 'opening', id);
      if (!rect) continue;
      roundRect(ctx, grow(rect, 120), 120);
      ctx.stroke();
    }
    ctx.restore();
    if (!still) requestAnimationFrame(() => this.draw());
  }

  private rectOf(plan: Plan, kind: string, id: string): Rect | null {
    if (kind === 'room') {
      const r = plan.rooms.find((x) => x.id === id);
      return r ? roomRect(r) : null;
    }
    if (kind === 'furniture') {
      const f = plan.furniture.find((x) => x.id === id);
      return f ? furnitureRect(f) : null;
    }
    const op = plan.openings.find((x) => x.id === id);
    return op ? openingRect(plan, op) : null;
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────

/** Keeps a value inside a range, tolerating an inverted range gracefully. */
function clampTo(v: number, lo: number, hi: number): number {
  if (hi < lo) return (lo + hi) / 2;
  return Math.max(lo, Math.min(hi, v));
}

function rectCentreOf(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function grow(r: Rect, amount: number): Rect {
  return { x: r.x - amount, y: r.y - amount, w: r.w + amount * 2, h: r.h + amount * 2 };
}

function roundRect(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  const rad = Math.min(radius, r.w / 2, r.h / 2);
  ctx.beginPath();
  ctx.moveTo(r.x + rad, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, rad);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, rad);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, rad);
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, rad);
  ctx.closePath();
}

/** Which way a piece of furniture faces, as a compass letter. */
function facingOf(f: Furniture): 'n' | 'e' | 's' | 'w' {
  return (['s', 'w', 'n', 'e'] as const)[(f.rot / 90) % 4]!;
}

function shorten(label: string): string {
  return label.length > 16 ? `${label.slice(0, 15)}…` : label;
}

/**
 * The quarter arc a door leaf sweeps: hinged on one jamb, closed along the
 * wall, open perpendicular to it in the swing direction.
 */
function swingArc(
  plan: Plan,
  op: Opening,
): { hinge: { x: number; y: number }; radius: number; from: number; to: number; anticlockwise: boolean } | null {
  if (op.kind !== 'door' || op.swing === 'none') return null;
  const hole = openingRect(plan, op);
  if (!hole) return null;
  const horizontal = op.side === 'n' || op.side === 's';
  const hinge = horizontal
    ? { x: hole.x, y: hole.y + hole.h / 2 }
    : { x: hole.x + hole.w / 2, y: hole.y };
  const closed = horizontal ? 0 : Math.PI / 2;
  const open =
    op.swing === 'n' ? -Math.PI / 2 : op.swing === 's' ? Math.PI / 2 : op.swing === 'e' ? 0 : Math.PI;
  return { hinge, radius: op.width, from: closed, to: open, anticlockwise: open < closed };
}

/**
 * Maps a clear radius onto the ramp against the two thresholds that mean
 * something: the body radius (below it, nobody fits) and the turning radius
 * (above it, there is room to turn round).
 */
function heatScale(clear: number, bodyRadius: number, turnRadius: number): number {
  if (clear <= bodyRadius) return 0.35 * (clear / bodyRadius);
  if (clear <= turnRadius) return 0.35 + (0.35 * (clear - bodyRadius)) / (turnRadius - bodyRadius);
  return Math.min(1, 0.7 + (0.3 * (clear - turnRadius)) / turnRadius);
}

/** Red → amber → green ramp for the clearance heatmap. */
function ramp(t: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0, [198, 60, 48]],
    [0.35, [214, 148, 38]],
    [0.7, [122, 168, 74]],
    [1, [46, 138, 106]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i]!;
    const [t1, c1] = stops[i + 1]!;
    if (t <= t1) {
      const k = (t - t0) / (t1 - t0 || 1);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * k),
        Math.round(c0[1] + (c1[1] - c0[1]) * k),
        Math.round(c0[2] + (c1[2] - c0[2]) * k),
      ];
    }
  }
  return stops[stops.length - 1]![1];
}
