/**
 * The application shell: header, side rail, inspector and the approval dialog.
 *
 * Plain DOM, re-rendered on every store change. The plan is small enough that
 * a full re-render is cheaper than a diffing layer, and it keeps every panel
 * honest about reading from one source of truth — the same one the tools read.
 */

import { CATALOG, ROOM_TYPES, ROOM_TYPE_KEYS } from '../core/catalog';
import { applyFix } from '../core/fixes';
import { areaM2, roomRect } from '../core/geometry';
import {
  addFurniture,
  addRoom,
  deleteFurniture,
  deleteOpening,
  deleteRoom,
  findFurniture,
  findOpening,
  findRoom,
  renameRoom,
  resizeRoom,
  rotateFurniture,
  setDoorSwing,
  setOpeningWidth,
  setRoomType,
} from '../core/ops';
import { accessiblePlan, shellPlan, starterPlan } from '../core/samples';
import { describeJourney, planJourney } from '../core/route';
import { download, shareLink, slug } from '../core/share';
import { planToSchedule, planToSvg } from '../core/svg';
import { store, type Mode } from '../core/store';
import type { RoomType, Side, Violation } from '../core/types';
import { host, type ToolSpec } from '../mcp/runtime';
import { PlanCanvas } from './canvas';

type Tab = 'issues' | 'activity' | 'tools';

let tab: Tab = 'issues';
let canvas: PlanCanvas;
let toolRunnerFor: string | null = null;
let toolResult: { name: string; text: string } | null = null;
let paletteOpen = false;
let helpOpen = localStorage.getItem('groundplan.seen.v1') !== 'yes';

// ── Tiny DOM helper ──────────────────────────────────────────────────────────

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false || v === null) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'value' && el instanceof HTMLInputElement) el.value = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

function fill(node: HTMLElement, ...children: Child[]): void {
  node.replaceChildren(...(children.filter(Boolean) as Node[]));
}

// ── Boot ─────────────────────────────────────────────────────────────────────

export function mountApp(root: HTMLElement): PlanCanvas {
  const header = h('header', { class: 'topbar' });
  const stage = h('div', { class: 'stage' });
  const sheetHost = h('div', { class: 'sheet-host' });
  const rail = h('aside', { class: 'rail' });
  const dock = h('div', { class: 'dock' });
  const overlay = h('div', { class: 'overlay-layer' });
  // Screen readers get the same running commentary the header shows visually.
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });

  stage.append(sheetHost, rail);
  root.append(header, stage, dock, overlay, live);

  canvas = new PlanCanvas(sheetHost);
  requestAnimationFrame(() => canvas.fit());

  let lastSpoken = '';
  const render = () => {
    renderHeader(header);
    renderRail(rail);
    renderDock(dock);
    renderOverlay(overlay);
    const spoken = announcement();
    if (spoken !== lastSpoken) {
      lastSpoken = spoken;
      live.textContent = spoken;
    }
  };

  store.subscribe(render);
  host.onStatus(() => render());
  render();
  bindKeys();
  return canvas;
}

/** One sentence describing the current state, for the live region. */
function announcement(): string {
  const a = store.analysis;
  const sel = store.selection;
  const counts = `${a.stats.errorCount} error${a.stats.errorCount === 1 ? '' : 's'}, ${
    a.stats.warningCount
  } warning${a.stats.warningCount === 1 ? '' : 's'}.`;
  if (store.proposal) return `An agent is proposing: ${store.proposal.title}. Approve or discard. ${counts}`;
  if (!sel) return counts;
  if (sel.kind === 'room') {
    const room = findRoom(store.plan, sel.id);
    const stat = a.rooms.find((r) => r.id === sel.id);
    if (!room) return counts;
    return `Selected ${room.name}, ${areaM2(roomRect(room))} square metres, turning circle ${
      stat?.turningCircleMm ?? 0
    } millimetres, ${Math.round((stat?.reachRatio ?? 0) * 100)} percent reachable. ${counts}`;
  }
  if (sel.kind === 'furniture') {
    const f = findFurniture(store.plan, sel.id);
    return f ? `Selected ${f.label}, ${f.w} by ${f.h} millimetres. ${counts}` : counts;
  }
  const op = findOpening(store.plan, sel.id);
  return op ? `Selected a ${op.kind}, ${op.width} millimetres wide. ${counts}` : counts;
}

