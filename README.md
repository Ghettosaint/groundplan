# Groundplan

**Humans draw. Agents measure.**

A floor plan studio whose geometry engine is exposed to AI agents as [WebMCP](https://github.com/webmachinelearning/webmcp) site tools. An agent can read your drawing, measure it against real accessibility standards, and propose repairs — and every change it makes stops at a consent dialog on the drawing itself until you approve it.

Built for [The WebMCP Challenge](https://webmcp.devpost.com/).

---

## The problem

Nearly every home is designed by someone who cannot see the thing that will make it unusable.

A doorway 100 mm too narrow does not look narrow. A kitchen without a 1500 mm turning circle looks fine on paper. A wardrobe parked in the wrong place quietly cuts a bedroom in half for anyone using a wheelchair, a walker, or a pushchair. These are not aesthetic mistakes — they are geometric ones, invisible to the eye and obvious to a measurement.

Meanwhile the people who most need to check these things — someone adapting a home after an injury, a carer assessing a flat, a small landlord doing an accessibility retrofit — do not have architects on retainer, and cannot drive professional CAD.

## What Groundplan does

Open it and you get a two-bedroom flat that looks perfectly reasonable. Ask an agent to check it, and it isn't:

```
error   Doorway into Bathroom is too tight     760 mm  → needs 815 mm
error   Bathroom is unreachable                  2%    → needs 100%
warning No turning circle in Kitchen           1204 mm → needs 1500 mm
warning Only 39% of Kitchen is usable
warning 68% of the home is step-free reachable
```

The bathroom door is 800 mm. That is 760 mm of clear opening — 40 mm short — and it means a wheelchair user in this flat cannot get to the toilet. Nothing on the drawing looks wrong. The number is wrong.

One tool call fixes it:

```json
{
  "ok": true,
  "approved": true,
  "summary": "Doorway into Bathroom is too tight — Widened the opening from 800 mm to 900 mm.",
  "issues": {
    "before": 6, "after": 4,
    "resolved": ["Doorway into Bathroom is too tight", "Bathroom is unreachable"],
    "introduced": []
  },
  "plan_score": 78
}
```

Score 52 → 78. Step-free reach 68% → 78%. Two findings closed by one 100 mm change, and the agent was told exactly that, in the same round trip.

## Why WebMCP, specifically

This could not be an MCP server sitting behind an API, and it is worth being precise about why.

**The measurements only exist in the page.** Clearance, reachability and turning circles are computed from a live rasterisation of the drawing at 50 mm. There is no document to upload and no stable id scheme to learn — the agent measures the thing the user is currently looking at, in the state they left it.

**The confirmation is the real UI.** When an agent proposes a change, the page renders it next to the actual geometry with an Approve / Discard dialog, and the tool's promise does not resolve until a person clicks. A chat bubble saying "shall I widen the door?" is a paraphrase. This is the drawing.

**The tool set is a function of application state.** WebMCP lets a page register and unregister tools at runtime, so what an agent is *able* to ask for narrows and widens as the user works:

| State | Registered tools |
|---|---|
| Normal editing | 22 |
| Something selected on the canvas | 23 — an `edit_selection` tool appears, scoped to that entity |
| Findings outstanding | `fix_violation` appears, with the live rule ids as its enum |
| **Review mode** | 9 — every mutating tool is unregistered; the agent can look but not touch |
| **A proposal awaiting approval** | Writes withdrawn; only `check_proposal` remains, so edits cannot queue up behind a decision the user has not made |

**Both parties share one history.** Mouse drags and tool calls go through the same `commit()`. The Activity panel shows who did what, and any agent edit has a **revert** button next to it.

## The tool surface

21 base tools plus 2 contextual ones. All lengths are millimetres; every reference resolves by id, exact name, partial name or room type, so `"bathroom"`, `"Bathroom"` and `r3` all work.

### Reading

| Tool | What it gives an agent |
|---|---|
| `get_plan` | Every room with position, size, area, neighbours and external walls; every opening; every item of furniture |
| `check_plan` | All rule findings, each with `measured`, `required`, `unit`, the entities involved and a `fix` phrased as a tool call |
| `analyse_access` | Step-free reachable area, per-room verdicts, turning circles, and the clear width of every doorway sorted tightest-first |
| `measure` | Distance between any two things — or literal `"x,y"` points — plus the clear floor radius at each end |
| `list_catalog` | Real furniture dimensions and the clear floor each item needs in front of it |
| `get_selection` | What the user has selected right now, so "this room" and "that door" resolve |
| `get_activity` | The shared edit history, attributed |

### Writing

`add_room` · `edit_room` · `add_opening` · `edit_opening` · `add_furniture` · `edit_furniture` · `furnish_room` · `delete_entity` · `clear_room` · `set_standards` · `undo_last` · `load_sample`

### Collaborating

| Tool | Why it exists |
|---|---|
| `highlight` | The agent points at things and they pulse on the canvas. Talking about a plan without pointing at it is hard |
| `set_view` | Turns the clearance heatmap and reach overlay on and off, so the agent can *show* what it measured rather than describing it |

### Contextual

| Tool | Appears when |
|---|---|
| `fix_violation` | Anything is failing. Applies the canonical repair — widen the door, add the window, re-park whatever is eating the turning circle |
| `edit_selection` | The user has something selected |
| `check_proposal` | A change is waiting for approval |

### How the tools are written

Three decisions did most of the work:

1. **Failures are prose with a `hint`, never exceptions.** `add_opening` does not just refuse a 1600 mm door — it says *"a 1600 mm opening will not fit the 1200 mm north wall of the Hall; the widest that fits with jambs is 1000 mm."* Models correct that on the next call. They do not correct a stack trace.

2. **Mutations report their effect on the rules.** Every write returns `issues.resolved` and `issues.introduced`. The agent finds out whether the edit *helped* without a second round trip, which is what turns a sequence of calls into a convergent loop.

3. **`check_plan` findings are machine-actionable.** `measured`, `required`, `entity_ids` and a `fix` sentence written as an instruction. The rule engine is not a status light; it is the other half of the agent's loop.

## How the measurements work

`src/core/grid.ts` is the honest bit.

1. **Rasterise** the plan at 50 mm. Rooms become floor; wall bands straddle every shared edge; doors and archways are carved back out; windows stay solid; furniture footprints are burned in.
2. **Exact Euclidean distance transform** (Felzenszwalb & Huttenlocher) over the obstacle set gives the **clear radius at every square of floor**. That single field yields turning circles (largest clear circle in a room) and doorway clear widths (longest unobstructed run across the reveal).
3. **Flood fill from the front door**, constrained to cells whose clearance is at least the mobility radius. A doorway narrower than the body simply does not connect — which is exactly the failure this app exists to surface.
4. **Dilate the result by the same radius** to get the floor that body actually *sweeps*, which is what a person means by "how much of my home can I get to".

Toggle **Clearance heatmap** to see step 2 and **Step-free reach** to see steps 3–4. The agent's tools return the numbers behind those colours.

## The rules

| Rule | Checks |
|---|---|
| `door.clear_width` | Clear opening ≥ 815 mm (ADA/ANSI A117.1) |
| `access.unreachable` / `access.partial` | Can a 900 mm body get there from the front door |
| `access.turning_circle` | 1500 mm clear circle in living, bed, kitchen, bathroom |
| `plan.circulation` | Share of the home that is step-free reachable |
| `room.min_area` / `room.min_dimension` | Habitable room minimums |
| `room.daylight` | Glazing ≥ 10% of floor area (5% for kitchens) |
| `bedroom.egress` | Every bedroom has an openable escape window |
| `room.no_door` / `plan.no_entry` | Nothing sealed; the home has a front door |
| `door.swing_clash` | The leaf can open without hitting furniture |
| `furniture.approach` | The clear floor each fitting needs in front of it is actually clear |
| `furniture.overlap` / `furniture.outside` | Nothing occupies the same floor or sticks through a wall |
| `room.overlap` | Rooms meet edge to edge, never intersect |
| `kitchen.work_triangle` | Sink–hob–fridge triangle within 3.6–6.6 m (advisory) |

Thresholds follow widely used residential guidance — ADA/ANSI A117.1 and ISO 21542 for clearances, typical habitable-room minimums elsewhere. They are adjustable at runtime via `set_standards`, because a plan being checked for a walking frame is a different plan from one being checked for a wheelchair. **Groundplan is a design aid, not a code compliance certificate.**

## Running it

```bash
npm install && npm run dev
```

Then open <http://localhost:5173>. Build with `npm run build`; the output in `dist/` is a static site with no backend of any kind — everything, including your plan, stays in the browser.

## Driving it with an agent

- **ChatGPT's built-in browser** — open the page and the tools appear under *Site tools* in the address bar.
- **Chrome 146+** with the `webmcp` flag enabled uses `document.modelContext` natively.
- **Anywhere else** the page loads the [`@mcp-b/global`](https://www.npmjs.com/package/@mcp-b/global) polyfill on demand, so a WebMCP browser extension can drive it. The badge in the header tells you which host you got.
- **No agent at all** — open the **Site tools** tab in the right-hand rail. It lists everything currently registered, with schemas, and runs any of them by hand. It is the identical function an agent calls.

Things worth asking for:

> Check this flat for wheelchair access and fix whatever fails.

> Turn on the clearance heatmap and tell me which room is the worst.

> I'm selecting the second bedroom — can a double bed and a wardrobe fit with a turning circle?

> Load the empty shell and design a one-bedroom flat for a wheelchair user in it.

Without WebMCP support the app is an ordinary, complete floor plan editor. That progressive-enhancement contract is deliberate.

## Architecture

```
src/
  core/
    types.ts      Plan model. Integer millimetres throughout — no float geometry anywhere
    geometry.ts   Rectangles, shared wall segments, openings, door swings, approach zones
    grid.ts       Rasterisation, exact EDT, clearance field, reachability
    rules.ts      The rule engine — every finding carries measured, required and a fix
    fixes.ts      Canonical repairs behind fix_violation
    ops.ts        The only functions that mutate a plan; shared by mouse and tools
    catalog.ts    Furniture with real dimensions and clear-floor requirements
    samples.ts    Starter plans, flawed on purpose
    store.ts      State, undo history, the shared activity feed
  mcp/
    runtime.ts    Host detection (native → polyfill) and the register/unregister diff
    tools.ts      The tool surface
    gate.ts       The consent gate: proposals, change descriptions, issue deltas
  ui/
    canvas.ts     The drawing sheet and direct manipulation
    app.ts        Header, findings, activity, tool inspector, approval dialog
```

No framework, no backend, no telemetry. TypeScript in strict mode, built with Vite.

## Licence

MIT — see [LICENSE](LICENSE).
