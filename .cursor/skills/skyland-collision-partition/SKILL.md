---
name: skyland-collision-partition
description: Work on SkyLand's collision spatial partitioning and the third-person camera boom — the uniform-grid broad phase in shared/collision, the per-scene CollisionWorld, static chunk colliders derived from world props, server-side collider residency, and the sweep-based camera that stops the lens clipping through geometry. Use when adding or changing what blocks movement or the camera, tuning collider shapes or grid cell size, debugging push-out or camera pop-in, or making a new collidable thing participate. Do not use for the placement algorithm itself (see skyland-chunk-world) or for Actor Component/replication architecture (see skyland-actor-component).
---

# SkyLand Collision Partition

Collision cost comes from comparing one query against every collider. A streamed world makes that unaffordable: the loaded chunk set alone carries about a thousand boxes, and a query only ever cares about the handful next to it. Everything below exists to keep query cost tied to **local density** rather than to world size.

## The one rule that matters

**The broad phase picks candidates. It never changes the answer.**

The narrow phase is `resolveCircleAgainstSimpleCollisions` in `shared/actor/simpleCollision.mjs`. `CollisionWorld.resolveCircle` only decides *which* boxes go into it and forwards the same optional vertical profile. If a change to the grid, query margin, layer masks, or profile forwarding makes a query differ from a full scan with the same inputs, that is a bug, not an optimization.

`server/tests/collisionWorld.test.mjs` is the safety net: 400 boxes, 500 sample points, grid result asserted equal to the brute-force result. Any candidate-selection change that narrows the set too far fails it.

## Read before editing

1. Read [references/collision-partition.md](references/collision-partition.md) completely. It maps every module, states each bound and why it holds, and records the measured costs.
2. Read `shared/actor/simpleCollision.mjs`. The box convention (oriented in XZ, an interval in Y) and the local-space transform live there; never start a second convention.
3. For static world colliders, read `shared/world/chunkColliders.mjs` next to the models it mirrors: `src/models/tree.ts` and `src/models/rock.ts`.
4. For camera work, read `src/camera/CameraBoom.ts` and how `src/controllers/TopDownController.ts` applies its ratio.

## Choose the change scope

- **Change what blocks the player or the camera** (a prop's box, a new layer assignment): edit `PROP_COLLIDER_TEMPLATES` in `shared/world/chunkColliders.mjs` only. It is derived from the placement records, has no WASM counterpart, and both the browser and the room DS read it — a one-sided edit is impossible.
- **Change how far the camera pulls in, how fast it returns, or the probe radius**: `src/camera/CameraBoom.ts` constants only. No collision change.
- **Change the grid's granularity**: `CollisionGrid`'s `cellSize` default, or the value `CollisionWorld` passes. Measure before and after; a smaller cell means fewer candidates but more cell lookups and more multi-cell entries.
- **Make a new kind of thing collidable**: give it a `{ collision, transform, layers }` instance and register it — as a static group if it lives and dies with a chunk, as a dynamic entry if it moves. See below.
- **Change the push-out maths itself**: that is `shared/actor/simpleCollision.mjs`, shared with the room DS, and it changes movement feel everywhere. Treat it as a separate decision from anything in this skill.

## The two shapes of collider

`CollisionWorld` splits colliders by lifetime, because that is what decides how they are maintained:

| | Static group | Dynamic entry |
| --- | --- | --- |
| Keyed by | chunk key | actor id |
| Written by | `ChunkStreamer` (client), `ServerChunkColliders` (DS) | `ClientActorSystem`, `ActorColliderIndex` (DS) |
| Updated | never; replaced or removed wholesale | every frame/tick, in place |
| Removed when | the chunk unloads | the actor disappears |

Adding a collidable thing means picking one of these two and nothing else. Do not add a third path that queries colliders from somewhere else at resolve time — that is exactly the full-set scan this system replaced.

## Keep the bounds

Every rule here exists so the system obeys `.cursor/rules/large-world-compatibility.mdc`:

- Grid cells are created on demand and **deleted when they empty**. A collider that is removed must go through `remove`/`removeStaticGroup`/`removeDynamic`, never be abandoned — an abandoned entry leaks a cell and keeps blocking a path nobody can see.
- Queries allocate no `Set` and no candidate array per call. De-duplication uses the per-entry `stamp`; the candidate array on `CollisionWorld` is reused. Keep it that way when adding a query.
- An entry spanning more than `maximumCellsPerEntry` cells goes to the `oversized` list, which every query visits. That list is the escape hatch for freak-sized boxes, not a place for ordinary content — if a normal prop lands there, the cell size is wrong.
- Client residency follows `keepRadius`; DS residency follows `ServerChunkColliders` and is bounded by players × (2·keepRadius+1)² chunks. Neither may become a function of world area.
- A teleport must reset local state: `CameraBoom.reset()` via `ReconcilerTarget.resetCamera`, and `ServerChunkColliders.sync` recomputing residency. A large focus jump must not drag a collapsed boom or a stale resident set across the world.

## Layers, and why the tree has three boxes

A box carries a `layers` bitmask (`COLLISION_LAYER.MOVEMENT` / `CAMERA`). One shape rarely serves both:

- A tree trunk blocks walking and the camera.
- A tree crown must **not** block walking — the prop grid is 4 m and a 2.4 m-wide invisible wall per tree makes a forest impassable — but it **must** block the camera, or the lens flies through the foliage.

So a tree is a trunk box on both layers plus two crown boxes on `CAMERA` only. When adding a prop, decide both layers deliberately; a prop with no entry in `PROP_COLLIDER_TEMPLATES` is visible but not solid, on either layer.

## The camera boom

Clipping happens because the camera position is `character + fixed offset`, and that expression contains no world. `CameraBoom` treats it as a rod: sweep a sphere along it each frame, shorten on a hit.

Three properties are load-bearing; do not "simplify" them away:

1. **Sweep the full length every frame**, not the currently shortened length. Otherwise a boom that once retracted never learns it may extend again.
2. **Retract instantly, extend smoothly.** A frame of delay on retraction is a frame of clipping; an instant extension is a visible jump, and next to a tree it becomes a shudder.
3. **Only the length changes, never the direction.** That is what keeps the camera axes, the pointer-to-ground ray, and facing resolution identical to the un-occluded case. A boom that also rotates would break `projectPointerToGameplayPlane`.

The sweep expands the box by the probe radius and does a slab test, so corners are square rather than round: grazing a box corner registers slightly early. That error direction is deliberate — pulling in early beats clipping late.

## Verify

1. `node --test "server/tests/*.test.mjs"` — grid de-duplication and cell reclamation, grid-vs-scan equivalence, chunk collider determinism, residency bounds and hysteresis, and cross-chunk walking without penetration.
2. `npm test` — adds the camera boom suite.
3. `npm run build` — type errors.
4. Join a room on `open-world`, then check all four by eye: walking into a trunk stops you; walking under a canopy does **not**; a tree between you and the camera pulls the lens in; stepping clear lets it glide back out rather than snap.
5. When a change could affect cost, measure rather than assume. The reference records the numbers this system was accepted at, and how they were taken.

Update `README.md`'s 碰撞与空间划分 section when the partition contract, the collider shapes, or the boom behaviour changes.