function bindKeys(): void {
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && /input|textarea|select/i.test(target.tagName)) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const sel = store.selection;
      if (!sel) return;
      e.preventDefault();
      store.commit('Deleted an item', 'human', (draft) => {
        if (sel.kind === 'room') deleteRoom(draft, sel.id);
        else if (sel.kind === 'furniture') deleteFurniture(draft, sel.id);
        else deleteOpening(draft, sel.id);
      });
      store.select(null);
    }
    if (e.key === 'f') canvas.fit();
  });
}

// ── Header ───────────────────────────────────────────────────────────────────

function renderHeader(node: HTMLElement): void {
  const a = store.analysis;
  const status = host.status;
  const badgeLabel =
    status === 'native'
      ? 'WebMCP · native'
      : status === 'polyfill'
        ? 'WebMCP · polyfill'
        : 'WebMCP · unavailable';

  fill(
    node,
    h(
      'div',
      { class: 'brand' },
      h('div', { class: 'mark', title: 'Groundplan' }, '▤'),
      h(
        'div',
        {},
        h('div', { class: 'brand-name' }, 'Groundplan'),
        h('div', { class: 'brand-sub' }, 'Humans draw. Agents measure.'),
      ),
    ),

    h(
      'div',
      { class: 'plan-name' },
      h('input', {
        class: 'name-input',
        value: store.plan.name,
        'aria-label': 'Plan name',
        onchange: (e: Event) => {
          const v = (e.target as HTMLInputElement).value;
          store.commit('Renamed the plan', 'human', (d) => {
            d.name = v;
          });
        },
      }),
    ),

    h(
      'div',
      { class: 'scorebar' },
      scoreChip(a.stats.score),
      h(
        'div',
        { class: 'metrics' },
        metric(`${a.stats.errorCount}`, 'errors', a.stats.errorCount ? 'bad' : 'good'),
        metric(`${a.stats.warningCount}`, 'warnings', a.stats.warningCount ? 'warn' : 'good'),
        metric(`${Math.round(a.stats.reachableRatio * 100)}%`, 'step-free', a.stats.reachableRatio > 0.9 ? 'good' : 'warn'),
        metric(`${a.stats.totalAreaM2}`, 'm² total'),
      ),
    ),

    h(
      'div',
      { class: 'modes' },
      ...(['design', 'furnish', 'review'] as Mode[]).map((m) =>
        h(
          'button',
          {
            class: `mode ${store.mode === m ? 'on' : ''}`,
            'aria-pressed': store.mode === m ? 'true' : 'false',
            title:
              m === 'review'
                ? 'Review mode unregisters every editing tool — the agent can look but not touch.'
                : `Switch to ${m} mode`,
            onclick: () => store.setMode(m),
          },
          m,
        ),
      ),
    ),

    h(
      'div',
      { class: 'header-actions' },
      h(
        'button',
        {
          class: 'ghost',
          disabled: !store.canUndo,
          onclick: () => store.undo(),
          title: 'Undo (Ctrl+Z)',
          'aria-label': 'Undo the last change',
        },
        '↺',
      ),
      h(
        'button',
        {
          class: 'ghost',
          disabled: !store.canRedo,
          onclick: () => store.redo(),
          title: 'Redo',
          'aria-label': 'Redo',
        },
        '↻',
      ),
      h(
        'button',
        {
          class: 'ghost',
          title: 'How to drive this with an agent',
          'aria-label': 'How to drive this with an agent',
          onclick: () => {
            helpOpen = true;
            store.emit();
          },
        },
        '?',
      ),
      h(
        'div',
        { class: `mcp-badge ${status}`, title: mcpTooltip() },
        h('span', { class: 'dot' }),
        badgeLabel,
        h('span', { class: 'count' }, `${host.toolNames.length} tools`),
      ),
    ),
  );
}

function mcpTooltip(): string {
  if (host.status === 'native') return 'This browser exposes document.modelContext natively. Tools are live.';
  if (host.status === 'polyfill')
    return 'No native Model Context API here, so the page installed the @mcp-b/global polyfill. Tools are live for extensions and the in-page runner.';
  return 'No Model Context host available. The app works normally; agents just cannot see the tools.';
}

function scoreChip(score: number): HTMLElement {
  const band = score >= 85 ? 'good' : score >= 60 ? 'warn' : 'bad';
  return h('div', { class: `score ${band}`, title: 'Overall plan health' }, h('strong', {}, String(score)), h('span', {}, '/100'));
}

function metric(value: string, label: string, tone = ''): HTMLElement {
  return h('div', { class: `metric ${tone}` }, h('strong', {}, value), h('span', {}, label));
}

// ── Right rail ───────────────────────────────────────────────────────────────

