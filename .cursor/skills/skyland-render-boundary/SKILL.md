---
name: skyland-render-boundary
description: Work across SkyLand's Game World / Render World boundary — RenderProxyComponent and ProxyId, the double-buffered transform + visual-param SoA, the render command sink, the instance channels for batched props and fruit, the camera channel, and the ratchet tests that keep gameplay code free of Three.js. Use when adding or moving a visual System, giving an Actor a new appearance or animation, deciding which side of the boundary code belongs on, touching src/render/, or when a ratchet test in tests/RenderSceneBoundary.test.ts fails. For Actor state and replication use skyland-actor-component; for chunk generation use skyland-chunk-world.
---

# SkyLand Render Boundary

The client is split in two. **Game World** owns simulation: Actors, Components, collision, interaction. **Render World** owns everything Three.js touches. They communicate only through bytes and commands — never by sharing objects.

This is not stylistic. The boundary exists so the render world can move onto a worker with `transferControlToOffscreen()`. Anything that holds a `THREE.Object3D` from the gameplay side blocks that move, because objects do not cross a thread boundary.

## Two rules that matter

**1. The boundary is one-way.** Every method on `RenderScene` returns `void`.

A return value means the caller waits for the other side to answer, and a thread
boundary has no "hold on". So identity is allocated on the gameplay side
(`RenderProxyTable`) and passed *in*; nothing is passed back. When you need a value
that the render world happens to compute, check first whether it is a pure function of
data gameplay already holds — `simpleCollision` looked like a render measurement and
was actually `createSimpleCollisionFromRender(render)`, a shared pure function of the
archetype JSON. That round trip is gone.

**2. Gameplay code must not import Three.js.** Specifically:

- No Actor Component under `src/actors/components/` may import `three`, `models/`, `guidance/`, `slime/`, `grass/` or `materials/`.
- No System registered into `ActorWorld` may import them either.

Both are enforced by `tests/RenderSceneBoundary.test.ts`, which also asserts that its list of ActorWorld Systems **equals** the actual `world.addSystem(...)` calls in `ClientActorSystem`. Adding a System means registering it in that list, and the price of registering is passing the import check.

Further ratchets list the render-side files still touching `document` or `window`, the scene components still importing `three` or calling `addWorldObject` (empty), and the callers of `onBeforeRender` (only `SceneRenderer` itself). Every list may only get shorter.

## Read before editing

1. Read [references/render-boundary.md](references/render-boundary.md) completely. It maps every channel, its byte layout, and which side owns what.
2. Read `doc/engine-migration-implementation-plan.md` for why each channel has the shape it does, and what is still unbuilt.
3. Read `src/render/RenderScene.ts` — the boundary interface — before adding anything to it.

## Pick a channel by data shape, not by convenience

There are four ways across, and the right one follows from how the data behaves over time:

| The data is… | Channel | Where |
| --- | --- | --- |
| a fact fixed at spawn (model, colour, which markers exist) | `MeshProxyDesc` / `PlayerProxyDesc` | `createMeshProxy(id, desc)`, with the id from `RenderProxyTable` |
| a fixed set of scalars that changes every frame | transform + visual-param SoA | `RenderTransformBuffer` |
| variable-length, or only changes occasionally | a command | `RenderCommandSink` |
| one record per instance, high count, no proxy of its own | an instance channel | `RenderInstanceBuffer` + a layout module |

Getting this wrong is expensive later. A per-frame scalar sent as a command allocates every frame; a spawn-time fact sent per frame wastes an SoA slot forever.

## Add a new appearance or animation

Presentation lives in the render world and reads the params SoA. It does **not** live on the Actor.

1. Add the parameter to `src/render/RenderVisualParams.ts` and bump the count.
2. Write it from an ActorWorld System (`ActorVisualParamSystem` or a new one) — bytes only.
3. Consume it in the render world's `updateVisuals`, applying it to the proxy's `visualRoot`.

The authoritative root carries the interpolated Transform; `visualRoot` carries waves, bob, tilt and deformation. Both now live inside `ThreeMeshProxy`, not on the Actor — a gameplay-side System reaches neither.

If the appearance needs geometry the render world cannot derive from the spawn descriptor, extend `MeshProxyDesc` rather than passing an object.

## Add a high-count batched visual

Content with hundreds of instances and no individual proxy (dropped piles, fruit on trees) goes through an instance channel:

