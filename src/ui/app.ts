/**
 * The application shell: header, side rail, inspector and the approval dialog.
 *
 * Plain DOM, re-rendered on every store change. The plan is small enough that
 * a full re-render is cheaper than a diffing layer, and it keeps every panel
 * honest about reading from one source of truth — the same one the tools read.
 */

import { CATALOG, ROOM_TYPES, ROOM_TYPE_KEYS } from '../core/catalog';
import { applyFix } from '../core/fixes';
import { areaM2, openingNeighbour, planBounds, roomRect } from '../core/geometry';
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
import {
  ACCEPTED,
  placeUnderlay,
  readImage,
  rescale,
  type LoadedImage,
} from '../core/underlay';
import { download, shareLink, slug } from '../core/share';
import { planToSchedule, planToSvg } from '../core/svg';
import { store } from '../core/store';
import type { Plan, RoomType, Side, Violation } from '../core/types';
import { host, type ToolSpec } from '../mcp/runtime';
import { PlanCanvas } from './canvas';

type Tab = 'issues' | 'activity' | 'tools';

/** Findings the route playback illustrates rather than contradicts. */
const ROUTE_EXPLAINS = new Set([
  'access.unreachable',
  'access.partial',
  'plan.circulation',
  'door.clear_width',
]);

let tab: Tab = 'issues';
let canvas: PlanCanvas;
let toolRunnerFor: string | null = null;
let toolResult: { name: string; text: string } | null = null;
let paletteOpen = false;
let paletteTab: 'rooms' | 'furniture' = 'rooms';
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
  bindImageIntake(root);
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

/**
 * The top bar carries only what a person needs at a glance: what the plan is
 * called, how it is doing, whether an agent may edit it, and whether a Model
 * Context host is listening. Everything else lives where it is used.
 */
