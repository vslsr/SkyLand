---
name: skyland-collision-partition
description: Implement or debug SkyLand's production player physics and collision using the shared Rapier PhysicsWorld/KCC, streamed terrain/prop/Actor collider residency, movement/camera layers, fixed-step prediction and server rewind/replay. Use for jumping, grounding, ledges, autostep, slopes, collision shapes, camera clipping, server correction, or client/server collision parity. Do not use for prop placement generation (see skyland-chunk-world), Actor replication unrelated to collision (see skyland-actor-component), or input bindings (see skyland-input-system).
---

# SkyLand Character Physics and Collision

Production player movement has one implementation: browser prediction and room authority both call `shared/physics/stepCharacter.mjs` at 60 Hz against equivalent Rapier collider sets. Preserve that symmetry. A local-only terrain-height correction, Actor push-out, or variable-`dt` server integrator recreates the desynchronization this architecture replaced.

## Read before editing

1. Read [references/character-physics.md](references/character-physics.md) completely. It records the runtime boundary, coordinates, collider lifetimes, KCC step order, netcode contract, and regression matrix.
2. Read the matching implementation phase under `doc/player-collision-rewrite-00-overview.md` through `06-tests.md`; use the current code as the final source of truth when an older statement conflicts.
3. Read `shared/physics/PhysicsWorld.mjs` and `shared/physics/stepCharacter.mjs` together. The first owns Rapier; the second owns movement semantics.
4. For streamed terrain, read `shared/world/terrainCollisionMesh.mjs` beside `src/models/terrain/createTerrainChunkGeometry.ts`, `src/world/ChunkStreamer.ts`, and `server/scene/ServerTerrainColliders.mjs`.
5. Read [references/collision-partition.md](references/collision-partition.md) only when changing the legacy uniform-grid broad phase used by non-player simple-collision systems. It is not the production player controller.

## Ownership boundaries

| Concern | Owner |
| --- | --- |
| Rapier runtime, bodies, colliders, KCC queries, camera shape cast | `shared/physics/PhysicsWorld.mjs` |
| Acceleration, inertia, gravity, jump edge, velocity projection, grounding | `shared/physics/stepCharacter.mjs` |
| Character dimensions and KCC defaults | `shared/physics/characterParams.mjs` plus Actor movement/jump authoring |
| Terrain render/collision topology | `shared/world/terrainCollisionMesh.mjs` |
| Simple-collision authoring to Rapier descriptors | `shared/physics/simpleCollisionToPhysics.mjs` |
| Client fixed-step prediction | `src/controllers/TopDownController.ts`, `shared/physics/simulationClock.mjs` |
| Pending inputs and authoritative reconciliation | `src/player/PlayerEntity.ts`, `src/player/PlayerReconciler.ts`, `src/network/RoomClient.ts` |
| Server input replay and authoritative snapshots | `server/scene/ServerScene.mjs` |
| Streamed collider residency | `src/world/ChunkStreamer.ts`, `server/scene/ServerTerrainColliders.mjs`, `server/scene/ServerChunkColliders.mjs` |
| Non-player simple-collision broad phase | `shared/collision/CollisionWorld.mjs`; keep separate from player physics |

Do not let `SceneRenderer`, `TerrainWorld`, a visual System, or reconciliation smoothing become a second movement authority.

## Choose the change scope

- **Movement feel**: tune Actor movement/jump data or `createCharacterSimulationParams`. Change `stepCharacter` only for semantics that must match on both sides.
- **KCC behavior**: change constants in `characterParams.mjs` and verify steps, slopes, ledges, water, and ceilings together. Do not scatter Rapier controller settings across entry points.
- **Terrain collision**: change the shared triangle topology or mesh builder, then prove rendering, Rapier ray hits, seams, terrain patches, and negative coordinates still agree.
- **Prop or Actor collision**: keep the existing simple-collision authoring as the source, map it through `simpleCollisionToPhysics`, and register/unregister it in both client and server lifecycles. Use multiple colliders for a real support surface such as a mushroom cap; do not inflate the stem into an invisible wall.
- **Prediction or server snapping**: inspect fixed-step input generation, pending queue retransmission, `ackTick`, rewind/replay, and collider parity before changing visual correction thresholds.
- **Camera clipping**: use `PhysicsWorld.castCameraSphere`; author `CAMERA` layers deliberately. The Scene owns the complete camera offset, and the optional boom changes horizontal reach only.
- **Legacy Actor-vs-Actor collision**: use the uniform-grid reference. Do not route production player movement back through `resolveCircleAgainstSimpleCollisions`.

