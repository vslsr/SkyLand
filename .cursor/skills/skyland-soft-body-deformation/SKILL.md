---
name: skyland-soft-body-deformation
description: Work on SkyLand's soft-body slime deformation — the hybrid core+skin solver, what drives it (movement, jumps, collisions, mouse drag, bites, future snags), how a deformation force is authored, replicated and replayed, and the SoftBodyDeformationComponent that owns one grabbed patch of skin. Use when adding or tuning a way to squash, stretch, dent or pull a slime, when a deformation looks wrong on remote players, or when touching HybridSlimeSimulation, the slime drag params, or the bite interaction. For the render boundary itself use skyland-render-boundary; for Actor state and snapshots use skyland-actor-component.
---

# SkyLand Soft-Body Deformation

A slime's shape is a client-side solver: a spring-driven core plus a per-vertex skin. Nothing about that shape is authoritative — gameplay never reads it, and the server never simulates it. What crosses the network is **where the skin was grabbed and how far it is being pulled**.

Being *held*, on the other hand, is gameplay. A hold has two separable halves, and keeping them separate is the point:

- **the deformation** — cosmetic, solved on each client, may never move an Actor or change collision;
- **the leash** — a restoring force in the shared character step that limits how far the held Actor can get, and carries them along when the holder moves. It is authoritative and predicted like any other movement.

A source can have either half or both. The player's own mouse drag has only the first.

## The two halves

**The solver** lives in `src/slime/hybrid/HybridSlimeSimulation.ts`, entirely inside the render world (`ThreeHybridSlimeVisual`). It owns the rest shape, the springs, volume flow, sleeping, and every hard clamp. It is the only place that may decide what a force *looks* like.

**The forces** come from two directions:

| Driver | Path | Owner |
| --- | --- | --- |
| movement, jumps, environment collisions | `SlimeMotionParams` → param SoA → `slime.update` | gameplay writes bytes each frame |
| the player's own mouse drag | pointer → `ThreeSlimeSurfaceDrag` → solver, in-render | render world, never leaves it |
| an external grab (bite today, snags/grabbers later) | `SoftBodyDeformationComponent` → snapshot `slimeDrag` → `SlimeDragParams` → `applyReplicated` | server owns the numbers |
| the leash of an external grab | `SoftBodyDeformationComponent` → snapshot `leash` → `params.leash` → `stepCharacter` | shared fixed step, both sides |

The local mouse drag is deliberately *not* a Component. Pointer, camera and shell all live on the render side, so routing it through gameplay would be a boundary crossing that buys nothing. It reaches the network only because the owner uplinks it (`readSlimeSurfaceDrag` → `player:slime-drag`).

## Adding a new way to deform a slime

Decide first which of the two kinds you have.

**A force that follows a world anchor** — a bite, a barbed spike in the ground, a grabber arm. Do not invent a channel. Reuse `SoftBodyDeformationComponent`:

1. Put `softBodyDeformation` on the deformable archetype (it carries `breakDistance`).
2. Give the source its own small Component holding *its* relation and tunables (`BiteComponent` is the model: `range`, `facingDot`, `targetActorId`).
3. Grab once, with a contact point in the victim's *shell* space — `resolveSurfaceContact` in `shared/softBodyDeformation.mjs` turns a world anchor into one, and writes the patch's outward normal alongside it. The contact is fixed at grab time; the shell does not turn with the Actor, so that patch stays on the side of the world it was grabbed from. Pass the source's `pinch`, its `gripDepth`, its `grabDistance`, and its leash parameters.
4. Each tick, in a focused server System, call `pullToward(sourceId, victimPose, sourcePosition, sourceVelocity, gripWorld)`. Leave `gripWorld` off when the source *is* the grip — a spike in the ground holds the skin where it stands; a mouth does not, which is why `SoftBodyBiteSystem` passes one. A `false` return means the break distance was exceeded — release both sides. That system is under fifty lines; a snag system should be shorter.
5. Nothing else. The snapshot fields, interpolation, param SoA, replay, leash and rebound are already wired.

### Four things that are easy to get wrong

**Contact, normal and pull are *shell* coordinates, not Actor-local ones.** `worldToShellOffset` subtracts the victim's origin and stops there — no yaw. The shell does not turn with its Actor: `ThreeHybridSlimeVisual` counter-rotates the rig by `-yaw` so a turn does not fling the soft body around like a rigid body, which leaves the solver's vertices on world axes. Rotate by yaw on the way in and the whole deformation is off by that yaw — for two slimes facing each other that is 180°, and the spike comes out of the victim's *back*. Both sides are three f32; nothing but the picture will tell you.

**The grabbed patch of skin sits on the grip point.** `pullToward` takes the source's world position (that is the leash anchor) and, when the thing that actually holds the skin is somewhere else, the grip point as well — for a bite, the mouth. The pull is `grip − where that patch is now`, so a bite is visible the moment it lands. Deriving the length from how much further apart the two have drifted since the grab instead means standing still shows nothing at all, and the tip never reaches the teeth.

**A grip may never press inward.** The delta from the patch to the grip *does* point into the body at close range: a mouth sits 0.42m in front of its owner, and the shell (0.95m) is nearly twice the character collider (0.52m), so two slimes standing together already interpenetrate. Whenever the delta's component along the stored contact normal falls under `gripDepth`, lift it back to `gripDepth` along that normal. That is both the guard against denting the shell into a round lump and the reason a point-blank bite still shows a spike — teeth pinch up a fold of skin; the depth is a property of the teeth, not of the gap.

