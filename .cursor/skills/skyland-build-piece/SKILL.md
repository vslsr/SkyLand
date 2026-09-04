---
name: skyland-build-piece
description: Add, change, or debug a SkyLand build piece — a block players place from the build bar with materials from their backpack, snapped to a grid. Covers the three kinds (foundation, wall, fixture), the two surfaces (floating dock / static ground), archetype fields, catalog constraints, shared placement rules, costs and refunds, and the build panel entry. Use when a request says "add a building block / buildable / 建筑块 / 地基 / 墙 / 物件", or when a piece snaps, tilts, blocks, or gets rejected wrongly. Use skyland-actor-component for general Actor architecture, skyland-scene-authoring for scene placement, skyland-render-boundary for a new render model.
---

# SkyLand Build Piece

A build piece is an ordinary Actor with a `buildPiece` Component. The archetype JSON says what it is,
what it costs, and where it may go; everything else — snapping, validation, spawning, replication —
already exists and is shared by both sides. Adding a piece is authoring plus one scene line, not new
systems. Write it that way, and the client ghost and the server verdict cannot drift apart.

## Read before editing

1. Read [references/build-piece-contract.md](references/build-piece-contract.md) completely. It is the
   field-by-field contract, the placement-rule table, and the elevation table.
2. Read `doc/desinger-buildsys.md` (the design intent) and `doc/building-system-implementation.md`
   (where each part of it lives in code).
3. Open the closest existing archetype and copy it rather than starting from a blank file:
   - `config/actors/ground-foundation.actor.json` — static foundation;
   - `config/actors/float-foundation.actor.json` — floating foundation that founds a new hull;
   - `config/actors/wood-wall.actor.json` / `float-wall.actor.json` — walls;
   - `config/actors/campfire.actor.json` — a fixture, i.e. an existing prop that also became buildable.
4. Only if the piece needs geometry no existing model provides, read `skyland-render-boundary` before
   adding a render model.

## Decide the kind and the surface first

Both are declared in the archetype and decide every rule that follows.

| `kind` | occupies | must use render model | may carry |
| --- | --- | --- | --- |
| `foundation` | a whole cell | `line-art-build-foundation` | `mass`, `buoyancy`, `hull` |
| `wall` | one canonical cell edge (`north` = +Z, `east` = +X) | `line-art-build-wall` | `mass` |
| `fixture` | one named slot at the cell centre | its own model (never the two above) | `mass`, `slot` (required) |

| `surface` | snaps to | allowed kinds |
| --- | --- | --- |
| `floating` | a hull's local grid; the piece becomes a child of the hull root and joins its buoyancy | any |
| `static` | the world grid, aligned to terrain cells | any |
| `any` | a hull when the pointer is on one, otherwise the world grid | `fixture` only |

A floating foundation with a `hull` archetype also **founds a new dock** when it is not adjacent to an
existing deck. Without `hull` it can only extend a dock that already exists.

## Add a piece

1. Write `config/actors/<id>.actor.json`: `buildPiece` + `replicationPolicy` (`aoi`) + `render`.
   Keep the render size on the grid — a wall's `width` and a static foundation's `size` must equal the
   build cell size; a floating foundation's `size` must equal the `cellSize` of the hull it founds.
2. List the id in `gameplay.runtimeActorArchetypes` of every scene that offers it
   (`config/scenes/*.scene.json`). A hull archetype referenced through `buildPiece.hull` is pulled in
   automatically — do not list it again.
3. Nothing else is required. The build bar builds its rows from the scene's archetypes, picks the icon
   from `kind`, prices the row from `cost`, and greys it out when the backpack is short.

Only when the piece needs new geometry, extend the render chain in the same change:
`src/scenes/data/SceneDefinition.ts` union → `config/actors/actor.schema.json` render `oneOf` →
`src/models/actors/createActorVisualModel.ts` → `shared/actor/simpleCollision.mjs` →
the definition table and model count in `tests/RenderProxyCollisionParity.test.ts`.

## Preserve invariants

- **One rule set, two callers.** `shared/build/` decides snapping, legality, elevation and footprint.
  The client runs it to colour the ghost, the server runs it to accept or reject. Never add a check to
  one side only; a green ghost that the server refuses is the bug this arrangement exists to prevent.
- **Grid coordinates go over the wire, not world coordinates.** A piece on a moving hull keeps its cell
  when the hull sails. The server rebuilds the world pose from its own authoritative hull transform.
- **The archetype declares, the catalog enforces.** `server/actors/ActorCatalog.mjs` rejects a piece
  whose kind, model, size, slot, hull or cost do not agree. Prefer failing there over a runtime guard.
- **Materials are authoritative.** Cost is spent on the server after validation and refunded in full on
  removal; what the backpack cannot hold drops at the piece. The client never predicts either.
- **Occupancy is a slot table, not collision.** A cell, an edge, and each fixture slot hold one piece.
  Pieces on the same surface never block each other; players, drops, props and other hulls do.
- **A support may not be removed from under what it carries.** A foundation with a wall that has no
  other support, or with a fixture on it, refuses removal until those come off first.
- **The hull root is invisible but present on both sides.** It carries buoyancy, the motor and the grid
  on the server, and a model-less proxy in the render world so its boards inherit one bob and one tilt.
  Do not give it a model; do not let the boards bob individually.
- **Budgets are bounded on purpose.** Per player, per room, and per hull `maxPieces`. Keep them; the
  snapshot, the collision table and the site index are all sized by them.
- **Build mode owns its keys.** Placing is on the primary key with the interact key as the touch and
  gamepad route; while a piece is selected, held-item use and nearby interaction are switched off.

## Route adjacent work

- Use `skyland-actor-component` for a new Component, System, snapshot field, ownership or interaction
  architecture. This skill owns the `buildPiece` authoring surface on top of that pipeline.
- Use `skyland-scene-authoring` when only offering existing pieces on a map or editing scene data.
- Use `skyland-render-boundary` for a new render model, a new preview channel, or anything about how a
  placed piece becomes pixels.
- Use `skyland-collision-partition` for the collision shape a render model derives, or for how a player
  walks onto a placed foundation.
- Follow `.cursor/rules/line-art-reference.mdc` for geometry and keep procedural models in `src/models/`.

## Verify

1. `node --test server/tests/buildGrid.test.mjs` — snapping, rules, elevation, occupancy, footprint.
2. `node --test server/tests/BuildSystem.test.mjs` — authoritative placement and removal through
   `ServerScene.applyBuildCommand`, including budgets, refunds and hull lifecycle.
3. Client tests for ghost verdicts and the panel row: `tests/BuildController.test.ts`,
   `tests/BuildPanel.test.ts`.
4. Add a catalog case in `server/tests/ActorCatalog.test.mjs` when the change adds a constraint, and a
   scene case in `server/tests/SceneCatalog.test.mjs` when it adds a scene field.
5. `npm test`, `npm run build`, JSON parsing for edited configs, `git diff --check`.
6. For anything that changed snapping, elevation or blocking, run the real client once: join a room,
   select the piece, and confirm the ghost, the prompt text and the placed Actor. A passing unit test
   does not prove the piece is reachable from the build bar.
