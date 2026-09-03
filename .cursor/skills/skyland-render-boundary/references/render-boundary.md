# SkyLand Game World / Render World boundary

Use this reference when moving code across the boundary, adding a channel, or diagnosing a one-frame lag between what gameplay computed and what got drawn.

The design rationale, the measurements behind it, and what is still unbuilt are in `doc/engine-migration-implementation-plan.md`. This file records the contract as it stands.

## Runtime topology

```text
Game World (simulation)                      Render World (Three.js)
────────────────────────                     ───────────────────────
ClientActorSystem
  ActorWorld
    Actor + Components  ──ProxyId──────────►  ThreeRenderScene
                                                slot table -> ThreeMeshProxy
    ActorTransformSystem ─┐
    ActorVisualParamSystem─┤ write bank
    ActorInstanceSystem ──┤
    ActorFruitInstanceSystem┘
    ActorGuidePathSyncSystem ──commands────►  RenderCommandSink
    RenderTransformSyncSystem ─publish()──►  submitTransforms(buffer)
                                                updateVisuals(params, dt)
SceneWorld (terrain / physics / Actor queries)
  no Three.js at all                          SceneRenderer
                                                WebGLRenderer + camera
  RenderCameraBuffer.write() ───publish()──►    render() reads the bytes
```

Nothing on the left holds a `THREE.Object3D`. Nothing on the right holds an `Actor`.

## The four channels

### 1. Spawn descriptors — facts fixed at creation

`createMeshProxy(id, desc)` / `createPlayerProxy(id, desc)` take a slot number and a
**configuration description**, never an object, and **return nothing**.

The slot comes from `RenderProxyTable` on the gameplay side. This used to be the other
way round — the render world allocated and returned a `MeshProxyInfo` — and that return
value was the last thing blocking `transferControlToOffscreen`. `MeshProxyInfo` also
carried `simpleCollision`, which turned out to be a pure round trip: the render world
computed it by calling `createSimpleCollisionFromRender(render)`, a shared pure function
of the archetype JSON that gameplay already holds and the server already calls directly.
`tests/RenderProxyCollisionParity.test.ts` pins that equivalence for all 15 models, so
the day someone measures a collision box off real geometry instead, that test fails
first.

The interface deliberately offers no generic `createProxy(kind, desc)`. A new content class gets a new named entry point, so the boundary stays a fixed set of shapes rather than a variable-length primitive table.

Put a value here when it cannot change after spawn: which model, its colours, whether this proxy has an interaction marker or a temperature plate, which kind of water motion it uses.

### 2. Transform + visual-param SoA — per-frame fixed scalars

`RenderTransformBuffer`, one shared byte segment:

```text
[ Int32 header ×4 ][ Float32 transforms 2×cap×4 ][ Int32 parents 2×cap ][ Float32 params 2×cap×N ]
  readBank frameId   x y z yaw ...                  parentSlot ...         RenderVisualParams
```

- Double-buffered. `publish()` flips the read bank, then copies it onto the write bank so an unwritten slot holds last frame's value.
- Params share the segment and the flip **on purpose**: two buffers would tear — intensity from frame N with position from frame N+1.
- Slot index *is* the `ProxyId`. Growth doubles capacity and moves both banks.
- `clear(id)` wipes both banks; a recycled slot must not inherit residue.

Add a param in `src/render/RenderVisualParams.ts` and bump `RENDER_VISUAL_PARAM_COUNT`. Existing params cover fire intensity, temperature, slime motion, buoyancy, elastic tether and drop rotation.

### 3. `RenderCommandSink` — variable-length or occasional

`destroyMeshProxy(id)` and `setGuidePath(id, state, pathChanged)`.

A guide path is a list of waypoints of unknown length that changes rarely, so it does not fit a fixed SoA lane. Note the shape of `pathChanged`: the **sender** decides whether the path actually changed (by revision), and the receiver just applies. Deciding "did this change" is gameplay's fact, not the renderer's inference.

### 4. Instance channels — high-count content with no proxy

`RenderInstanceBuffer(intStride, floatStride)`, one per content class, with the layout in its own module:

| Channel | Layout | Writer | Reader |
| --- | --- | --- | --- |
| dropped piles / logs | `propInstanceLayout.ts` | `ActorInstanceSystem` | `ThreeHighCountBatchVisual` |
| fruit on trees | `fruitInstanceLayout.ts` | `ActorFruitInstanceSystem` | `ThreeFruitBatchVisual` |

Why these need their own channel: `createReplica` returns early for any archetype with `itemStack` **without creating a proxy**, and fruit are not Actors at all. There is no slot in the transform SoA to write to.

Rules:

- Discrete fields go in the `Int32Array` segment, continuous ones in the `Float32Array` segment. Packing an integer into a float will eventually be read back wrong.
- Rebuilt every frame (`beginFrame()` then `push()` per record) rather than diffed — contents change constantly and bookkeeping would cost more.
- `push` validates field counts. Changing a layout without changing its writer is the most common failure mode for a byte interface.
- Cross-frame identity is a number from `InstanceIdTable`, recycled on disappearance. Render-side state keyed by that number (the rolling quaternion of a single fruit) survives exactly as long as the instance does.
- Shared derivations stay shared: fruit anchors come from `selectFruitDropAnchors`, the same function the server uses to throw the drops, so the render side derives positions instead of receiving them.

### The camera

`RenderCameraBuffer` — its own small double-buffered segment, nine floats per bank: position, forward, up.

```text
[ Int32 header ×2 ][ Float32 2×9 ]
```

Only what the renderer actually reads. `CameraFrame` also carries `right` and a view matrix, but building a view matrix is the backend's business.

