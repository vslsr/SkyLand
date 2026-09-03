---
name: skyland-soft-body-deformation
description: Work on SkyLand's soft-body slime deformation — the hybrid core+skin solver, what drives it (movement, jumps, collisions, mouse drag, bites, future snags), how a deformation force is authored, replicated and replayed, and the SoftBodyDeformationComponent that owns one grabbed patch of skin. Use when adding or tuning a way to squash, stretch, dent or pull a slime, when a deformation looks wrong on remote players, or when touching HybridSlimeSimulation, the slime drag params, or the bite interaction. For the render boundary itself use skyland-render-boundary; for Actor state and snapshots use skyland-actor-component.
---

# SkyLand Soft-Body Deformation

A slime's shape is a client-side solver: a spring-driven core plus a per-vertex skin. Nothing about that shape is authoritative. Gameplay never reads it, the server never simulates it, and no deformation may move an Actor, change collision, or affect any gameplay state. What crosses the network is at most **where the skin was grabbed and how far it is being pulled** — six numbers.

## The two halves

**The solver** lives in `src/slime/hybrid/HybridSlimeSimulation.ts`, entirely inside the render world (`ThreeHybridSlimeVisual`). It owns the rest shape, the springs, volume flow, sleeping, and every hard clamp. It is the only place that may decide what a force *looks* like.

**The forces** come from two directions:

| Driver | Path | Owner |
| --- | --- | --- |
| movement, jumps, environment collisions | `SlimeMotionParams` → param SoA → `slime.update` | gameplay writes bytes each frame |
| the player's own mouse drag | pointer → `ThreeSlimeSurfaceDrag` → solver, in-render | render world, never leaves it |
| an external grab (bite today, snags/grabbers later) | `SoftBodyDeformationComponent` → snapshot `slimeDrag` → `SlimeDragParams` → `applyReplicated` | server owns the numbers |

The local mouse drag is deliberately *not* a Component. Pointer, camera and shell all live on the render side, so routing it through gameplay would be a boundary crossing that buys nothing. It reaches the network only because the owner uplinks it (`readSlimeSurfaceDrag` → `player:slime-drag`).

## Adding a new way to deform a slime

Decide first which of the two kinds you have.

**A force that follows a world anchor** — a bite, a barbed spike in the ground, a grabber arm. Do not invent a channel. Reuse `SoftBodyDeformationComponent`:

1. Put `softBodyDeformation` on the deformable archetype (it carries `breakDistance`).
2. Give the source its own small Component holding *its* relation and tunables (`BiteComponent` is the model: `range`, `facingDot`, `targetActorId`).
3. Grab once, with a contact point in the victim's local space — `resolveSurfaceContact` in `shared/softBodyDeformation.mjs` turns a world anchor into one. The contact is fixed at grab time so the grabbed patch of skin turns with the victim.
4. Each tick, in a focused server System, convert the anchor to victim-local (`actorWorldToLocal`) and call `pullToward`. A `false` return means the break distance was exceeded — release both sides. `SoftBodyBiteSystem` is under forty lines; a snag system should be shorter.
5. Nothing else. The snapshot field, interpolation, param SoA, replay and rebound are already wired.

**A force that is a property of motion** — a new squash on landing, a lean while sprinting. That is a `SlimeMotionParams` field plus solver code, not a Component: add the param in `RenderVisualParams.ts`, write it from the entity, consume it in the solver's rest-shape rebuild.

## Preserve invariants

- **One owner per shell.** `SoftBodyDeformationComponent` holds exactly one source at a time. An external grab outranks the shell owner's own mouse drag, and `applySelfReported` refuses while one is held. On the render side the mirror rule is that `applyReplicated` is ignored while a local drag is active.
- **`revision` is the grab identity**, shared by every source on that shell. It changes only when a *new* grab starts. Re-calling `beginSurfaceDrag` every frame resets the start positions to the already-deformed shell, so stretch never accumulates — that bug type-checks and passes a screenshot.
- **`revision = 0` means no deformation**, because the param SoA's rule is that a slot nobody drives is written 0 every frame. Server grab counters therefore start at 1.
- **The self-reported source must expire.** A client that drops mid-drag must not leave a stretched blob in the snapshot forever.
- **Only the pull interpolates.** Contact point and revision are discrete; averaging two contact points yields a spot nobody ever grabbed.
- **Every live slot is written every frame**, including the local player's rest values. A recycled proxy slot otherwise inherits the previous player's pull.
- **Never trust a client for another player's shape.** The mouse drag is self-reported and sanitized; anything a *second* actor does to you is derived server-side from both authoritative poses, so every client agrees and nobody can fabricate it.
- Deformation forces stay within a radius-scaled bound, so the shape budget never grows with world scale.

## Uplink budget

The self-reported drag is throttled to `SLIME_DRAG_SEND_INTERVAL_SECONDS` (the snapshot rate), not the input rate: the server only forwards it once per snapshot, and it shares the input token bucket with movement. Sending it faster silently starves the inputs that actually get replayed.

## Route adjacent work

- `skyland-render-boundary` for which channel a new value rides and where a visual System may live. It owns everything after the Replica exists.
- `skyland-actor-component` for the archetype → schema → catalog → snapshot chain a new source Component must go through.
- `skyland-input-system` when a new deformation has a player action behind it.

## Verify

1. Server tests for a new source: grab refused when out of range/blocked, pull tracking both poses, auto-release at the break distance, cleanup when either side leaves.
2. A render test that drives the real path — write params, `submitTransforms`, `updateVisuals` — not the solver directly. Applying the *same* revision for many frames must keep accumulating stretch.
3. `tests/RenderSceneBoundary.test.ts`, always: a Component that quietly imported the solver fails there and nowhere else.
4. `npm test` and `npx tsc --noEmit`.
