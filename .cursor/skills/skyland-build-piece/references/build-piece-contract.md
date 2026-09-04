# SkyLand build piece contract

Use this reference when authoring a `buildPiece` archetype, changing what the catalog accepts, or
tracing why a placement was rejected.

## Where each part lives

```text
config/actors/<id>.actor.json      archetype: kind, surface, label, reach, cost, mass/buoyancy, slot, hull
config/actors/actor.schema.json    JSON Schema for buildPiece / buildGrid and the two build render models
server/actors/ActorCatalog.mjs     runtime sanitization + cross-field constraints (the real gate)
server/scenes/SceneCatalog.mjs     runtimeActorArchetypes, hull inclusion, startingInventory
shared/actor/components/           BuildPieceComponent.mjs, BuildGridComponent.mjs
shared/build/buildGrid.mjs         cells, edges, snapping, hull local space, founding a new hull
shared/build/buildRules.mjs        validateBuildPlacement, resolveBuildElevation, findDependentPieces
shared/build/buildFootprint.mjs    entity-collision footprint of a placement
shared/build/BuildSiteIndex.mjs    occupancy: one piece per cell / edge / fixture slot
server/actors/BuildMutations.mjs   authoritative place + remove
server/scene/ServerScene.mjs       applyBuildCommand, buildCellStatus, groundTopHeight, footprint blocking
src/controllers/BuildController.ts client ghost, prompt, and the build:command upstream
src/ui/BuildPanel.ts               the build bar rows
```

## `buildPiece` fields

| field | required | range / rule |
| --- | --- | --- |
| `kind` | yes | `foundation` \| `wall` \| `fixture` |
| `surface` | yes | `floating` \| `static` \| `any`; `any` only for `fixture` |
| `label` | yes | 1–32 chars; shown on the build bar and in the prompt |
| `reach` | yes | 1–16 m, measured from the authoritative player position |
| `cost` | yes | 1–4 entries, distinct `itemType`s, each registered in `config/items/item-catalog.json`, `quantity` 1–99 |
| `mass` | no | 0–1000; must be 0 when `surface` is `static` |
| `buoyancy` | no | 0–1000; must be 0 when `surface` is `static`, and only `foundation` may be non-zero |
| `slot` | fixtures only | kebab-case, ≤24 chars; required for `fixture`, rejected otherwise |
| `hull` | floating foundations only | archetype id with `buildGrid` + `buoyancy`; rejected on any other kind/surface |

Cross-field constraints enforced by `ActorCatalog`:

- `foundation` requires the `line-art-build-foundation` render; `wall` requires `line-art-build-wall`;
  a `fixture` must not use either of those two models.
- a static `foundation`'s `render.size` and any wall's `render.width` must equal the build cell size
  (`BUILD_CELL_SIZE`, currently the terrain cell — 2 m);
- `replicationPolicy` is required — build pieces spread across the whole world, so they replicate by AOI;
- `SceneCatalog` additionally requires a floating foundation's `render.size` to equal the `cellSize` of
  the hull named in `buildPiece.hull`, and pulls that hull archetype into the scene automatically.

Only `line-art-build-foundation` contributes a thickness. It is read from the render definition, not
from `buildPiece`, and decides both where the piece sits and how high its top face is.

## `buildGrid` (hull roots)

| field | required | meaning |
| --- | --- | --- |
| `cellSize` | yes | 0.5–8 m; floating pieces must match it |
| `columns`, `rows` | yes | 0–8; the deck the hull is born with. `0 × 0` = a hull founded by a single board, whose first cell is `(0, 0)` under the root |
| `deckHeight` | yes | −2–10; deck surface in hull-local space. Foundations sit `deckHeight − thickness`, walls and fixtures at `deckHeight` |
| `extentCells` | no | how far out the dock may grow; the cap, not the snapping rule |
| `maxPieces` | no | per-hull budget |

