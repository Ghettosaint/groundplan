/**
 * Groundplan core model.
 *
 * Every length in this file is an integer number of **millimetres**. There is no
 * float geometry anywhere in the model, which means agent-supplied values round
 * to something buildable and two plans that look identical really are identical.
 */

export type Side = 'n' | 'e' | 's' | 'w';

export type RoomType =
  | 'living'
  | 'bedroom'
  | 'kitchen'
  | 'bathroom'
  | 'hall'
  | 'office'
  | 'dining'
  | 'utility'
  | 'storage'
  | 'balcony';

export interface Room {
  id: string;
  name: string;
  type: RoomType;
  /** Interior clear rectangle, mm. Walls straddle the boundary. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export type OpeningKind = 'door' | 'window' | 'archway';

export interface Opening {
  id: string;
  kind: OpeningKind;
  /** The opening is anchored to one room's wall; the neighbour is derived. */
  roomId: string;
  side: Side;
  /** Distance in mm from the room's corner (NW for n/w-ish walls) along the wall. */
  offset: number;
  /** Structural clear width of the hole in the wall, mm. */
  width: number;
  /** Doors only: which way the leaf swings, as a compass side, or 'none' for sliding. */
  swing: Side | 'none';
  /** Windows only: sill height above finished floor, mm. */
  sill?: number;
  /** Windows only: head height above finished floor, mm. */
  head?: number;
}

export type FurnitureCategory =
  | 'seating'
  | 'sleeping'
  | 'storage'
  | 'surface'
  | 'appliance'
  | 'fixture';

export interface Furniture {
  id: string;
  /** Catalog key, e.g. 'bed_double'. */
  type: string;
  label: string;
  category: FurnitureCategory;
  /** Centre position in mm, world coordinates. */
  cx: number;
  cy: number;
  /** Footprint before rotation, mm. */
  w: number;
  h: number;
  /** 0 | 90 | 180 | 270, clockwise. */
  rot: 0 | 90 | 180 | 270;
  /**
   * Depth of clear floor an occupant needs directly in front of this item
   * (in the direction the item faces), mm. 0 means no approach requirement.
   */
  approach: number;
}

export interface PlanSettings {
  /** Interior partition thickness, mm. */
  interiorWall: number;
  /** External envelope thickness, mm. */
  exteriorWall: number;
  /**
   * Radius of the mobility device the plan is checked against, mm.
   * 450 = a 900 mm corridor; the ADA/ISO 21542 reference wheelchair.
   */
  mobilityRadius: number;
  /** Diameter of the clear turning circle required in key rooms, mm. */
  turningCircle: number;
  /** Minimum clear width of a doorway once the leaf is open, mm. */
  minClearDoor: number;
  units: 'metric' | 'imperial';
}

export interface Plan {
  id: string;
  name: string;
  rooms: Room[];
  openings: Opening[];
  furniture: Furniture[];
  settings: PlanSettings;
}

export const DEFAULT_SETTINGS: PlanSettings = {
  interiorWall: 100,
  exteriorWall: 250,
  mobilityRadius: 450,
  turningCircle: 1500,
  minClearDoor: 815,
  units: 'metric',
};

/** An axis-aligned rectangle in world mm. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A stretch of wall shared by a room and either another room or the outside. */
export interface WallSegment {
  roomId: string;
  side: Side;
  /** Neighbour room id, or null when this stretch faces outdoors. */
  neighbourId: string | null;
  /** Offset along the room's wall where the shared stretch starts, mm. */
  start: number;
  /** Offset along the room's wall where the shared stretch ends, mm. */
  end: number;
}

export type Severity = 'error' | 'warning' | 'info';

/**
 * A rule finding. The shape matters: agents get the measured value, the required
 * value and a machine-readable `fix` hint, so the model can close the loop
 * itself instead of guessing at prose.
 */
export interface Violation {
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Ids of the rooms/openings/furniture involved. */
  entities: string[];
  /** What the plan currently measures, mm or m² depending on the rule. */
  measured?: number;
  /** What the rule demands, same unit as `measured`. */
  required?: number;
  unit?: 'mm' | 'm2' | 'ratio' | 'count';
  /** A concrete, actionable next step phrased for a tool call. */
  fix?: string;
  /** Where to draw the marker, world mm. */
  at?: { x: number; y: number };
}

export type EntityKind = 'room' | 'opening' | 'furniture';

export interface Selection {
  kind: EntityKind;
  id: string;
}