It is separate from `RenderTransformBuffer` because that segment belongs to the *scene* — it is replaced on map change and grows with proxy slots — while the camera outlives scenes. The cost is two `publish()` calls per tick and a theoretical tear window; both flips happen in the same tick, so it does not occur in practice.

The write happens immediately before `renderer.update(...)` in `GrasslandScene.update`, so the camera and the transforms come from the same tick.

## Ordering

```text
ActorTransformSystem        write world transforms
ActorVisualParamSystem      write params            same frame
ActorInstanceSystem         write pile instances    same frame
ActorFruitInstanceSystem    write fruit instances   same frame
RenderTransformSyncSystem   publish()  ◄── everything above must precede this
ActorGuidePathSyncSystem    commands
──────────────────────────────────────
renderScene.updateVisuals(...)   reads the published bank
```

Player entities (local and remote) also write into this SoA, and they run **before** `renderer.update` in `GrasslandScene` for the same reason. Writing after the flip lands a frame late; the symptom is a soft body deforming with a velocity that does not match where it was drawn.

## What lives where

| Concern | Side | Module |
| --- | --- | --- |
| Actor lifecycle, snapshots, interpolation | Game | `ClientActorSystem` |
| Terrain sampling, physics probes, Actor queries | Game | `SceneWorld` |
| Crosshair picking | Game | `ClientActorSystem.pickInteractableActor`, analytic against `SimpleCollision` |
| Chunk planning, terrain overrides, collider registration | Game | `ChunkStreamer` |
| Chunk geometry, materials, grass, ocean | Render | `ChunkViewHost` |
| Proxy models, markers, visual params | Render | `ThreeRenderScene` / `ThreeMeshProxy` |
| Batched piles, fruit | Render | `ThreeHighCountBatchVisual`, `ThreeFruitBatchVisual`, driven from `updateVisuals` |
| Canvas, camera, draw call | Render | `SceneRenderer` |

Neither `ClientActorSystem` nor `ChunkStreamer` has a `root` or a `beforeRender`: they are `SceneFrameSystem`s, not `SceneVisualSystem`s. A gameplay class that can reach a scene-graph node can hand one out, and a `beforeRender` taking a `WebGLRenderer` is the render loop leaking into gameplay. `ThreeRenderScene.beforeRender` is driven by the render loop directly, so it moves with the canvas.

## The frame has two phases

`SceneRenderer.update` runs the game phase — every `SceneFrameSystem` in composition order, ending with `ClientActorSystem`, whose `RenderTransformSyncSystem` publishes the SoA — and only then the render phase: one call to `renderScene.updateVisuals(transforms, dt, elapsed)`.

That last call used to sit at the end of `ClientActorSystem.update`. It worked because that System happened to be last in the array — an accident of ordering, not a stated rule. Putting it in the caller makes "the render world reads bytes this tick already finished writing" the shape of the call site, and marks exactly what moves when the render loop moves onto a worker: that line and everything in `render()`.

## The ratchets

`tests/RenderSceneBoundary.test.ts` holds several lists that may only shrink:

1. **Every method on `RenderScene` returns `void`** — the boundary is one-way. Checked against the source text, not the types: "returns something nobody uses" type-checks and still breaks on a worker.
2. **Actor Components importing render modules** — currently empty.
3. **ActorWorld Systems** — must equal `ClientActorSystem`'s actual `world.addSystem(...)` calls, and none may import a render implementation. Without the equality check, a new System would slip past the import check unnoticed.
4. **Render-side files touching `document`/`window`** — currently only `SceneRenderer`, whose `devicePixelRatio` moves with the canvas it owns.
5. **Scene components importing `three` or calling `addWorldObject`** — currently empty. A scene component that builds its own `Object3D` and pushes it into the scene graph blocks the worker move exactly like a Component holding one does. The way out is the one the falling leaves and the ability lab took: move the visual into the render world and send it descriptions.
6. **Callers of `onBeforeRender`** — currently only `SceneRenderer` itself. That callback hands out a live `THREE.Camera`; anything needing the camera takes `RenderCamera` (nine floats) instead.

`RenderProxyComponent` importing from `src/render/` is intentional and allowed: it references the boundary types (`ProxyId`, the command sink), which is exactly what it should reference. The rule targets render *implementations*.

## Platform layer

`src/platform/` holds what the boundary needs from the host, so the rest of the code does not ask the host directly:

| Module | Answers |
| --- | --- |
| `threading.ts` | can this machine share memory and start workers? |
| `WorkerJobRunner.ts` | how do I hand one pure function off, and what happens when I cannot? |
| `FrameTimeline.ts` | where did this frame actually go? (nesting-aware self time) |
| `drawingSurface.ts` | give me an offscreen 2D canvas, or nothing |

Each degrades rather than failing: no `SharedArrayBuffer` falls back to `ArrayBuffer`, no worker runs the same function inline behind the same `Promise`, no `OffscreenCanvas` yields a marker plate without text. A 3 KB asset failing to load should not stop a player entering the game.

## Diagnosing

| Symptom | Likely cause |
| --- | --- |
| Ratchet test fails after adding a System | It was not added to `ACTOR_WORLD_SYSTEMS`, or it imports a render module |
| A visual effect lags one frame behind motion | The writer runs after `RenderTransformSyncSystem` |
| A recycled Actor shows the previous one's pose | A released slot was not cleared in both banks |
| A batched instance's rotation resets each frame | Render-side state was keyed by something that is not the stable instance id |
| `push` throws about field counts | A layout module changed without its writer |
| A new Actor renders at the origin for one frame | Transform written after publish, or the proxy was created without a first write |
| Nothing renders, camera looks broken | A zero `forward` vector reached `lookAt`; check the camera channel's default |
