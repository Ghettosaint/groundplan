/**
 * Entry point.
 *
 * Order matters: the UI mounts first so the page is usable whether or not a
 * Model Context host ever turns up, then the tools are wired. A browser with no
 * WebMCP support gets a perfectly ordinary floor plan editor, which is the
 * progressive-enhancement contract the spec asks for.
 */

import './style.css';
import { planFromLocation } from './core/share';
import { store } from './core/store';
import type { Plan } from './core/types';
import { wireTools } from './mcp/tools';
import { mountApp } from './ui/app';

const STORAGE_KEY = 'groundplan.plan.v1';

function restore(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Plan;
    if (Array.isArray(parsed?.rooms) && parsed.settings) store.plan = parsed;
  } catch {
    // A corrupt draft is not worth blocking the app for; fall back to the sample.
  }
}

function persist(): void {
  let queued = 0;
  store.subscribe(() => {
    window.clearTimeout(queued);
    queued = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store.plan));
      } catch {
        // Private browsing, quota, whatever — the app carries on regardless.
      }
    }, 400);
  });
}

restore();

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element.');

const canvas = mountApp(root);
persist();
wireTools();

// A shared link carries the whole drawing in its fragment, so it wins over
// whatever draft was left in this browser.
void planFromLocation().then((shared) => {
  if (!shared) return;
  store.reset(shared);
  history.replaceState(null, '', location.pathname + location.search);
  requestAnimationFrame(() => canvas.fit());
});

window.addEventListener('load', () => canvas.fit());

// Handy while filming a demo, and harmless otherwise.
Object.assign(window as unknown as Record<string, unknown>, { groundplan: { store, canvas } });
