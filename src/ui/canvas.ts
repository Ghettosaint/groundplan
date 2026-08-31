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
  wallPoint,
  wallSegments,
} from '../core/geometry';
import type { Analysis } from '../core/rules';
import { store } from '../core/store';
import type { Furniture, Opening, Plan, Rect, Room } from '../core/types';

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
    | null = null;
  private hover: string | null = null;
  private fitted = false;

  constructor(host: HTMLElement) {
    this.el = document.createElement('canvas');
    this.el.className = 'sheet';
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
    this.draw();
  }

  zoomBy(factor: number, cx?: number, cy?: number): void {
    const px = cx ?? this.el.clientWidth / 2;
    const py = cy ?? this.el.clientHeight / 2;
    const [wx, wy] = this.toWorld(px, py);
    this.view.scale = Math.max(0.008, Math.min(0.6, this.view.scale * factor));
    this.view.tx = px - wx * this.view.scale;
    this.view.ty = py - wy * this.view.scale;
    this.draw();
  }

  private resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    this.el.width = Math.max(1, Math.round(w * this.dpr));
    this.el.height = Math.max(1, Math.round(h * this.dpr));
    // The first layout pass is the earliest moment a sensible zoom exists.
    if (!this.fitted && w > 80 && h > 80) {
      this.fitted = true;
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
      this.view.tx = this.drag.tx + (e.clientX - rect.left - this.drag.x);
      this.view.ty = this.drag.ty + (e.clientY - rect.top - this.drag.y);
      this.draw();
      return;
    }

    // Live drags mutate the working plan directly and only land in history on
    // pointer-up, so a drag is one undo step rather than a hundred.
    const drag = this.drag;
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
    if (store.overlays.heatmap || store.overlays.reach) this.drawRaster(analysis);
    if (store.overlays.approach) this.drawApproach(plan);
    this.drawWalls(plan);
    if (store.overlays.swings) this.drawSwings(plan);
    this.drawFurniture(plan);
    this.drawOpeningDetail(plan);
    this.drawLabels(plan, analysis);
    if (store.overlays.dimensions) this.drawDimensions(plan);
    this.drawIssueMarkers(analysis);
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
      for (let i = 0; i < g.cols * g.rows; i++) {
        const p = i * 4;
        if (g.floor[i] !== 1 || g.blocked[i] === 1) continue;
        const clear = g.clearance[i]!;
        const reached = analysis.reach.mask[i] === 1;
        if (store.overlays.heatmap) {
          // Red where a body will not fit, amber at the limit, green where it is roomy.
          const t = Math.max(0, Math.min(1, clear / (radius * 2.4)));
          const [r, gg, b] = ramp(t);
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

  /**
   * Walls are drawn as bands with the openings subtracted along their length.
   * Shared walls are drawn once — the room with the lower id owns the band —
   * so a partition never gets painted twice at half opacity.
   */
  private drawWalls(plan: Plan): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = WALL;
    const holes = plan.openings
      .map((op) => openingRect(plan, op))
      .filter((r): r is Rect => r !== null);

    for (const seg of wallSegments(plan)) {
      if (seg.neighbourId && seg.roomId > seg.neighbourId) continue;
      const band = segmentRect(plan, seg);
      if (!band) continue;
      const horizontal = seg.side === 'n' || seg.side === 's';
      const from = horizontal ? band.x : band.y;
      const to = horizontal ? band.x + band.w : band.y + band.h;

      // Subtract every opening that punches through this band.
      let runs: [number, number][] = [[from, to]];
      for (const hole of holes) {
        const acrossHit = horizontal
          ? hole.y < band.y + band.h && hole.y + hole.h > band.y
          : hole.x < band.x + band.w && hole.x + hole.w > band.x;
        if (!acrossHit) continue;
        const h0 = horizontal ? hole.x : hole.y;
        const h1 = horizontal ? hole.x + hole.w : hole.y + hole.h;
        runs = runs.flatMap(([a, b]) => {
          if (h1 <= a || h0 >= b) return [[a, b] as [number, number]];
          const out: [number, number][] = [];
          if (h0 > a) out.push([a, h0]);
          if (h1 < b) out.push([h1, b]);
          return out;
        });
      }

      for (const [a, b] of runs) {
        if (b - a <= 0) continue;
        if (horizontal) ctx.fillRect(a, band.y, b - a, band.h);
        else ctx.fillRect(band.x, a, band.w, b - a);
      }
    }
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
      const cx = room.x + room.w / 2;
      const cy = room.y + room.h / 2;
      ctx.fillStyle = INK;
      ctx.font = `600 ${220}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.fillText(room.name.toUpperCase(), cx, cy - 40);
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
    const phase = (Math.sin(Date.now() / 220) + 1) / 2;
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
    requestAnimationFrame(() => this.draw());
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

function segmentRect(plan: Plan, seg: { roomId: string; side: string; neighbourId: string | null; start: number; end: number }): Rect | null {
  const room = plan.rooms.find((r) => r.id === seg.roomId) as Room | undefined;
  if (!room) return null;
  const t = seg.neighbourId ? plan.settings.interiorWall : plan.settings.exteriorWall;
  const a = wallPoint(room, seg.side as 'n' | 'e' | 's' | 'w', seg.start);
  const b = wallPoint(room, seg.side as 'n' | 'e' | 's' | 'w', seg.end);
  const horizontal = seg.side === 'n' || seg.side === 's';
  return horizontal
    ? { x: a.x, y: a.y - t / 2, w: b.x - a.x, h: t }
    : { x: a.x - t / 2, y: a.y, w: t, h: b.y - a.y };
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

/** Red → amber → green ramp for the clearance heatmap. */
function ramp(t: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0, [198, 60, 48]],
    [0.42, [214, 148, 38]],
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
