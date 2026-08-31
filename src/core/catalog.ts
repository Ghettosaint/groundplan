/**
 * Furniture and fixture catalogue with real-world dimensions in mm, plus the
 * clear floor each item needs in front of it. The `approach` figures come from
 * the same accessibility guidance the rule engine cites: 1200 mm in front of a
 * fridge or oven, 900 mm beside a bed, 1200 mm in front of a WC.
 */

import type { FurnitureCategory, RoomType } from './types';

export interface CatalogItem {
  type: string;
  label: string;
  category: FurnitureCategory;
  w: number;
  h: number;
  approach: number;
  /**
   * Whether standing this item in front of another one actually gets in the
   * way. A coffee table is low enough to step over the corner of; a wardrobe
   * is not.
   */
  blocksApproach?: boolean;
  /** Room types this item is normally found in, used by the auto-furnish tool. */
  rooms: RoomType[];
}

export const CATALOG: CatalogItem[] = [
  // Sleeping
  { type: 'bed_single', label: 'Single bed', category: 'sleeping', w: 900, h: 2000, approach: 900, rooms: ['bedroom'] },
  { type: 'bed_double', label: 'Double bed', category: 'sleeping', w: 1400, h: 2000, approach: 900, rooms: ['bedroom'] },
  { type: 'bed_king', label: 'King bed', category: 'sleeping', w: 1800, h: 2000, approach: 900, rooms: ['bedroom'] },
  { type: 'cot', label: 'Cot', category: 'sleeping', w: 700, h: 1300, approach: 750, rooms: ['bedroom'] },

  // Seating
  { type: 'sofa_2', label: '2-seat sofa', category: 'seating', w: 1600, h: 900, approach: 900, rooms: ['living'] },
  { type: 'sofa_3', label: '3-seat sofa', category: 'seating', w: 2100, h: 900, approach: 900, rooms: ['living'] },
  { type: 'armchair', label: 'Armchair', category: 'seating', w: 850, h: 850, approach: 750, rooms: ['living', 'office', 'bedroom'] },
  { type: 'dining_chair', label: 'Dining chair', category: 'seating', w: 450, h: 500, approach: 750, rooms: ['dining', 'kitchen'] },

  // Surfaces
  { type: 'dining_table_4', label: 'Dining table (4)', category: 'surface', w: 1200, h: 800, approach: 900, rooms: ['dining', 'kitchen', 'living'] },
  { type: 'dining_table_6', label: 'Dining table (6)', category: 'surface', w: 1800, h: 900, approach: 900, rooms: ['dining', 'kitchen'] },
  { type: 'coffee_table', label: 'Coffee table', category: 'surface', w: 1100, h: 600, approach: 0, blocksApproach: false, rooms: ['living'] },
  { type: 'desk', label: 'Desk', category: 'surface', w: 1400, h: 700, approach: 1100, rooms: ['office', 'bedroom'] },
  { type: 'bedside', label: 'Bedside table', category: 'surface', w: 450, h: 400, approach: 0, blocksApproach: false, rooms: ['bedroom'] },

  // Storage
  { type: 'wardrobe', label: 'Wardrobe', category: 'storage', w: 1200, h: 600, approach: 900, rooms: ['bedroom'] },
  { type: 'bookshelf', label: 'Bookshelf', category: 'storage', w: 900, h: 320, approach: 750, rooms: ['living', 'office', 'bedroom'] },
  { type: 'sideboard', label: 'Sideboard', category: 'storage', w: 1600, h: 450, approach: 750, rooms: ['living', 'dining', 'hall'] },
  { type: 'shoe_rack', label: 'Shoe rack', category: 'storage', w: 800, h: 300, approach: 600, blocksApproach: false, rooms: ['hall'] },

  // Kitchen appliances and runs
  { type: 'counter_run', label: 'Counter run', category: 'appliance', w: 2400, h: 650, approach: 1200, rooms: ['kitchen', 'utility'] },
  { type: 'fridge', label: 'Fridge', category: 'appliance', w: 700, h: 700, approach: 1200, rooms: ['kitchen'] },
  { type: 'oven', label: 'Oven / hob', category: 'appliance', w: 600, h: 650, approach: 1200, rooms: ['kitchen'] },
  { type: 'sink_kitchen', label: 'Kitchen sink', category: 'appliance', w: 800, h: 650, approach: 1200, rooms: ['kitchen', 'utility'] },
  { type: 'dishwasher', label: 'Dishwasher', category: 'appliance', w: 600, h: 650, approach: 1200, rooms: ['kitchen'] },
  { type: 'washer', label: 'Washing machine', category: 'appliance', w: 600, h: 650, approach: 1200, rooms: ['utility', 'bathroom', 'kitchen'] },

  // Bathroom fixtures
  { type: 'wc', label: 'WC', category: 'fixture', w: 400, h: 700, approach: 1200, rooms: ['bathroom'] },
  { type: 'basin', label: 'Basin', category: 'fixture', w: 600, h: 450, approach: 1100, rooms: ['bathroom'] },
  { type: 'shower', label: 'Shower', category: 'fixture', w: 900, h: 900, approach: 900, rooms: ['bathroom'] },
  { type: 'bath', label: 'Bath', category: 'fixture', w: 1700, h: 750, approach: 1100, rooms: ['bathroom'] },
];