**A bite is not a drag.** `pinch` (0..1) is a property of the grab, not of the archetype: 0 keeps the wide influence radius and whole-body follow that makes a mouse drag feel like moving a blob of putty; 1 narrows the influence radius, swaps the weight profile for a pointed one and switches the body follow off entirely, so teeth pull a point. Two failure modes bracket the tuning. Narrow the influence radius too far — under the ~0.2m vertex spacing — and only the contact vertex moves: a one-vertex needle with a crease under it, not a cone. And smoothstep is flat at its peak, so raising it to a power gives a mushroom head; the pointed profile `(1 - d/R)^k` is what makes the apex converge.

**A force that is a property of motion** — a new squash on landing, a lean while sprinting. That is a `SlimeMotionParams` field plus solver code, not a Component: add the param in `RenderVisualParams.ts`, write it from the entity, consume it in the solver's rest-shape rebuild.

## Preserve invariants

- **One owner per shell.** `SoftBodyDeformationComponent` holds exactly one source at a time. An external grab outranks the shell owner's own mouse drag, and `applySelfReported` refuses while one is held. On the render side the mirror rule is that `applyReplicated` is ignored while a local drag is active.
- **`revision` is the grab identity**, shared by every source on that shell. It changes only when a *new* grab starts. Re-calling `beginSurfaceDrag` every frame resets the start positions to the already-deformed shell, so stretch never accumulates — that bug type-checks and passes a screenshot.
- **`revision = 0` means no deformation**, because the param SoA's rule is that a slot nobody drives is written 0 every frame. Server grab counters therefore start at 1.
- **The self-reported source must expire.** A client that drops mid-drag must not leave a stretched blob in the snapshot forever.
- **Only the pull interpolates.** Contact point and revision are discrete; averaging two contact points yields a spot nobody ever grabbed.
- **The pinch grip is a position constraint, not a force.** Force balance caps the spike at half its target no matter how far the teeth move: the drag spring is `pullForce` 120 against `skinStiffness + neighborStiffness` ≈ 80. Teeth are not a spring, so `constrainSurfaceDrag` presses the gripped vertices onto their targets by `pinch * weight` and damps what is left of their velocity. The cone's shape is then the weight profile itself, which is what makes it tunable at all.
- **Every live slot is written every frame**, including the local player's rest values. A recycled proxy slot otherwise inherits the previous player's pull.
- **Never trust a client for another player's shape.** The mouse drag is self-reported and sanitized; anything a *second* actor does to you is derived server-side from both authoritative poses, so every client agrees and nobody can fabricate it.
- Deformation forces stay within a radius-scaled bound, so the shape budget never grows with world scale.
- **The leash lives in `stepCharacter`, never on the server alone.** Client prediction runs that same fixed step; a force applied only on the authority makes the client walk out and get yanked back by every snapshot, which is a permanent rubber band. The anchor the client has is one interpolation delay old — that residue is what reconciliation is for.
- **A leash needs damping.** A pure spring against a constant drive acceleration is a limit cycle: the player gets flung back, the rope goes slack, they charge out again. The radial damping term is what makes them settle *at* the rope instead of oscillating across it. Keep `stiffness * fixedStep < 2` (the catalog caps it) or the spring self-excites.
- **Towing is velocity, restraint is force.** The spring alone already beats a held player's own movement — their drive is a bounded acceleration and the spring is not — but a spring that has to *win an argument* settles at whatever distance the struggle stretches it to. The `carry` term instead blends the held velocity toward the holder's, so the hold tows rather than negotiates. A static source (a spike) simply reports zero anchor velocity and gets restraint without towing, from the same code.
- Tune the leash so its steady-state stretch stays inside the solver's `maximumDistance`. Past that the visual is clamped and every hold looks identical, no matter how hard the victim pulls.
- **Prime the anchor at grab time.** The anchor is written by the per-tick update, so a grab that does not immediately run one leaves a snapshot window whose leash points at the world origin — and yanks the victim there.

## Uplink budget

The self-reported drag is throttled to `SLIME_DRAG_SEND_INTERVAL_SECONDS` (the snapshot rate), not the input rate: the server only forwards it once per snapshot, and it shares the input token bucket with movement. Sending it faster silently starves the inputs that actually get replayed.

## Route adjacent work

- `skyland-render-boundary` for which channel a new value rides and where a visual System may live. It owns everything after the Replica exists.
- `skyland-actor-component` for the archetype → schema → catalog → snapshot chain a new source Component must go through.
- `skyland-input-system` when a new deformation has a player action behind it.

## Verify

1. Server tests for a new source: grab refused when out of range/blocked, pull tracking both poses, **the pull pointing outward** (dot it with the contact normal — an inward pull is the classic direction bug), **the contact on the side the source is actually on** (a sign check on the axis between them: it is the only cheap sentinel for the shell-frame mistake), **the tip landing on the grip point** (contact + pull ≈ grip), auto-release at the break distance, cleanup when either side leaves.
2. A leash test that measures reach: free run vs. held run, then a second held run showing the reach has stopped growing. Settling, not oscillating, is the property that matters. For towing, have the victim struggle in the opposite direction and assert they still cover most of the holder's distance.
   Two things will waste an afternoon if you don't know them: a player who is sent **no** input is not stepped at all, so a test that models "not resisting" by sending nothing measures a frozen player, not a passive one — send a zero-move input. And the test scene's origin is inside scenery: place fixtures on open ground and sync both the Actor transform and the character body, or the KCC stays at spawn while your math runs somewhere else.
3. A render test that drives the real path — write params, `submitTransforms`, `updateVisuals` — not the solver directly. Applying the *same* revision for many frames must keep accumulating stretch. For a pinched grab, assert the tip reaches the full pull *and* that several vertices follow it: one vertex alone is a needle, a flat profile is a lump, and only the two together are a cone.
4. `tests/RenderSceneBoundary.test.ts`, always: a Component that quietly imported the solver fails there and nowhere else.
5. `npm test` and `npx tsc --noEmit`.