function renderRail(node: HTMLElement): void {
  const tabs = h(
    'div',
    { class: 'tabs', role: 'tablist' },
    ...(
      [
        ['issues', `Findings (${store.analysis.violations.length})`],
        ['activity', 'Activity'],
        ['tools', `Site tools (${host.specs.length})`],
      ] as [Tab, string][]
    ).map(([key, label]) =>
      h(
        'button',
        {
          class: `tab ${tab === key ? 'on' : ''}`,
          role: 'tab',
          'aria-selected': tab === key ? 'true' : 'false',
          onclick: () => {
            tab = key;
            store.emit();
          },
        },
        label,
      ),
    ),
  );

  // The approval card lives above the tabs rather than floating over the sheet:
  // the drawing is already showing the proposed change, and covering it up
  // would defeat the point.
  fill(
    node,
    approvalCard(),
    tabs,
    h(
      'div',
      { class: 'rail-body' },
      tab === 'issues' ? issuesPanel() : tab === 'activity' ? activityPanel() : toolsPanel(),
    ),
  );
}

function issuesPanel(): HTMLElement {
  const a = store.analysis;
  if (a.violations.length === 0) {
    return h(
      'div',
      { class: 'empty' },
      h('div', { class: 'empty-mark' }, '✓'),
      h('p', {}, 'Every rule passes. The plan is step-free reachable throughout, every room has daylight and a way in, and nothing blocks a door.'),
    );
  }
  return h(
    'div',
    { class: 'issues' },
    h(
      'p',
      { class: 'panel-note' },
      'These are the same findings ',
      h('code', {}, 'check_plan'),
      ' returns to an agent — measured value, required value and a fix.',
    ),
    ...a.violations.map(issueCard),
  );
}

function issueCard(v: Violation): HTMLElement {
  const unitLabel = v.unit === 'm2' ? ' m²' : v.unit === 'mm' ? ' mm' : v.unit === 'ratio' ? '%' : '';
  const focusEntity = () => {
    const first = v.entities[0];
    if (!first) return;
    const kind = findRoom(store.plan, first)
      ? 'room'
      : findFurniture(store.plan, first)
        ? 'furniture'
        : findOpening(store.plan, first)
          ? 'opening'
          : null;
    if (kind) store.select({ kind, id: first });
  };

  return h(
    'article',
    {
      class: `issue ${v.severity}`,
      // A findings list you can only reach with a mouse would be a poor look on
      // a tool about accessible design.
      role: 'button',
      tabindex: '0',
      'aria-label': `${v.severity}: ${v.title}. ${v.detail}`,
      onkeydown: (e: KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        focusEntity();
      },
      onclick: focusEntity,
    },
    h(
      'header',
      {},
      h('span', { class: `sev ${v.severity}` }, v.severity),
      h('h4', {}, v.title),
    ),
    h('p', {}, v.detail),
    v.measured !== undefined && v.required !== undefined
      ? h(
          'div',
          { class: 'gauge' },
          h('span', { class: 'measured' }, `${v.measured}${unitLabel}`),
          h('span', { class: 'arrow' }, '→'),
          h('span', { class: 'required' }, `needs ${v.required}${unitLabel}`),
        )
      : null,
    h('code', { class: 'rule' }, v.rule),
    h(
      'div',
      { class: 'issue-actions' },
      v.rule.startsWith('access.') || v.rule === 'plan.circulation'
        ? h(
            'button',
            {
              class: 'small primary',
              title: 'Watch it happen on the drawing',
              onclick: (e: Event) => {
                e.stopPropagation();
                const room =
                  v.entities.map((id) => findRoom(store.plan, id)).find(Boolean) ??
                  store.analysis.rooms
                    .filter((r) => r.routeWidthMm > 0)
                    .sort((a, b) => a.routeWidthMm - b.routeWidthMm)
                    .map((r) => findRoom(store.plan, r.id))
                    .find(Boolean);
                if (room) playRoute(room.id);
              },
            },
            'Show me',
          )
        : null,
      h(
        'button',
        {
          class: 'small',
          onclick: (e: Event) => {
            e.stopPropagation();
            const ok = store.commit(`Repaired: ${v.title}`, 'human', (draft) => {
              const outcome = applyFix(draft, v);
              if (!outcome.applied) {
                window.alert(outcome.reason ?? 'No automatic repair for this finding.');
                return false;
              }
              return undefined;
            });
            if (ok) store.flash(v.entities, 'Repaired');
          },
        },
        'Repair',
      ),
      v.fix ? h('span', { class: 'fix-hint', title: v.fix }, v.fix) : null,
    ),
  );
}