## Non-negotiable invariants

- `CharacterState.y` is feet height. Only `PhysicsWorld` converts it to the Rapier body's center using `halfHeight + offset`.
- Rewind, spawn correction, and teleport must replace both the kinematic body's current translation and its next translation target. Otherwise the next physics step restores a stale predicted position.
- Collider additions/removals make queries dirty. `prepareQueries()`/`step()` must make new colliders query-visible before KCC or camera casts use them.
- The Rapier world has zero gravity. `stepCharacter` integrates vertical velocity exactly once; enabling world gravity would double-integrate or diverge client and server.
- Terrain uses a trimesh, not a heightfield, because SkyLand has vertical one-metre cliff faces. Rendering and collision must use the same top-face diagonal, and only one chunk side owns a seam cliff.
- Ground snap assists grounded downhill motion; it must not replace gravity at a ledge or pull an ascending/waterborne character onto a lower surface. Horizontal velocity remains continuous after leaving support.
- `MOVEMENT` and `CAMERA` are separate query groups. A tree crown can block the camera without becoming a movement wall.
- The only simulation step is `SIMULATION_STEP_SECONDS`. Input packets contain discrete ticks, never client `deltaSeconds`; the server acknowledges executed ticks and the client replays only later pending steps.
- Reconciliation writes logic state through the physics rewind path. Small correction smoothing is render-only and cannot change future simulation input or collider coordinates.
- Terrain, static prop, and Actor colliders are removed by the same owner that added them. Resident counts must remain a function of keep radius/AOI, never total world area.

## Diagnose by symptom

- **Client stops at a seam while the server keeps moving**: compare client/server resident colliders and topology, then check dirty-query flushing and whether rewind left a stale kinematic next target.
- **Walking off a ledge snaps to the lower tile**: search for height sampling or direct Y assignment outside water support; verify snap is not being used as airborne grounding and that `vx/vz` survive the transition.
- **Jumping onto a mushroom or rock pulls the player down**: inspect support-surface geometry, `minimumY/maximumY`, movement layers, and whether both sides registered the same collider parts.
- **A jump is followed by a large server teleport**: inspect `ackTick`, pending-input pruning, duplicate/old ack idempotence, and zero-latency rewind/replay before raising reconciliation tolerance.
- **Grounded flickers during ascent**: an upward `vy` must keep the state airborne even if the KCC reports a contact from the previous support.
- **Camera enters foliage or retracts forever**: confirm CAMERA-only authoring reaches Rapier, sweep the full intended length every frame, retract immediately, extend smoothly, and reset boom state on teleport.

## Verify

Run focused checks first:

```powershell
node --test server/tests/stepCharacter.test.mjs server/tests/terrainCollisionMesh.test.mjs server/tests/terrainParity.test.mjs server/tests/simulationClock.test.mjs server/tests/rapierRuntime.test.mjs
npm run test:client
```

Then run the repository gates:

```powershell
npm run test:server
npm run test:client
npm run build
git diff --check
```

The minimum physical regression set is binary: jump onto a one-metre step and keep moving; leave a ledge with horizontal inertia and continuous falling; land/walk/leave on rock and mushroom support; hit a ceiling without retaining upward velocity; reproduce prediction and authority with zero replay error; cross chunk boundaries without collider growth.

Finally test a real room with collision debug rendering and paired client/server transform logs. Exercise high/low terrain seams, slopes in every direction, water entry/exit, rocks, mushroom caps, raft decks, chunk boundaries, a teleport, and at least one delayed/lost-input scenario. Automated green tests do not replace this feel/parity pass.
