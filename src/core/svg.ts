/**
 * Vector export.
 *
 * The same geometry the canvas draws, emitted as a standalone SVG that opens in
 * a browser, Illustrator or a CAD import. A floor plan you cannot get out of the
 * tool is not much of a floor plan, and an agent that can hand someone a file at
 * the end of a conversation is considerably more useful than one that cannot.
 */

import { ROOM_TYPES } from './catalog';
import {
  approachRect,
  areaM2,
  doorSwingRect,
  furnitureRect,
  openingRect,
  planBounds,
  roomRect,
  wallRuns,
} from './geometry';
import type { Analysis } from './rules';
import type { Plan, Rect } from './types';

export interface SvgOptions {
  /** Draw the clear-floor zones each fitting needs. */
  approach?: boolean;
  /** Annotate rooms with their turning circle and reachable share. */
  annotate?: boolean;
  /** Rule findings to mark up. */
  analysis?: Analysis;
  title?: string;
}

const esc = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const n = (v: number) => Math.round(v * 10) / 10;

/** Rough advance width for a sans-serif string, good enough for label fitting. */
function textWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.56;
}

function clamp(v: number, lo: number, hi: number): number {
  return hi < lo ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v));
}

function rect(r: Rect, attrs: string): string {
  return `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" ${attrs}/>`;
}