function activityPanel(): HTMLElement {
  if (store.activity.length === 0) {
    return h('div', { class: 'empty' }, h('p', {}, 'Nothing has happened yet. Drag a wall, or ask an agent to check the plan.'));
  }
  return h(
    'div',
    { class: 'activity' },
    h(
      'p',
      { class: 'panel-note' },
      'One shared history for both of you. Anything an agent did can be rolled back from here.',
    ),
    ...store.activity.slice(0, 60).map((e) =>
      h(
        'div',
        { class: `event ${e.actor}` },
        h('div', { class: `who ${e.actor}` }, e.actor === 'agent' ? '⌁' : e.actor === 'human' ? '✋' : '•'),
        h(
          'div',
          { class: 'event-body' },
          h('div', { class: 'event-title' }, e.label),
          e.detail ? h('div', { class: 'event-detail' }, e.detail) : null,
          h(
            'div',
            { class: 'event-meta' },
            e.tool ? h('code', {}, e.tool) : null,
            h('time', {}, new Date(e.ts).toLocaleTimeString()),
            e.revertTo !== undefined && e.actor === 'agent'
              ? h(
                  'button',
                  { class: 'link', onclick: () => store.revertTo(e.revertTo!) },
                  'revert',
                )
              : null,
          ),
        ),
      ),
    ),
  );
}

/**
 * The in-page tool inspector. It exists so anyone — including a judge on a
 * browser with no Model Context host — can see exactly which tools this page
 * registers right now, read their schemas, and run one by hand.
 */
function toolsPanel(): HTMLElement {
  const specs = host.specs;
  return h(
    'div',
    { class: 'tools' },
    host.status === 'unavailable'
      ? h(
          'p',
          { class: 'panel-note warn-note' },
          'No Model Context host in this browser, so nothing is registered — but the tools below are real and you can still run them by hand.',
        )
      : null,
    h(
      'p',
      { class: 'panel-note' },
      'Registered through ',
      h('code', {}, 'document.modelContext.registerTool'),
      '. The list changes with the state of the page: ',
      store.mode === 'review'
        ? 'review mode has unregistered every editing tool.'
        : store.proposal
          ? 'editing tools are withdrawn while a proposal is waiting for you.'
          : 'select something on the plan and an edit_selection tool appears.',
    ),
    h(
      'label',
      { class: 'switch' },
      h('input', {
        type: 'checkbox',
        checked: store.requireApproval,
        onchange: (e: Event) => {
          store.requireApproval = (e.target as HTMLInputElement).checked;
          store.emit();
        },
      }),
      h('span', {}, 'Ask me before an agent changes anything'),
    ),
    ...specs.map(toolCard),
  );
}

function toolCard(spec: ToolSpec): HTMLElement {
  const open = toolRunnerFor === spec.name;
  const readOnly = spec.annotations?.readOnlyHint === true;
  const destructive = spec.annotations?.destructiveHint === true;
  return h(
    'article',
    { class: `tool ${open ? 'open' : ''}` },
    h(
      'header',
      {
        role: 'button',
        tabindex: '0',
        'aria-expanded': open ? 'true' : 'false',
        onclick: () => {
          toolRunnerFor = open ? null : spec.name;
          store.emit();
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          toolRunnerFor = open ? null : spec.name;
          store.emit();
        },
      },
      h('code', { class: 'tool-name' }, spec.name),
      readOnly ? h('span', { class: 'chip read' }, 'read-only') : null,
      destructive ? h('span', { class: 'chip destructive' }, 'destructive') : null,
    ),
    h('p', { class: 'tool-desc' }, spec.description),
    open ? toolRunner(spec) : null,
    open && toolResult?.name === spec.name ? h('pre', { class: 'tool-result' }, toolResult.text) : null,
  );
}

