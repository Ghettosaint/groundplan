/**
 * Starter plans.
 *
 * The default apartment is deliberately *almost* good: a real, plausible layout
 * that hides two failures you cannot see by eye — a 800 mm bathroom door that
 * strands the bathroom, and a kitchen with no room to turn around. Both only
 * show up once something measures, which is the entire point of the demo.
 */

import { CATALOG_BY_TYPE } from './catalog';
import { DEFAULT_SETTINGS, type Furniture, type Opening, type Plan, type Room, type Side } from './types';

let n = 0;
const id = (p: string) => `${p}${(++n).toString(36)}`;

function room(name: string, type: Room['type'], x: number, y: number, w: number, h: number): Room {
  return { id: id('r'), name, type, x, y, w, h };
}

function door(roomId: string, side: Side, offset: number, width: number, swing: Side | 'none'): Opening {
  return { id: id('o'), kind: width >= 1400 ? 'archway' : 'door', roomId, side, offset, width, swing: width >= 1400 ? 'none' : swing };
}

function win(roomId: string, side: Side, offset: number, width: number): Opening {
  return { id: id('o'), kind: 'window', roomId, side, offset, width, swing: 'none', sill: 900, head: 2100 };
}

export function place(type: string, cx: number, cy: number, rot: 0 | 90 | 180 | 270 = 0): Furniture {
  const item = CATALOG_BY_TYPE.get(type);
  if (!item) throw new Error(`Unknown catalog item: ${type}`);
  return {
    id: id('f'),
    type: item.type,
    label: item.label,
    category: item.category,
    cx,
    cy,
    w: item.w,
    h: item.h,
    rot,
    approach: item.approach,
  };
}

export function starterPlan(): Plan {
  n = 0;
  const living = room('Living room', 'living', 0, 0, 4600, 3600);
  const kitchen = room('Kitchen', 'kitchen', 4600, 0, 2800, 3600);
  const bath = room('Bathroom', 'bathroom', 7400, 0, 2600, 3600);
  const hall = room('Hall', 'hall', 0, 3600, 10000, 1200);
  const bed1 = room('Main bedroom', 'bedroom', 0, 4800, 4000, 2600);
  const bed2 = room('Second bedroom', 'bedroom', 4000, 4800, 3400, 2600);
  const office = room('Study', 'office', 7400, 4800, 2600, 2600);

  return {
    id: 'plan_starter',
    name: 'Maple Court, flat 3',
    rooms: [living, kitchen, bath, hall, bed1, bed2, office],
    openings: [
      // Entrance, off the communal landing.
      door(hall.id, 'w', 150, 900, 'e'),
      // Internal circulation.
      door(living.id, 's', 1600, 1600, 'none'),
      door(kitchen.id, 's', 300, 900, 'n'),
      // Undersized: 800 mm leaves 760 mm clear, and strands the bathroom.
      door(bath.id, 's', 800, 800, 'n'),
      door(bed1.id, 'n', 2900, 900, 's'),
      door(bed2.id, 'n', 2400, 900, 's'),
      door(office.id, 'n', 900, 900, 's'),

      win(living.id, 'n', 800, 2000),
      win(living.id, 'w', 1000, 1200),
      win(kitchen.id, 'n', 600, 1200),
      win(bath.id, 'e', 1000, 600),
      win(bed1.id, 's', 1200, 1600),
      win(bed2.id, 's', 1000, 1600),
      win(office.id, 's', 800, 1200),
    ],
    furniture: [
      // Living
      place('sofa_3', 1800, 700, 0),
      place('coffee_table', 1800, 1900, 0),
      place('armchair', 3800, 2400, 90),
      place('bookshelf', 1000, 3300, 180),
      // Kitchen
      place('sink_kitchen', 5100, 400, 0),
      place('oven', 5900, 400, 0),
      place('fridge', 7000, 425, 0),
      place('dining_table_4', 6000, 2200, 0),
      // Bathroom
      place('wc', 7700, 600, 0),
      place('basin', 8500, 425, 0),
      place('bath', 9600, 1800, 90),
      // Main bedroom
      place('bed_double', 1200, 5700, 270),
      place('wardrobe', 3200, 7100, 180),
      // Second bedroom
      place('bed_single', 5100, 5300, 270),
      place('desk', 4800, 7050, 180),
      // Study
      place('desk', 8700, 7050, 180),
      place('bookshelf', 7560, 5400, 270),
    ],
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** A bare shell to draw into, used by the "New plan" action and `reset_plan`. */
export function emptyPlan(name = 'Untitled plan'): Plan {
  n = 0;
  return {
    id: 'plan_empty',
    name,
    rooms: [],
    openings: [],
    furniture: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

/**
 * A single 6 × 8 m shell with nothing in it — the fastest way to watch an agent
 * design a home from scratch.
 */
export function shellPlan(): Plan {
  n = 0;
  const shell = room('Open shell', 'living', 0, 0, 8000, 6000);
  return {
    id: 'plan_shell',
    name: 'Empty shell, 48 m²',
    rooms: [shell],
    openings: [door(shell.id, 's', 3500, 1000, 'n'), win(shell.id, 'n', 2000, 2400)],
    furniture: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}
