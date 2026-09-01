/**
 * Tracing images.
 *
 * The most common way anyone meets a floor plan is as a picture: an estate
 * agent's listing, a photograph of a drawing on a wall, a screenshot of a
 * survey. This lets that picture sit under the drawing at a stated scale, so a
 * person can trace their actual home instead of guessing at it — and so an
 * agent asked to "trace this" is working in the same coordinate system the
 * human can see.
 *
 * The image is deliberately *not* part of the Plan. Plans travel in share links
 * and exports, and a photograph would make both unusable.
 */

export interface Underlay {
  /** Data URL of the picture. */
  src: string;
  /** Where the top-left corner sits, world mm. */
  x: number;
  y: number;
  /** How wide the picture is in the real world, mm. */
  width: number;
  /** Derived from the picture's aspect ratio, mm. */
  height: number;
  opacity: number;
  /** Locked images ignore the mouse, so tracing over them is not a fight. */
  locked: boolean;
  /** For the tools and the UI to report. */
  label: string;
}

/** Anything much larger than this makes localStorage unhappy. */
export const MAX_IMAGE_BYTES = 6_000_000;

export const ACCEPTED = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';

export interface LoadedImage {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  label: string;
}

/** Reads a picked file into a data URL, with its natural dimensions. */
export async function readImage(file: File): Promise<LoadedImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error(`${file.name} is not an image.`);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `${file.name} is ${(file.size / 1_000_000).toFixed(1)} MB. Please use something under ${
        MAX_IMAGE_BYTES / 1_000_000
      } MB.`,
    );
  }
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
  const size = await measure(src);
  return { src, ...size, label: file.name };
}

function measure(src: string): Promise<{ naturalWidth: number; naturalHeight: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({
        naturalWidth: img.naturalWidth || 1000,
        naturalHeight: img.naturalHeight || 1000,
      });
    img.onerror = () => reject(new Error('That file did not decode as an image.'));
    img.src = src;
  });
}

/**
 * Places a picture so that it is `realWidthMm` wide, centred on the given
 * point. One number is all the calibration most people can supply from a
 * listing — "the flat is about nine metres across" — and it is enough.
 */
export function placeUnderlay(
  image: LoadedImage,
  realWidthMm: number,
  centre: { x: number; y: number },
): Underlay {
  const width = Math.max(500, Math.round(realWidthMm));
  const height = Math.round((width * image.naturalHeight) / image.naturalWidth);
  return {
    src: image.src,
    x: Math.round(centre.x - width / 2),
    y: Math.round(centre.y - height / 2),
    width,
    height,
    opacity: 0.55,
    locked: false,
    label: image.label,
  };
}

/** Rescales about the centre, so adjusting the scale does not walk the image off. */
export function rescale(underlay: Underlay, realWidthMm: number): Underlay {
  const cx = underlay.x + underlay.width / 2;
  const cy = underlay.y + underlay.height / 2;
  const width = Math.max(500, Math.round(realWidthMm));
  const height = Math.round((width * underlay.height) / underlay.width);
  return { ...underlay, width, height, x: Math.round(cx - width / 2), y: Math.round(cy - height / 2) };
}

const STORAGE_KEY = 'groundplan.underlay.v1';

export function saveUnderlay(underlay: Underlay | null): void {
  try {
    if (underlay) localStorage.setItem(STORAGE_KEY, JSON.stringify(underlay));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Quota, private browsing — the tracing image is a convenience, not data.
  }
}

export function loadUnderlay(): Underlay | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Underlay;
    return typeof parsed?.src === 'string' && parsed.width > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A smaller copy of the tracing image, for handing to a model.
 *
 * A phone photograph of a floor plan is several megabytes; nobody wants that in
 * a tool result, and no model needs it. Fourteen hundred pixels on the long
 * edge is enough to read dimension strings off an estate agent's drawing.
 */
export async function thumbnail(underlay: Underlay, maxEdge = 1400): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('The tracing image did not decode.'));
    el.src = underlay.src;
  });
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale === 1 && underlay.src.length < 900_000) return underlay.src;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return underlay.src;
    // White behind it: floor plans are line drawings, and transparency turns
    // every wall black-on-black once a model renders it.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    // An SVG that pulls in anything external taints the canvas and toDataURL
    // throws. Handing over the original is worse for size and better than
    // handing over nothing.
    return underlay.src;
  }
}