function toolRunner(spec: ToolSpec): HTMLElement {
  const schema = spec.inputSchema as {
    properties?: Record<string, { type?: string; enum?: unknown[]; description?: string }>;
    required?: string[];
  };
  const props = schema.properties ?? {};
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();

  const fields = Object.entries(props).map(([key, def]) => {
    let field: HTMLInputElement | HTMLSelectElement;
    if (def.enum) {
      field = h(
        'select',
        {},
        h('option', { value: '' }, '—'),
        ...def.enum.map((v) => h('option', { value: String(v) }, String(v))),
      );
    } else if (def.type === 'boolean') {
      field = h('input', { type: 'checkbox' });
    } else {
      field = h('input', { type: def.type === 'number' ? 'number' : 'text', placeholder: def.description ?? '' });
    }
    inputs.set(key, field);
    return h(
      'label',
      { class: 'field' },
      h('span', {}, key, (schema.required ?? []).includes(key) ? h('em', {}, '*') : null),
      field,
    );
  });

  return h(
    'div',
    { class: 'runner' },
    ...fields,
    h(
      'button',
      {
        class: 'primary small',
        onclick: async () => {
          const args: Record<string, unknown> = {};
          for (const [key, field] of inputs) {
            const def = props[key]!;
            if (field instanceof HTMLInputElement && field.type === 'checkbox') {
              if (field.checked) args[key] = true;
              continue;
            }
            const raw = field.value.trim();
            if (!raw) continue;
            args[key] = def.type === 'number' ? Number(raw) : def.type === 'array' ? raw.split(',').map((s) => s.trim()) : raw;
          }
          toolResult = { name: spec.name, text: 'Running…' };
          store.emit();
          try {
            const out = await spec.execute(args);
            toolResult = { name: spec.name, text: out.content.map((c) => c.text).join('\n') };
          } catch (err) {
            toolResult = { name: spec.name, text: `Threw: ${err instanceof Error ? err.message : String(err)}` };
          }
          store.emit();
        },
      },
      'Run tool',
    ),
    h('span', { class: 'runner-note' }, 'Runs the identical function an agent would call.'),
  );
}

// ── Bottom dock: overlays, palette, inspector ────────────────────────────────

function renderDock(node: HTMLElement): void {
  fill(
    node,
    h(
      'div',
      { class: 'overlays' },
      toggle('reach', 'Step-free reach', 'Shade what can be reached from the front door with a 900 mm body.'),
      toggle('heatmap', 'Clearance heatmap', 'Colour every square metre by how much clear space there is.'),
      toggle('swings', 'Door swings'),
      toggle('approach', 'Clear floor zones', 'The space each fitting needs in front of it to be usable.'),
      toggle('dimensions', 'Dimensions'),
      toggle('grid', 'Grid'),
    ),
    store.overlays.heatmap
      ? h(
          'div',
          { class: 'legend', title: 'Clear radius available at each square of floor' },
          h('span', { class: 'swatch bad' }),
          `under ${store.plan.settings.mobilityRadius * 2} mm`,
          h('span', { class: 'swatch warn' }),
          'tight',
          h('span', { class: 'swatch good' }),
          `${store.plan.settings.turningCircle} mm turning room`,
        )
      : null,
    h(
      'div',
      { class: 'dock-actions' },
      h('button', { class: 'ghost small', onclick: () => canvas.fit() }, 'Fit'),
      h('button', { class: 'ghost small', onclick: () => canvas.zoomBy(1.25) }, '+'),
      h('button', { class: 'ghost small', onclick: () => canvas.zoomBy(1 / 1.25) }, '−'),
      h(
        'select',
        {
          class: 'ghost small',
          'aria-label': 'Load a starter plan',
          onchange: (e: Event) => {
            const select = e.target as HTMLSelectElement;
            const v = select.value;
            select.value = '';
            if (!v) return;
            store.reset(v === 'shell' ? shellPlan() : v === 'accessible' ? accessiblePlan() : starterPlan());
            requestAnimationFrame(() => canvas.fit());
          },
        },
        h('option', { value: '' }, 'Load…'),
        h('option', { value: 'apartment' }, 'Two-bed flat (has faults)'),
        h('option', { value: 'accessible' }, 'Accessible bungalow (passes)'),
        h('option', { value: 'shell' }, 'Empty shell'),
      ),
      h(
        'select',
        {
          class: 'ghost small',
          'aria-label': 'Export the plan',
          onchange: (e: Event) => {
            const select = e.target as HTMLSelectElement;
            const v = select.value;
            select.value = '';
            void runExport(v);
          },
        },
        h('option', { value: '' }, 'Export…'),
        h('option', { value: 'svg' }, 'SVG drawing'),
        h('option', { value: 'png' }, 'PNG of this view'),
        h('option', { value: 'schedule' }, 'Room schedule (markdown)'),
        h('option', { value: 'link' }, 'Copy share link'),
      ),
    ),
  );
}

/**
 * Everything a person might want to take away with them. The share link
 * carries the whole drawing in the URL, so it works with no server behind it.
 */
async function runExport(kind: string): Promise<void> {
  const plan = store.plan;
  const name = slug(plan.name);
  if (kind === 'svg') {
    download(`${name}.svg`, planToSvg(plan, { analysis: store.analysis, annotate: true }), 'image/svg+xml');
  } else if (kind === 'schedule') {
    download(`${name}-schedule.md`, planToSchedule(plan, store.analysis), 'text/markdown');
  } else if (kind === 'png') {
    const url = canvas.toPng();
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } else if (kind === 'link') {
    const url = await shareLink(plan);
    try {
      await navigator.clipboard.writeText(url);
      store.note('Copied a share link', 'human', 'The whole plan travels in the URL.');
    } catch {
      window.prompt('Copy this link:', url);
    }
  }
}