function renderHeader(node: HTMLElement): void {
  const a = store.analysis;
  const status = host.status;
  const badgeLabel =
    status === 'native' ? 'WebMCP' : status === 'polyfill' ? 'WebMCP' : 'No agent host';
  const readOnly = store.mode === 'review';

  fill(
    node,
    h(
      'div',
      { class: 'brand' },
      h('div', { class: 'mark', title: 'Groundplan' }, '\u25a4'),
      h(
        'div',
        {},
        h('div', { class: 'brand-name' }, 'Groundplan'),
        h('div', { class: 'brand-sub' }, 'Humans draw. Agents measure.'),
      ),
    ),

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

    h(
      'button',
      {
        class: 'health',
        title: 'Jump to the findings',
        onclick: () => {
          tab = 'issues';
          store.emit();
        },
      },
      scoreChip(a.stats.score),
      a.stats.errorCount + a.stats.warningCount === 0
        ? h('span', { class: 'health-note good' }, 'all clear')
        : h(
            'span',
            { class: 'health-note' },
            a.stats.errorCount
              ? h('span', { class: 'count bad' }, `${a.stats.errorCount} error${a.stats.errorCount === 1 ? '' : 's'}`)
              : null,
            a.stats.warningCount
              ? h('span', { class: 'count warn' }, `${a.stats.warningCount} warning${a.stats.warningCount === 1 ? '' : 's'}`)
              : null,
          ),
    ),

    h(
      'div',
      { class: 'header-actions' },
      h(
        'button',
        {
          class: 'ghost icon',
          disabled: !store.canUndo,
          onclick: () => store.undo(),
          title: 'Undo (Ctrl+Z)',
          'aria-label': 'Undo the last change',
        },
        '\u21ba',
      ),
      h(
        'button',
        {
          class: 'ghost icon',
          disabled: !store.canRedo,
          onclick: () => store.redo(),
          title: 'Redo (Ctrl+Shift+Z)',
          'aria-label': 'Redo',
        },
        '\u21bb',
      ),
      h(
        'button',
        {
          class: `agent-access ${readOnly ? 'locked' : ''}`,
          'aria-pressed': readOnly ? 'true' : 'false',
          title: readOnly
            ? 'The agent can read the plan but every editing tool is unregistered. Click to let it edit again.'
            : 'The agent can propose edits, and you approve each one. Click to make the plan read-only.',
          onclick: () => store.setMode(readOnly ? 'design' : 'review'),
        },
        readOnly ? '\u{1f512} Read-only' : 'Agent can edit',
      ),
      h(
        'div',
        { class: `mcp-badge ${status}`, title: mcpTooltip() },
        h('span', { class: 'dot' }),
        badgeLabel,
        h('span', { class: 'count' }, String(host.specs.length)),
      ),
      h(
        'button',
        {
          class: 'ghost icon',
          title: 'How to drive this with an agent',
          'aria-label': 'How to drive this with an agent',
          onclick: () => {
            helpOpen = true;
            store.emit();
          },
        },
        '?',
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
      // Only findings a journey actually explains. A missing turning circle is
      // about space inside a room, and playing a route that arrives cleanly
      // would argue against the finding rather than illustrate it.
      ROUTE_EXPLAINS.has(v.rule)
        ? h(
            'button',
            {
              class: 'small primary',
              title: 'Watch a wheelchair try it, at full scale on the drawing',
              onclick: (e: Event) => {
                e.stopPropagation();
                const room = roomBehind(v.entities) ?? tightestRoom();
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
            toolResult = {
              name: spec.name,
              text: out.content
                .map((c) =>
                  c.type === 'text'
                    ? c.text
                    : `[image · ${c.mimeType} · about ${Math.round(c.data.length / 1400)} kB]`,
                )
                .join('\n'),
            };
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

/**
 * One row along the bottom. The two overlays that answer different questions
 * are a single three-way choice rather than two checkboxes that can both be on,
 * and everything occasional hides behind a menu.
 */
function renderDock(node: HTMLElement): void {
  const overlayMode = store.overlays.heatmap ? 'clearance' : store.overlays.reach ? 'reach' : 'off';
  const setOverlay = (value: 'reach' | 'clearance' | 'off') => {
    store.overlays.reach = value === 'reach';
    store.overlays.heatmap = value === 'clearance';
    store.emit();
  };

  fill(
    node,
    h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Floor overlay' },
      ...(
        [
          ['reach', 'Step-free reach', 'Shade what can be reached from the front door with a 900 mm body.'],
          ['clearance', 'Clearance', 'Colour every square metre by how much clear space there is.'],
          ['off', 'Plain', 'No overlay.'],
        ] as const
      ).map(([value, label, tip]) =>
        h(
          'button',
          {
            class: overlayMode === value ? 'on' : '',
            'aria-pressed': overlayMode === value ? 'true' : 'false',
            title: tip,
            onclick: () => setOverlay(value),
          },
          label,
        ),
      ),
    ),

    menu('View', [
      checkItem('swings', 'Door swings'),
      checkItem('approach', 'Clear floor zones'),
      checkItem('dimensions', 'Dimensions'),
      checkItem('grid', 'Grid'),
    ]),

    tracingControl(),

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
      menu('Open', [
        menuButton('Two-bed flat (has faults)', () => loadSample(starterPlan())),
        menuButton('Accessible bungalow (passes)', () => loadSample(accessiblePlan())),
        menuButton('Empty shell', () => loadSample(shellPlan())),
        menuButton('Blank page', () => {
          store.newPlan('Untitled plan');
          requestAnimationFrame(() => canvas.fit());
        }),
      ]),
      menu('Export', [
        menuButton('Copy share link', () => void runExport('link')),
        menuButton('SVG drawing', () => void runExport('svg')),
        menuButton('PNG of this view', () => void runExport('png')),
        menuButton('Room schedule', () => void runExport('schedule')),
      ]),
      h('button', { class: 'ghost small', onclick: () => canvas.fit(), title: 'Fit the drawing (F)' }, 'Fit'),
      h('button', { class: 'ghost small icon', onclick: () => canvas.zoomBy(1.25), 'aria-label': 'Zoom in' }, '+'),
      h('button', { class: 'ghost small icon', onclick: () => canvas.zoomBy(1 / 1.25), 'aria-label': 'Zoom out' }, '\u2212'),
    ),
  );
}

/**
 * Tracing an image of a real home.
 *
 * Unlocked, the picture takes the mouse so it can be positioned; locked, the
 * mouse goes back to the drawing and you trace over it. That one switch is the
 * whole interaction.
 */
function tracingControl(): HTMLElement {
  const under = store.underlay;
  if (!under) {
    return h(
      'button',
      {
        class: 'ghost small',
        title: 'Put a photo or screenshot of a floor plan under the drawing and trace it. You can also drop or paste an image straight onto the page.',
        onclick: () => void pickImage(),
      },
      'Trace an image',
    );
  }

  return menu(under.locked ? 'Tracing' : 'Tracing · placing', [
    h('div', { class: 'menu-note' }, under.label),
    h(
      'label',
      { class: 'menu-item field-row' },
      h('span', {}, 'Real width'),
      h('input', {
        type: 'number',
        step: '0.1',
        min: '0.5',
        value: (under.width / 1000).toFixed(1),
        'aria-label': 'Real width of the image, in metres',
        onchange: (e: Event) => {
          const metres = Number((e.target as HTMLInputElement).value);
          if (!Number.isFinite(metres) || metres <= 0) return;
          store.setUnderlay(rescale(under, metres * 1000));
        },
      }),
      h('span', { class: 'unit' }, 'm'),
    ),
    h(
      'label',
      { class: 'menu-item field-row' },
      h('span', {}, 'Fade'),
      h('input', {
        type: 'range',
        min: '10',
        max: '100',
        value: String(Math.round(under.opacity * 100)),
        'aria-label': 'Image opacity',
        oninput: (e: Event) => {
          store.underlay = { ...under, opacity: Number((e.target as HTMLInputElement).value) / 100 };
          store.emit();
        },
        onchange: () => store.setUnderlay(store.underlay),
      }),
    ),
    menuButton(under.locked ? 'Unlock to reposition' : 'Lock in place, and trace', () =>
      store.setUnderlay({ ...under, locked: !under.locked }),
    ),
    menuButton('Replace image…', () => void pickImage()),
    menuButton('Remove', () => store.setUnderlay(null)),
  ]);
}

let picker: HTMLInputElement | null = null;

async function pickImage(): Promise<void> {
  if (!picker) {
    picker = h('input', { type: 'file', accept: ACCEPTED, class: 'sr-only' });
    picker.addEventListener('change', () => {
      const file = picker?.files?.[0];
      if (file) void acceptImage(file);
      if (picker) picker.value = '';
    });
    document.body.appendChild(picker);
  }
  picker.click();
}

/**
 * Places a new tracing image roughly over whatever is already drawn, at a
 * plausible scale, and leaves it unlocked so the next thing you do is put it
 * where it belongs.
 */
async function acceptImage(file: File): Promise<void> {
  let image: LoadedImage;
  try {
    image = await readImage(file);
  } catch (err) {
    window.alert(err instanceof Error ? err.message : String(err));
    return;
  }
  const bounds = planBounds(store.plan);
  const width = store.plan.rooms.length > 0 ? bounds.w : 9000;
  const centre = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
  store.setUnderlay(placeUnderlay(image, width, centre));
  store.note('Added a tracing image', 'human', `${image.label} — set its real width, then lock it.`);
  requestAnimationFrame(() => canvas.fit());
}

/** Dropping or pasting a picture anywhere on the page traces it. */
function bindImageIntake(root: HTMLElement): void {
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  root.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      stop(e);
      e.dataTransfer.dropEffect = 'copy';
      root.classList.add('dropping');
    }
  });
  root.addEventListener('dragleave', () => root.classList.remove('dropping'));
  root.addEventListener('drop', (e) => {
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
    root.classList.remove('dropping');
    if (!file) return;
    stop(e);
    void acceptImage(file);
  });
  window.addEventListener('paste', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && /input|textarea/i.test(target.tagName)) return;
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (file) void acceptImage(file);
  });
}

