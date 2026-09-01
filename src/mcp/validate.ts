/**
 * Argument checking.
 *
 * The Model Context host does not validate arguments against the schema it was
 * given — a tool's `execute` is handed whatever the model sent. That is fine
 * until someone asks for something the app cannot do: an agent that writes
 * `{ shape: "L" }` because a person asked for an L-shaped room gets a plain
 * rectangle and no indication that half the request was dropped. Silently doing
 * the wrong thing is the worst possible answer.
 *
 * So every tool checks its own arguments first, and says precisely what it did
 * not understand, what it does accept, and — where the mistake is a common
 * misconception about what a floor plan editor can model — why.
 */

export interface PropSchema {
  type?: string;
  enum?: unknown[];
  description?: string;
  items?: PropSchema;
}

export interface ToolSchema {
  type?: string;
  properties?: Record<string, PropSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface Rejection {
  error: string;
  hint: string;
}

/**
 * Things people reasonably ask for that this app does not model. Naming the
 * limit beats a schema error, and pointing at the nearest thing that *does*
 * work beats both.
 */
const MISCONCEPTIONS: { keys: string[]; says: string }[] = [
  {
    keys: ['shape', 'polygon', 'points', 'vertices', 'outline', 'corners', 'curve', 'radius'],
    says: 'Rooms in Groundplan are rectangles. An L-shaped or irregular space is drawn as two or more rooms that meet edge to edge, joined by add_opening with kind "archway" and a width of 1400 mm or more. That is not a workaround: the rule engine then pools their floor area, daylight and turning circle and measures them as one room, so the short leg is never failed for being small.',
  },
  {
    keys: ['floor', 'storey', 'story', 'level', 'basement', 'upstairs', 'stairs', 'staircase'],
    says: 'Groundplan draws one storey at a time. There is no stair geometry and no way to link levels, so a two-storey home has to be checked one floor per plan.',
  },
  {
    keys: ['height', 'ceiling', 'ceiling_height', 'elevation', 'section', 'z'],
    says: 'Only the plan is modelled. The one vertical dimension that exists is a window’s sill and head height, on add_opening.',
  },
  {
    keys: ['colour', 'color', 'material', 'finish', 'texture', 'flooring', 'paint', 'style'],
    says: 'Finishes are not modelled. Room colours on screen come from the room type, which you can set with edit_room.',
  },
  {
    keys: ['image', 'photo', 'picture', 'url', 'file', 'upload', 'src'],
    says: 'A tool cannot load a picture: only the person at the keyboard can, by dropping or pasting an image onto the page. Once they have, get_plan reports it and edit_underlay can scale and position it.',
  },
  {
    keys: ['price', 'cost', 'budget', 'quote', 'estimate'],
    says: 'Costs are not modelled. get_plan gives you the areas and export_plan gives you a room schedule, which is what a quantity estimate would be built from.',
  },
  {
    keys: ['3d', 'three_d', 'render', 'camera', 'view_angle', 'perspective', 'tour', 'walkthrough'],
    says: 'There is no 3D view. The nearest thing — and the more useful one — is show_route, which sends a body of a stated width along the real route and stops it where it stops fitting.',
  },
  {
    keys: ['north', 'orientation', 'compass', 'sun', 'daylight_hours', 'latitude'],
    says: 'The plan has no compass orientation and no sun model. The daylight rule is about glazing area, not aspect. Sides named n/e/s/w are drawing directions, not true north.',
  },
];

function explainUnknown(keys: string[]): string | null {
  for (const key of keys) {
    const lower = key.toLowerCase();
    const match = MISCONCEPTIONS.find((m) => m.keys.some((k) => lower === k || lower.includes(k)));
    if (match) return match.says;
  }
  return null;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'number') return Number.isFinite(value) ? `the number ${value}` : 'a number that is not finite';
  if (typeof value === 'string') return `the text ${JSON.stringify(value)}`;
  return `a ${typeof value}`;
}

function typeMatches(value: unknown, type: string | undefined): boolean {
  switch (type) {
    case undefined:
      return true;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

/** Lists a schema's properties in a form worth putting in an error message. */
export function listProperties(schema: ToolSchema): string {
  const props = Object.entries(schema.properties ?? {});
  if (props.length === 0) return 'this tool takes no arguments';
  const required = new Set(schema.required ?? []);
  return props
    .map(([name, def]) => `${name}${required.has(name) ? '*' : ''}: ${def.enum ? def.enum.join(' | ') : (def.type ?? 'any')}`)
    .join(', ');
}

/**
 * Returns null when the arguments are usable, or an explanation when they are
 * not. Only the first problem is reported: an agent that fixes one thing at a
 * time converges faster than one handed a list.
 */
export function validateArgs(toolName: string, schema: ToolSchema, args: unknown): Rejection | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return {
      error: `${toolName} expects an object of arguments, and received ${describe(args)}.`,
      hint: `Accepted arguments — ${listProperties(schema)}.`,
    };
  }

  const supplied = args as Record<string, unknown>;
  const known = new Set(Object.keys(schema.properties ?? {}));

  if (schema.additionalProperties === false) {
    const unknownKeys = Object.keys(supplied).filter((k) => !known.has(k));
    if (unknownKeys.length > 0) {
      const why = explainUnknown(unknownKeys);
      return {
        error: `${toolName} does not accept ${unknownKeys.map((k) => `"${k}"`).join(', ')}, so that part of the request was not carried out.`,
        hint: why
          ? `${why} Accepted arguments — ${listProperties(schema)}.`
          : `Accepted arguments — ${listProperties(schema)}. Call get_capabilities if you are unsure what this app can model.`,
      };
    }
  }

  for (const name of schema.required ?? []) {
    const value = supplied[name];
    if (value === undefined || value === null || value === '') {
      return {
        error: `${toolName} needs "${name}", which was not given.`,
        hint: `Required arguments are marked with * — ${listProperties(schema)}.`,
      };
    }
  }

  for (const [name, value] of Object.entries(supplied)) {
    if (value === undefined) continue;
    const def = schema.properties?.[name];
    if (!def) continue;

    if (!typeMatches(value, def.type)) {
      return {
        error: `${toolName} expects "${name}" to be ${aOrAn(def.type ?? 'value')}, and received ${describe(value)}.`,
        hint:
          def.type === 'number'
            ? `Lengths are plain numbers of millimetres — 3000, not "3 m" or "3000mm". ${def.description ?? ''}`.trim()
            : `${def.description ?? `"${name}" should be ${aOrAn(def.type ?? 'value')}.`}`,
      };
    }

    if (def.enum && !def.enum.some((option) => option === value)) {
      return {
        error: `${toolName} does not recognise ${describe(value)} for "${name}".`,
        hint: `"${name}" must be one of: ${def.enum.join(', ')}.`,
      };
    }

    if (def.type === 'array' && def.items?.type && Array.isArray(value)) {
      const bad = value.findIndex((item) => !typeMatches(item, def.items!.type));
      if (bad >= 0) {
        return {
          error: `${toolName} expects every entry of "${name}" to be ${aOrAn(def.items.type)}; entry ${bad + 1} is ${describe(value[bad])}.`,
          hint: def.description ?? '',
        };
      }
    }
  }

  return null;
}

function aOrAn(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}