function toggle(key: keyof typeof store.overlays, label: string, title?: string): HTMLElement {
  return h(
    'label',
    { class: `toggle ${store.overlays[key] ? 'on' : ''}`, title: title ?? label },
    h('input', {
      type: 'checkbox',
      checked: store.overlays[key],
      onchange: (e: Event) => {
        store.overlays[key] = (e.target as HTMLInputElement).checked;
        store.emit();
      },
    }),
    label,
  );
}

// ── Floating layer: inspector + approval ─────────────────────────────────────

function renderOverlay(node: HTMLElement): void {
  fill(node, inspectorCard(), agentPresence(), helpCard());
}

function agentPresence(): HTMLElement | null {
  const recent = Date.now() - store.lastAgentSeen < 6000;
  if (!store.agentBusy && !recent) return null;
  return h(
    'div',
    { class: `presence ${store.agentBusy ? 'busy' : ''}` },
    h('span', { class: 'pulse' }),
    store.agentBusy ? `Agent is running ${store.agentBusy}…` : 'Agent is here',
  );
}

function inspectorCard(): HTMLElement | null {
  const sel = store.selection;
  if (!sel) return paletteCard();

  if (sel.kind === 'room') {
    const room = findRoom(store.plan, sel.id);
    if (!room) return null;
    const stat = store.analysis.rooms.find((r) => r.id === room.id);
    return h(
      'div',
      { class: 'inspector' },
      h('header', {}, h('h3', {}, room.name), h('span', { class: 'kind' }, 'room')),
      h(
        'div',
        { class: 'grid2' },
        numberField('Width', room.w, (v) =>
          store.commit(`Resized ${room.name}`, 'human', (d) => {
            resizeRoom(d, room.id, v, undefined, 'w');
          }),
        ),
        numberField('Depth', room.h, (v) =>
          store.commit(`Resized ${room.name}`, 'human', (d) => {
            resizeRoom(d, room.id, undefined, v, 'n');
          }),
        ),
      ),
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'Name'),
        h('input', {
          value: room.name,
          onchange: (e: Event) =>
            store.commit('Renamed a room', 'human', (d) => {
              renameRoom(d, room.id, (e.target as HTMLInputElement).value);
            }),
        }),
      ),
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'Type'),
        h(
          'select',
          {
            onchange: (e: Event) =>
              store.commit('Changed a room type', 'human', (d) => {
                setRoomType(d, room.id, (e.target as HTMLSelectElement).value as RoomType);
              }),
          },
          ...ROOM_TYPE_KEYS.map((k) =>
            h('option', { value: k, selected: k === room.type }, ROOM_TYPES[k].label),
          ),
        ),
      ),
      h(
        'dl',
        { class: 'facts' },
        fact('Area', `${areaM2(roomRect(room))} m²`),
        fact('Turning circle', `${stat?.turningCircleMm ?? 0} mm`, (stat?.turningCircleMm ?? 0) >= store.plan.settings.turningCircle),
        fact('Reachable', `${Math.round((stat?.reachRatio ?? 0) * 100)}%`, (stat?.reachRatio ?? 0) > 0.6),
        fact('Daylight', `${stat?.glazingM2 ?? 0} m²`),
      ),
      h(
        'div',
        { class: 'inspector-actions' },
        h(
          'button',
          {
            class: 'small primary',
            title: 'Watch a 900 mm body travel from the front door to this room',
            onclick: () => playRoute(room.id),
          },
          'Walk the route',
        ),
        h(
          'button',
          {
            class: 'small',
            onclick: () =>
              store.commit(`Deleted ${room.name}`, 'human', (d) => {
                deleteRoom(d, room.id);
              }),
          },
          'Delete',
        ),
      ),
    );
  }

  if (sel.kind === 'furniture') {
    const f = findFurniture(store.plan, sel.id);
    if (!f) return null;
    return h(
      'div',
      { class: 'inspector' },
      h('header', {}, h('h3', {}, f.label), h('span', { class: 'kind' }, 'furniture')),
      h('p', { class: 'sub' }, `${f.w} × ${f.h} mm · needs ${f.approach} mm clear in front`),
      h(
        'div',
        { class: 'row' },
        ...([0, 90, 180, 270] as const).map((r) =>
          h(
            'button',
            {
              class: `small ${f.rot === r ? 'on' : ''}`,
              onclick: () =>
                store.commit(`Rotated ${f.label}`, 'human', (d) => {
                  rotateFurniture(d, f.id, r);
                }),
            },
            `${r}°`,
          ),
        ),
      ),
      h(
        'div',
        { class: 'inspector-actions' },
        h(
          'button',
          {
            class: 'small',
            onclick: () =>
              store.commit(`Removed ${f.label}`, 'human', (d) => {
                deleteFurniture(d, f.id);
              }),
          },
          'Remove',
        ),
      ),
    );
  }

  const op = findOpening(store.plan, sel.id);
  if (!op) return null;
  return h(
    'div',
    { class: 'inspector' },
    h('header', {}, h('h3', {}, op.kind), h('span', { class: 'kind' }, 'opening')),
    numberField('Width', op.width, (v) =>
      store.commit('Resized an opening', 'human', (d) => {
        setOpeningWidth(d, op.id, v);
      }),
    ),
    op.kind === 'door'
      ? h(
          'div',
          { class: 'row' },
          ...(['n', 'e', 's', 'w', 'none'] as const).map((sw) =>
            h(
              'button',
              {
                class: `small ${op.swing === sw ? 'on' : ''}`,
                onclick: () =>
                  store.commit('Changed a door swing', 'human', (d) => {
                    setDoorSwing(d, op.id, sw as Side | 'none');
                  }),
              },
              sw,
            ),
          ),
        )
      : null,
    h(
      'div',
      { class: 'inspector-actions' },
      h(
        'button',
        {
          class: 'small',
          onclick: () =>
            store.commit('Removed an opening', 'human', (d) => {
              deleteOpening(d, op.id);
            }),
        },
        'Remove',
      ),
    ),
  );
}