function loadSample(plan: Plan): void {
  store.reset(plan);
  requestAnimationFrame(() => canvas.fit());
}

/** A dropdown built on <details>, so it closes on Escape and works by keyboard. */
function menu(label: string, items: Child[]): HTMLElement {
  const box = h(
    'details',
    { class: 'menu' },
    h('summary', {}, label, h('span', { class: 'caret' }, '\u25be')),
    h('div', { class: 'menu-body' }, ...items),
  );
  box.addEventListener('click', (e) => {
    // Close once something inside has been chosen.
    if ((e.target as HTMLElement).closest('.menu-body button')) box.removeAttribute('open');
  });
  return box;
}

function menuButton(label: string, onClick: () => void): HTMLElement {
  return h('button', { class: 'menu-item', onclick: onClick }, label);
}

function checkItem(key: keyof typeof store.overlays, label: string): HTMLElement {
  return h(
    'label',
    { class: 'menu-item check' },
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
          class: 'primary',
          onclick: () => {
            paletteOpen = true;
            store.emit();
          },
        },
        '+ Add',
      ),
      h('span', { class: 'sub' }, 'or click anything on the plan to edit it'),
    );
  }

  const showing = paletteTab === 'furniture' && rooms.length > 0 ? 'furniture' : 'rooms';
  return h(
    'div',
    { class: 'inspector palette' },
    h(
      'header',
      {},
      h(
        'div',
        { class: 'segmented small' },
        h(
          'button',
          {
            class: showing === 'rooms' ? 'on' : '',
            onclick: () => {
              paletteTab = 'rooms';
              store.emit();
            },
          },
          'Rooms',
        ),
        h(
          'button',
          {
            class: showing === 'furniture' ? 'on' : '',
            disabled: rooms.length === 0,
            onclick: () => {
              paletteTab = 'furniture';
              store.emit();
            },
          },
          'Furniture',
        ),
      ),
      h(
        'button',
        {
          class: 'ghost icon small',
          'aria-label': 'Close',
          onclick: () => {
            paletteOpen = false;
            store.emit();
          },
        },
        '\u00d7',
      ),
    ),
    showing === 'furniture'
      ? h(
          'div',
          { class: 'palette-grid' },
          ...CATALOG.map((item) =>
            h(
              'button',
              {
                class: 'small',
                title: `${item.w} \u00d7 ${item.h} mm`,
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
    h(
      'p',
      { class: 'sub' },
      showing === 'rooms'
        ? 'New rooms attach to the east of the last one. Drag to move them.'
        : 'Furniture is parked against a free wall, clear of doors.',
    ),
  );
}

/**
 * Walks a body from the front door to a room and plays it back on the drawing.
 * The same call the `show_route` tool makes.
 */
/**
 * The room a finding is about.
 *
 * A doorway sits between two rooms, and the one worth walking to is whichever
 * the door strands — the harder of the two to reach, not simply the one the
 * opening happens to be anchored to.
 */
function roomBehind(entities: string[]): { id: string } | null {
  for (const id of entities) {
    const opening = findOpening(store.plan, id);
    if (opening) {
      const sides = [opening.roomId, openingNeighbour(store.plan, opening)]
        .filter((x): x is string => Boolean(x))
        .map((roomId) => store.analysis.rooms.find((r) => r.id === roomId))
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .sort((a, b) => a.routeWidthMm - b.routeWidthMm);
      if (sides[0]) return { id: sides[0].id };
    }
    const room = store.plan.rooms.find((r) => r.id === id);
    if (room) return room;
  }
  return null;
}

/** Whichever room is hardest to get to — the most interesting one to watch. */
function tightestRoom(): { id: string } | null {
  const worst = store.analysis.rooms
    .filter((r) => r.routeWidthMm > 0)
    .sort((a, b) => a.routeWidthMm - b.routeWidthMm)[0];
  return worst ? { id: worst.id } : (store.plan.rooms[store.plan.rooms.length - 1] ?? null);
}

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
        {},
        h('strong', {}, 'Looking at a real flat?'),
        ' Drop a photo or screenshot of its floor plan anywhere on this page — or paste it — tell it how wide the place really is, lock it down, and trace over it.',
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
        h(
          'button',
          {
            class: 'ghost',
            title: 'Watch a 900 mm wheelchair try to reach the hardest room in this flat',
            onclick: () => {
              close();
              const room = tightestRoom();
              if (room) setTimeout(() => playRoute(room.id), 250);
            },
          },
          'Show me what it does',
        ),
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