export const CATALOG_BY_TYPE = new Map(CATALOG.map((c) => [c.type, c]));

export interface RoomTypeMeta {
  label: string;
  /** Minimum floor area for the room to be usable, m². */
  minArea: number;
  /** Minimum clear dimension in either direction, mm. */
  minDimension: number;
  /** Habitable rooms need daylight and a means of escape. */
  habitable: boolean;
  /** Rooms where a wheelchair must be able to turn on the spot. */
  needsTurningCircle: boolean;
  /** Glazing as a fraction of floor area, for the daylight rule. */
  minGlazingRatio: number;
  fill: string;
}

export const ROOM_TYPES: Record<RoomType, RoomTypeMeta> = {
  living:   { label: 'Living',   minArea: 11, minDimension: 2800, habitable: true,  needsTurningCircle: true,  minGlazingRatio: 0.1,  fill: '#e8efe6' },
  bedroom:  { label: 'Bedroom',  minArea: 7,  minDimension: 2100, habitable: true,  needsTurningCircle: true,  minGlazingRatio: 0.1,  fill: '#e6eaf2' },
  kitchen:  { label: 'Kitchen',  minArea: 6,  minDimension: 1800, habitable: true,  needsTurningCircle: true,  minGlazingRatio: 0.05, fill: '#f3ecdf' },
  bathroom: { label: 'Bathroom', minArea: 3.5,minDimension: 1500, habitable: false, needsTurningCircle: true,  minGlazingRatio: 0,    fill: '#e3eef1' },
  hall:     { label: 'Hall',     minArea: 1.5,minDimension: 900,  habitable: false, needsTurningCircle: false, minGlazingRatio: 0,    fill: '#eeeae4' },
  office:   { label: 'Office',   minArea: 6,  minDimension: 2100, habitable: true,  needsTurningCircle: true,  minGlazingRatio: 0.1,  fill: '#eae7f1' },
  dining:   { label: 'Dining',   minArea: 8,  minDimension: 2400, habitable: true,  needsTurningCircle: true,  minGlazingRatio: 0.1,  fill: '#f1e9e6' },
  utility:  { label: 'Utility',  minArea: 2,  minDimension: 1200, habitable: false, needsTurningCircle: false, minGlazingRatio: 0,    fill: '#ebeeef' },
  storage:  { label: 'Storage',  minArea: 0.8,minDimension: 700,  habitable: false, needsTurningCircle: false, minGlazingRatio: 0,    fill: '#eceae7' },
  balcony:  { label: 'Balcony',  minArea: 2,  minDimension: 1200, habitable: false, needsTurningCircle: false, minGlazingRatio: 0,    fill: '#e7f0ea' },
};

export const ROOM_TYPE_KEYS = Object.keys(ROOM_TYPES) as RoomType[];