/** With nothing selected, the card becomes a palette for adding things. */
function paletteCard(): HTMLElement {
  const rooms = store.plan.rooms;
  if (!paletteOpen) {
    return h(
      'div',
      { class: 'inspector palette collapsed' },
      h(
        'button',
        {
          class: 'small',
          onclick: () => {
            paletteOpen = true;
            store.emit();
          },
        },
        store.mode === 'furnish' ? '+ Add furniture' : '+ Add a room',
      ),
      h('span', { class: 'sub' }, 'Click anything on the plan to edit it.'),
    );
  }
  return h(
    'div',
    { class: 'inspector palette' },
    h(
      'header',
      {},
      h('h3', {}, store.mode === 'furnish' ? 'Add furniture' : 'Add a room'),
      h(
        'button',
        {
          class: 'small',
          onclick: () => {
            paletteOpen = false;
            store.emit();
          },
        },
        'Close',
      ),
    ),
    store.mode === 'furnish'
      ? h(
          'div',
          { class: 'palette-grid' },
          ...CATALOG.slice(0, 18).map((item) =>
            h(
              'button',
              {
                class: 'small',
                title: `${item.w} × ${item.h} mm`,
                onclick: () => {
                  const target =
                    (store.selection && findRoom(store.plan, store.selection.id)) ??
                    rooms.find((r) => item.rooms.includes(r.type)) ??
                    rooms[0];
                  if (!target) return;
                  store.commit(`Placed ${item.label}`, 'human', (d) => {
                    const res = addFurniture(d, { type: item.type, roomRef: target.id });
                    if (!res.ok) {
                      window.alert(res.error);
                      return false;
                    }
                    return undefined;
                  });
                },
              },
              item.label,
            ),
          ),
        )
      : h(
          'div',
          { class: 'palette-grid' },
          ...ROOM_TYPE_KEYS.map((k) =>
            h(
              'button',
              {
                class: 'small',
                onclick: () =>
                  store.commit(`Added a ${ROOM_TYPES[k].label.toLowerCase()}`, 'human', (d) => {
                    const anchor = d.rooms[d.rooms.length - 1];
                    const res = addRoom(d, {
                      type: k,
                      widthMm: 3000,
                      depthMm: 3000,
                      againstRoom: anchor?.id,
                      againstSide: 'e',
                    });
                    if (!res.ok) {
                      window.alert(res.error);
                      return false;
                    }
                    return undefined;
                  }),
              },
              ROOM_TYPES[k].label,
            ),
          ),
        ),
    h('p', { class: 'sub' }, 'Click anything on the plan to edit it. Drag to move, scroll to zoom, F to fit.'),
  );
}

/**
 * Walks a body from the front door to a room and plays it back on the drawing.
 * The same call the `show_route` tool makes.
 */