export function planToSvg(plan: Plan, options: SvgOptions = {}): string {
  const b = planBounds(plan);
  const pad = 1200;
  const vb = `${n(b.x - pad)} ${n(b.y - pad)} ${n(b.w + pad * 2)} ${n(b.h + pad * 2 + 900)}`;
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${Math.round(
      (b.w + pad * 2) / 10,
    )}" height="${Math.round((b.h + pad * 2 + 900) / 10)}" font-family="system-ui, sans-serif">`,
  );
  parts.push(`<title>${esc(options.title ?? plan.name)}</title>`);
  parts.push(rect({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 + 900 }, 'fill="#fbfaf7"'));

  // Rooms
  for (const room of plan.rooms) {
    parts.push(rect(roomRect(room), `fill="${ROOM_TYPES[room.type].fill}"`));
  }

  // Clear-floor zones, under the furniture so they read as ground markings.
  if (options.approach) {
    for (const f of plan.furniture) {
      const a = approachRect(f);
      if (a) {
        parts.push(
          rect(a, 'fill="rgba(26,99,216,0.10)" stroke="rgba(26,99,216,0.45)" stroke-width="20" stroke-dasharray="120 90"'),
        );
      }
    }
  }

  // Walls
  for (const run of wallRuns(plan)) parts.push(rect(run, 'fill="#2a2823"'));

  // Door swings
  for (const op of plan.openings) {
    const swing = doorSwingRect(plan, op);
    const hole = openingRect(plan, op);
    if (!swing || !hole) continue;
    const horizontal = op.side === 'n' || op.side === 's';
    const hinge = horizontal
      ? { x: hole.x, y: hole.y + hole.h / 2 }
      : { x: hole.x + hole.w / 2, y: hole.y };
    const closed = horizontal ? 0 : Math.PI / 2;
    const open =
      op.swing === 'n' ? -Math.PI / 2 : op.swing === 's' ? Math.PI / 2 : op.swing === 'e' ? 0 : Math.PI;
    const r = op.width;
    const a0 = { x: hinge.x + Math.cos(closed) * r, y: hinge.y + Math.sin(closed) * r };
    const a1 = { x: hinge.x + Math.cos(open) * r, y: hinge.y + Math.sin(open) * r };
    const sweep = open > closed ? 1 : 0;
    parts.push(
      `<path d="M ${n(a0.x)} ${n(a0.y)} A ${n(r)} ${n(r)} 0 0 ${sweep} ${n(a1.x)} ${n(a1.y)}" fill="none" stroke="rgba(64,60,51,0.4)" stroke-width="18"/>`,
      `<line x1="${n(hinge.x)}" y1="${n(hinge.y)}" x2="${n(a1.x)}" y2="${n(a1.y)}" stroke="rgba(64,60,51,0.4)" stroke-width="18"/>`,
    );
  }

  // Windows
  for (const op of plan.openings) {
    if (op.kind !== 'window') continue;
    const r = openingRect(plan, op);
    if (!r) continue;
    parts.push(rect(r, 'fill="#cfd9de"'));
    const horizontal = op.side === 'n' || op.side === 's';
    parts.push(
      horizontal
        ? `<line x1="${n(r.x)}" y1="${n(r.y + r.h / 2)}" x2="${n(r.x + r.w)}" y2="${n(r.y + r.h / 2)}" stroke="#5d7480" stroke-width="22"/>`
        : `<line x1="${n(r.x + r.w / 2)}" y1="${n(r.y)}" x2="${n(r.x + r.w / 2)}" y2="${n(r.y + r.h)}" stroke="#5d7480" stroke-width="22"/>`,
    );
  }

  // Furniture
  for (const f of plan.furniture) {
    const r = furnitureRect(f);
    const fill = f.category === 'fixture' || f.category === 'appliance' ? '#dfe7ea' : '#f2ece1';
    parts.push(rect(r, `fill="${fill}" stroke="#6f6a5d" stroke-width="16" rx="60"`));
    parts.push(
      `<text x="${n(r.x + r.w / 2)}" y="${n(r.y + r.h / 2 + 55)}" font-size="150" fill="#8b8577" text-anchor="middle">${esc(
        f.label,
      )}</text>`,
    );
  }

  // Room labels, kept inside the room they name.
  for (const room of plan.rooms) {
    const stat = options.analysis?.rooms.find((s) => s.id === room.id);
    const title = room.name.toUpperCase();
    const note = stat ? `${stat.turningCircleMm} mm turn · ${Math.round(stat.reachRatio * 100)}%` : '';
    const widest = Math.max(textWidth(title, 220), options.annotate ? textWidth(note, 150) : 0);
    const cx = clamp(
      stat ? stat.openX : room.x + room.w / 2,
      room.x + widest / 2 + 120,
      room.x + room.w - widest / 2 - 120,
    );
    const cy = clamp(
      stat ? stat.openY : room.y + room.h / 2,
      room.y + 340,
      room.y + room.h - (options.annotate ? 560 : 320),
    );
    parts.push(
      `<text x="${n(cx)}" y="${n(cy - 40)}" font-size="220" font-weight="600" fill="#403c33" text-anchor="middle">${esc(
        title,
      )}</text>`,
      `<text x="${n(cx)}" y="${n(cy + 230)}" font-size="190" fill="#8b8577" text-anchor="middle">${areaM2(
        roomRect(room),
      ).toFixed(1)} m²</text>`,
    );
    if (options.annotate && stat) {
      parts.push(
        `<text x="${n(cx)}" y="${n(cy + 450)}" font-size="150" fill="#8b8577" text-anchor="middle">${esc(note)}</text>`,
      );
    }
  }

  // Findings
  if (options.analysis) {
    for (const v of options.analysis.violations) {
      if (!v.at || v.severity === 'info') continue;
      const colour = v.severity === 'error' ? '#c8372f' : '#c07a17';
      parts.push(
        `<circle cx="${n(v.at.x)}" cy="${n(v.at.y)}" r="170" fill="${colour}"/>`,
        `<text x="${n(v.at.x)}" y="${n(v.at.y + 75)}" font-size="210" font-weight="700" fill="#fff" text-anchor="middle">${
          v.severity === 'error' ? '!' : '?'
        }</text>`,
      );
    }
  }

  // Footer: a scale bar and provenance.
  const footY = b.y + b.h + pad * 0.55;
  parts.push(
    `<line x1="${n(b.x)}" y1="${n(footY)}" x2="${n(b.x + 1000)}" y2="${n(footY)}" stroke="#8b8577" stroke-width="26"/>`,
    `<text x="${n(b.x + 1120)}" y="${n(footY + 70)}" font-size="180" fill="#8b8577">1 m</text>`,
    `<text x="${n(b.x + b.w)}" y="${n(footY + 70)}" font-size="180" fill="#8b8577" text-anchor="end">${esc(
      plan.name,
    )} — drawn in Groundplan</text>`,
  );

  parts.push('</svg>');
  return parts.join('\n');
}

/** A markdown room schedule — the table an agent should paste into a reply. */
export function planToSchedule(plan: Plan, analysis: Analysis): string {
  const rows = analysis.rooms.map((r) => {
    const turn = r.turningCircleMm >= plan.settings.turningCircle ? '✓' : `${r.turningCircleMm} mm`;
    return `| ${r.name} | ${r.type} | ${r.areaM2.toFixed(1)} | ${r.widthMm} × ${r.depthMm} | ${turn} | ${Math.round(
      r.reachRatio * 100,
    )}% | ${r.routeWidthMm || '—'} |`;
  });
  return [
    `**${plan.name}** — ${analysis.stats.totalAreaM2} m² over ${analysis.stats.roomCount} rooms.`,
    `Checked against a ${plan.settings.mobilityRadius * 2} mm body, a ${plan.settings.turningCircle} mm turning circle and ${plan.settings.minClearDoor} mm clear doorways.`,
    '',
    '| Room | Type | Area m² | Size mm | Turning circle | Reachable | Route width mm |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
    `${analysis.stats.errorCount} error(s), ${analysis.stats.warningCount} warning(s). Score ${analysis.stats.score}/100.`,
  ].join('\n');
}