1. Define the record layout in its own module under `src/render/` (`propInstanceLayout.ts` is the model). Discrete fields go in the `Int32Array` segment, continuous ones in the `Float32Array` segment — never pack integers into floats.
2. Write it from an ActorWorld System that decides the **gameplay facts** (which archetypes batch, whether a stack counts as "single", whether a tree is ripe).
3. Read it from a render-side System that decides **appearance** (which template, which material, how the roll quaternion accumulates).

The buffer is rebuilt every frame rather than diffed: the contents change constantly, so bookkeeping costs more than re-laying it out.

Cross-frame identity needs a number, not an Actor id — strings do not cross a byte boundary. `InstanceIdTable` hands out stable slot numbers and recycles them, the same pattern as `ProxyId`.

## Keep the ordering discipline

Inside `ClientActorSystem`, System order is load-bearing:

1. `ActorTransformSystem` writes world transforms into the SoA write bank.
2. `ActorVisualParamSystem` and the two instance writers add their bytes to the **same** frame.
3. `RenderTransformSyncSystem` publishes — flips the bank and hands it to the render world.
4. `ActorGuidePathSyncSystem` sends commands. Commands do not ride the bank, so they may sit after the flip.
5. Presentation Systems in the render world read the just-published bank.

**Anything writing into the buffer must run before the publish.** Writing after it lands a frame late, and the symptom is subtle: a soft body deforming with a velocity that does not match where it was drawn. Player entities write into the same SoA and run earlier still, in `GrasslandScene.update`, for the same reason.

`publish()` copies the new read bank back onto the write bank, so a slot nobody wrote holds last frame's value rather than a two-frame-old one.

## Answer "which side?" before writing code

Ask what the code needs in order to run.

- Needs Actor Components, collision, or the authoritative Transform → Game World.
- Needs a material, a geometry, a camera, or the canvas → Render World.
- Needs both → it is two pieces, and the channel between them is the design decision. Split it.

Gameplay queries that used to ask the renderer now live on `SceneWorld` (terrain sampling, physics probes, Actor queries). It holds no Three.js at all — crosshair picking is analytic against `SimpleCollision`, not a `Raycaster` against the scene graph. Keep it that way: a per-frame gameplay query must never become a cross-thread round trip.

## Preserve invariants

- The SoA carries **world** transforms. Parent-child relationships cross only as `parentSlot`; resolving local space is the render backend's business.
- Every live slot is rewritten every frame. No dirty flags — double buffering makes a missed write degrade to "hold last frame".
- `ProxyId` is the only identifier that crosses. Actor ids stay on the gameplay side.
- **Slots are allocated by `RenderProxyTable`, on the gameplay side.** It is also the command sink, and that is deliberate: destroying a proxy and recycling its slot are one act. Split them and someone will do half, and the next Actor gets a slot that still has a model on it.
- A proxy created but not yet owned by an Actor is a leak. `createMeshProxy` through `addActor` is a try/finally: on failure the proxy is destroyed.
- Slot recycling means a released slot must be cleared in **both** banks, or the next Actor inherits the previous one's residue.
- Render-side code may not touch `document` or `window`. Use `createDrawingSurface()` from `src/platform/` for offscreen 2D work.
- Input adapters that need `getBoundingClientRect` are input, not rendering, and stay on the main thread.

## Route adjacent work

- `skyland-actor-component` for Actor state, Components, snapshots, and server authority. It owns everything up to the point the Replica exists; this skill owns how that Replica becomes pixels.
- `skyland-chunk-world` for deterministic generation. The chunk render half is `ChunkViewHost`; the planning, terrain overrides and collider registration half is `ChunkStreamer`.
- `skyland-collision-partition` for movement, Rapier registration, and camera probes.

## Verify

1. `npm test` — `tests/RenderSceneBoundary.test.ts` first; it is the test that catches the dangerous class of mistake.
2. `npx tsc --noEmit`.
3. For a new channel, add a focused test on the buffer itself: field layout, growth, and what a missed write degrades to. `tests/RenderTransformBuffer.test.ts`, `tests/RenderInstanceBuffer.test.ts` and `tests/RenderCameraBuffer.test.ts` are the models.
4. Run the app and look at it. A boundary bug typically type-checks and passes unit tests, then shows up as a one-frame lag or a stale pose.

When a ratchet list grows, the fix is to move the code — not to extend the list. The lists exist to make that pressure visible.