A `buildGrid` requires `buoyancy` on the same archetype. A hull root needs no render — it is invisible,
and the client gives it a model-less proxy so its children inherit one bob and one tilt.

## Snapping (`resolveBuildPlacement`)

- **Static, and floating with no hull hit** — the world grid, aligned to terrain cells: a foundation
  takes the cell under the pointer, a wall the nearest canonical edge, a fixture the cell centre.
- **Floating foundation** — attaches to the nearest hull whose snapped cell **is a deck cell or is
  4-adjacent to one** (diagonals do not count). Otherwise it founds a new hull on the world cell
  (`founding: true`), if the archetype names one.
- **Floating wall / fixture** — attaches to the nearest hull whose extent contains the cell, so the
  ghost stays on the boat and turns red instead of jumping back to the world grid.
- A wall's edge is canonical: a cell's south edge is the `north` edge of the cell below it, and its west
  edge is the `east` edge of the cell to its left. Two players cannot build two overlapping walls.

## Placement rules (`validateBuildPlacement`, in order)

1. `surface` matches the placement (a `fixture` declaring `any` matches both);
2. distance to the placement ≤ `reach`;
3. the cell / edge / fixture slot is free;
4. kind- and surface-specific support:
   - floating foundation, founding — the world cell must be water, and the archetype must name a hull;
   - floating foundation, attaching — not on the hull's own deck, inside `extentCells`, at least one of
     the four neighbours is deck;
   - floating wall — at least one of the edge's two cells is deck; floating fixture — its cell is deck;
   - static — the map must have ground; a foundation may sit on land or on a river bed (a pier);
     a wall needs, on one of its two cells, either a foundation or a cell inside the play area;
     a fixture needs a foundation under it, or a land cell (a river bed needs a pier first);
5. entity collision — the footprint must not overlap players, drops, props or another hull. Pieces on
   the same surface are exempt; they are kept apart by the slot table instead;
6. budget — per player, per room, and the hull's `maxPieces`;
7. materials.

Materials are checked last on purpose: the ghost first says whether the spot is legal, then what is
missing. Rejection ids and their Chinese labels are in `BUILD_REJECTIONS` / `BUILD_REJECTION_LABELS`.

## Elevation (`resolveBuildElevation`)

| placement | result (hull-local for floating, world for static) |
| --- | --- |
| floating foundation | `deckHeight − thickness` — its top face is flush with the deck |
| floating wall / fixture | `deckHeight` |
| static foundation | the cell's highest terrain corner; on a water cell, whichever of that and the sea level is higher |
| static wall | the higher supporting foundation top; without one, the higher of the two terrain cells |
| static fixture | the foundation top under it, else the ground |

`undefined` means there is no surface to stand on; the caller treats that as "cannot place here".

## Command and lifecycle

Upstream is `build:command` with grid coordinates only:

```text
{ kind: 'place', archetypeId, surface, hullActorId?, cellX, cellZ, edge? }
{ kind: 'remove', actorId }
```

`hullActorId` absent on a floating placement means "found a new dock here". On placement the server
spends the cost, creates the hull root first when founding, spawns the piece, parents it to the hull,
adds it to that hull's buoyancy parts, and records it in the site index. On removal it refunds in full
(dropping the overflow at the piece), removes the buoyancy part, and deletes the hull root when its
last piece is gone. A foundation carrying an unsupported wall or any fixture refuses removal.

## Adding a piece — checklist

- [ ] archetype JSON with `buildPiece`, `replicationPolicy`, `render`
- [ ] render size on the grid (foundation `size`, wall `width`; floating foundation matches its hull)
- [ ] `slot` for a fixture, `hull` for a dock-founding floating foundation
- [ ] listed in `gameplay.runtimeActorArchetypes` of each scene that offers it
- [ ] a material that map can actually obtain (harvest, or `gameplay.startingInventory`)
- [ ] tests: catalog rejection for any new constraint, rules coverage for any new placement case
- [ ] run it in the client once and place one