function playRoute(roomId: string, diameterMm?: number): void {
  const plan = store.plan;
  const diameter = diameterMm ?? plan.settings.mobilityRadius * 2;
  const journey = planJourney(plan, store.analysis.grid, roomId, diameter / 2);
  if (!journey) {
    store.note('No route to walk', 'human', 'Nothing connects the entrance to that room.');
    return;
  }
  store.play(journey);
  store.note('Walked the route', 'human', describeJourney(journey, diameter));
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function numberField(label: string, value: number, onCommit: (v: number) => void): HTMLElement {
  return h(
    'label',
    { class: 'field' },
    h('span', {}, label),
    h('input', {
      type: 'number',
      step: '50',
      value: String(value),
      onchange: (e: Event) => onCommit(Number((e.target as HTMLInputElement).value)),
    }),
  );
}

function fact(label: string, value: string, good?: boolean): HTMLElement {
  return h(
    'div',
    { class: `fact ${good === undefined ? '' : good ? 'good' : 'bad'}` },
    h('dt', {}, label),
    h('dd', {}, value),
  );
}

/**
 * A short, dismissible explanation of what this thing is and how to point an
 * agent at it. Judges and first-time visitors should not have to guess.
 */
function helpCard(): HTMLElement | null {
  if (!helpOpen) return null;
  const close = () => {
    helpOpen = false;
    localStorage.setItem('groundplan.seen.v1', 'yes');
    store.emit();
  };
  return h(
    'div',
    { class: 'scrim', onclick: (e: Event) => e.target === e.currentTarget && close() },
    h(
      'div',
      { class: 'help' },
      h('h2', {}, 'Humans draw. Agents measure.'),
      h(
        'p',
        {},
        'This is a floor plan editor whose geometry engine is exposed to AI agents as ',
        h('strong', {}, 'WebMCP site tools'),
        '. An agent can read the plan, measure doorway clearances and turning circles, work out which rooms a wheelchair user can actually reach, and propose fixes — but every change it makes waits for you to approve it, right here on the drawing.',
      ),
      h(
        'ol',
        { class: 'steps' },
        h('li', {}, h('strong', {}, 'Open this page in ChatGPT’s built-in browser'), ', or in Chrome 146+ with the ', h('code', {}, 'webmcp'), ' flag on. Elsewhere the page loads the ', h('code', {}, '@mcp-b/global'), ' polyfill, so a WebMCP browser extension can drive it too.'),
        h('li', {}, 'Ask the agent something real: ', h('em', {}, '“check this flat for wheelchair access and fix whatever fails.”')),
        h('li', {}, 'Watch the ', h('strong', {}, 'Findings'), ' panel and the coloured overlays. The agent is reading exactly the numbers you can see.'),
        h('li', {}, 'Approve or discard each change. Anything it did can be reverted from ', h('strong', {}, 'Activity'), '.'),
      ),
      h(
        'p',
        { class: 'sub' },
        'No agent to hand? Open the ',
        h('strong', {}, 'Site tools'),
        ' tab and run any tool yourself — it is the identical function an agent calls.',
      ),
      h(
        'div',
        { class: 'help-actions' },
        h('button', { class: 'primary', onclick: close }, 'Start drawing'),
      ),
    ),
  );
}

/**
 * The consent dialog. This is where WebMCP earns its keep: the agent's change
 * is described in the page that owns the data, next to the drawing it affects,
 * and nothing is written until a person clicks.
 */
function approvalCard(): HTMLElement | null {
  const p = store.proposal;
  if (!p) return null;
  return h(
    'div',
    { class: 'approval', role: 'dialog', 'aria-label': 'Change proposed by an agent' },
    h(
      'header',
      {},
      h('span', { class: 'agent-tag' }, 'agent'),
      h('h3', {}, p.title),
      h('code', {}, p.tool),
    ),
    h(
      'div',
      { class: 'approval-body' },
      h('p', {}, truncate(p.summary, 260)),
      h('ul', { class: 'changes' }, ...p.changes.slice(0, 8).map((c) => h('li', {}, c))),
      p.changes.length > 8 ? h('p', { class: 'sub' }, `…and ${p.changes.length - 8} more.`) : null,
      h('p', { class: 'ghost-note' }, 'Drawn on the plan in violet. Red means it would be removed.'),
    ),
    h(
      'div',
      { class: 'approval-actions' },
      h('button', { class: 'primary', onclick: () => p.resolve(true) }, 'Approve'),
      h('button', { class: 'ghost', onclick: () => p.resolve(false, 'The user declined the change.') }, 'Discard'),
    ),
  );
}
