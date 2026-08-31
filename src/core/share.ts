/**
 * Shareable links.
 *
 * The whole plan is compressed into the URL fragment, so a link carries the
 * drawing itself — nothing is uploaded, no account exists, and there is no
 * server to lose it. It also means an agent can finish a conversation by
 * handing someone a link to the plan it just fixed.
 */

import type { Plan } from './types';

const PARAM = 'p';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deflate(text: string): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<string | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/** Encodes a plan into a URL fragment. Falls back to plain base64 if needed. */
export async function encodePlan(plan: Plan): Promise<string> {
  const json = JSON.stringify(plan);
  const packed = await deflate(json);
  if (packed) return `z${toBase64Url(packed)}`;
  return `r${toBase64Url(new TextEncoder().encode(json))}`;
}

export async function decodePlan(token: string): Promise<Plan | null> {
  try {
    const body = token.slice(1);
    const bytes = fromBase64Url(body);
    const json =
      token.startsWith('z') ? await inflate(bytes) : new TextDecoder().decode(bytes);
    if (!json) return null;
    const parsed = JSON.parse(json) as Plan;
    return Array.isArray(parsed?.rooms) && parsed.settings ? parsed : null;
  } catch {
    return null;
  }
}

export async function shareLink(plan: Plan): Promise<string> {
  const token = await encodePlan(plan);
  const base = `${location.origin}${location.pathname}`;
  return `${base}#${PARAM}=${token}`;
}

/** Reads a plan out of the current URL, if one is there. */
export async function planFromLocation(): Promise<Plan | null> {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return null;
  const match = new URLSearchParams(hash).get(PARAM);
  return match ? decodePlan(match) : null;
}

/** Hands the browser a file to save. */
export function download(filename: string, contents: string, mime: string): void {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'groundplan'
  );
}
