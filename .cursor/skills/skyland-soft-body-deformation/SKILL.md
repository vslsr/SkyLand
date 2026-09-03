---
name: skyland-soft-body-deformation
description: Work on SkyLand's soft-body slime deformation — the hybrid core+skin solver, what drives it (movement, jumps, collisions, mouse drag, bites, future snags), how a deformation force is authored, replicated and replayed, and the SoftBodyDeformationComponent that owns one grabbed patch of skin. Use when adding or tuning a way to squash, stretch, dent or pull a slime, when a deformation looks wrong on remote players, or when touching HybridSlimeSimulation, the slime drag params, or the bite interaction. For the render boundary itself use skyland-render-boundary; for Actor state and snapshots use skyland-actor-component.
---

# SkyLand Soft-Body Deformation

A slime's shape is a client-side solver: a spring-driven core plus a per-vertex skin. Nothing about that shape is authoritative — gameplay never reads it, and the server never simulates it. Only one deformation crosses the network at all: the owner's own mouse drag, because nobody else can know where their pointer is. Everything a *second* actor does to a shell — a bite today, snags and grabbers later — crosses as the **relation** (`bitingPlayerId`) and is re-derived on every client from poses that are already replicated.

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
| an external grab (bite today, snags/grabbers later) | snapshot `bitingPlayerId` → `slimeBiteTip.ts` → `SlimeBiteParams` → solver rest shape | each client derives it from both poses |
| the leash of an external grab | `SoftBodyDeformationComponent` → snapshot `leash` → `params.leash` → `stepCharacter` | shared fixed step, both sides |

The local mouse drag is deliberately *not* a Component. Pointer, camera and shell all live on the render side, so routing it through gameplay would be a boundary crossing that buys nothing. It reaches the network only because the owner uplinks it (`readSlimeSurfaceDrag` → `player:slime-drag`).

## Adding a new way to deform a slime

Decide first which of the two kinds you have.

**A hold by another actor** — a bite, a barbed spike in the ground, a grabber arm. Two halves, and they live in different places:

1. **The relation and the leash are gameplay.** Put `softBodyDeformation` on the deformable archetype (it carries `breakDistance`) and give the source its own Component for *its* relation and tunables (`BiteComponent`: `range`, `facingDot`, `gripDepth`, `targetActorId`). `grab(sourceId, {grabDistance, leash…})` records who holds whom; each tick a focused server System calls `updateHold(sourceId, victimPose, sourcePosition, sourceVelocity)`, which refreshes the leash anchor and returns `false` once `breakDistance` is exceeded — release both sides then. `SoftBodyBiteSystem` is thirty lines and contains no geometry at all.
2. **The shape is a vector, and it is not replicated.** The snapshot already carries the relation, and both poses are already authoritative, so every client computes the same vector itself, from *this frame's interpolated* positions — no extra floats on the wire, and the tip stays glued to the mouth instead of lagging a snapshot behind. `resolveGripTip` in `shared/softBodyDeformation.mjs` is the whole formula: **direction = victim's body centre → the grip point** (for a bite, the mouth), **length = how far that point is past the shell**, floored at the source's `gripDepth`. `src/player/slimeBiteTip.ts` wires it to the snapshot; `PlayerEntity`/`RemotePlayer` write it into `PARAM_SLIME_BITE_*`; `HybridSlimeSimulation.setBiteTip` consumes it.

A new source of the second kind needs one thing on the client: a way to say where its grip point is. Nothing else on this list changes.

### Four things that are easy to get wrong

**A hold is a term in the rest shape, not a patch that gets moved.** The solver already builds its rest shape as a sum of terms driven by direction vectors — the movement teardrop, the airborne tail. A bite is one more: `weight = max(0, vertexDirection · axis)^k`, then stretch along the axis and narrow across it. Every vertex is a continuous function of its own direction, so the surface stays smooth by construction. The alternative — pick the nearest vertex, bake influence weights around it, translate that patch by a vector — tears on a 24×16 mesh: neighbouring vertices land at very different places, the influence-radius edge is a discontinuity, and the shell splits into flat shards with visible cracks. That is what the screenshots of the old implementation showed.

**The vector is centre → grip, and nothing is pinned.** Because the direction is recomputed from live positions every frame, a source that circles the victim or crosses over them just rotates it; there is no fixed contact point to re-anchor, no grab revision, no interpolation seam. Anchoring on a *patch* instead forces all of that machinery back, and it still points the wrong way the moment the grip crosses to the far side.

**Length needs a floor, not just geometry.** The shell (0.95m) is nearly twice the character collider (0.52m) and a mouth sits 0.42m in front of its owner, so at ordinary bite range the grip point is *inside* the victim's shell and the geometric protrusion is zero or negative. `gripDepth` is the fold of skin the teeth pull up regardless — a property of the teeth, not of the gap.

**Coordinates are shell space: the Actor's origin with world axes, no yaw.** `ThreeHybridSlimeVisual` counter-rotates the rig by `-yaw` so a turn doesn't fling the soft body around like a rigid body, which leaves the solver's vertices on world axes. Rotate anything by yaw on the way in and the whole deformation is off by that yaw — for two slimes facing each other that is 180°, and the tip comes out of the victim's *back*. Both sides are three f32; nothing but the picture will tell you.

**A force that is a property of motion** — a new squash on landing, a lean while sprinting. That is a `SlimeMotionParams` field plus solver code, not a Component: add the param in `RenderVisualParams.ts`, write it from the entity, consume it in the solver's rest-shape rebuild.

## Preserve invariants

- **One owner per shell.** `SoftBodyDeformationComponent` holds exactly one source at a time. An external grab outranks the shell owner's own mouse drag, and `applySelfReported` refuses while one is held. On the render side the mirror rule is that `applyReplicated` is ignored while a local drag is active.
- **`revision` is the grab identity** of the self-reported mouse drag. It changes only when a *new* grab starts. Re-calling `beginSurfaceDrag` every frame resets the start positions to the already-deformed shell, so stretch never accumulates — that bug type-checks and passes a screenshot.
- **`revision = 0` means no deformation**, because the param SoA's rule is that a slot nobody drives is written 0 every frame. Server grab counters therefore start at 1.
- **The self-reported source must expire.** A client that drops mid-drag must not leave a stretched blob in the snapshot forever.
- **Only the pull interpolates.** Contact point and revision are discrete; averaging two contact points yields a spot nobody ever grabbed.
- **The pinch grip is a position constraint, not a force.** Force balance caps the spike at half its target no matter how far the teeth move: the drag spring is `pullForce` 120 against `skinStiffness + neighborStiffness` ≈ 80. Teeth are not a spring, so `constrainSurfaceDrag` presses the gripped vertices onto their targets by `pinch * weight` and damps what is left of their velocity. The cone's shape is then the weight profile itself, which is what makes it tunable at all.
- **Every live slot is written every frame**, including the local player's rest values. A recycled proxy slot otherwise inherits the previous player's pull.
- **Never trust a client for another player's shape.** The mouse drag is self-reported and sanitized. Anything a *second* actor does to you is derived from the authoritative relation plus both authoritative poses — every client feeds the same formula the same inputs and gets the same shape, and nobody can fabricate it because nobody sends it.
- **A hold sends the relation, never the shape.** Six replicated floats would cost bandwidth *and* look worse: they would be a snapshot old, so the tip would trail the mouth it is supposed to be attached to. Derive on each client, from the frame's interpolated poses.
- Deformation forces stay within a radius-scaled bound, so the shape budget never grows with world scale.
- **The leash lives in `stepCharacter`, never on the server alone.** Client prediction runs that same fixed step; a force applied only on the authority makes the client walk out and get yanked back by every snapshot, which is a permanent rubber band. The anchor the client has is one interpolation delay old — that residue is what reconciliation is for.
- **A leash needs damping.** A pure spring against a constant drive acceleration is a limit cycle: the player gets flung back, the rope goes slack, they charge out again. The radial damping term is what makes them settle *at* the rope instead of oscillating across it. Keep `stiffness * fixedStep < 2` (the catalog caps it) or the spring self-excites.
- **Towing is velocity, restraint is force.** The spring alone already beats a held player's own movement — their drive is a bounded acceleration and the spring is not — but a spring that has to *win an argument* settles at whatever distance the struggle stretches it to. The `carry` term instead blends the held velocity toward the holder's, so the hold tows rather than negotiates. A static source (a spike) simply reports zero anchor velocity and gets restraint without towing, from the same code.
- Tune the leash so its steady-state stretch stays inside the solver's `maximumDistance`. Past that the visual is clamped and every hold looks identical, no matter how hard the victim pulls.
- **Prime the anchor at grab time.** The anchor is written by the per-tick update, so a grab that does not immediately run one leaves a snapshot window whose leash points at the world origin — and yanks the victim there.

## Uplink budget

The self-reported drag is throttled to `SLIME_DRAG_SEND_INTERVAL_SECONDS` (the snapshot rate), not the input rate: the server only forwards it once per snapshot, and it shares the input token bucket with movement. Sending it faster silently starves the inputs that actually get replayed.

## The wrong turns this feature already took

All of these shipped. Every one of them type-checked, passed `npm test`, and read fine in review — the failure mode is always that both sides hold three plausible f32, so only a picture disagrees.

| What was wrong | What it looked like |
| --- | --- |
| contact and pull computed in Actor-local space (yaw-rotated) while the solver's vertices are world-aligned | the spike came out of the victim's *back* — 180° off, because the two face each other |
| the pull's length was "how much further apart the two have drifted since the grab" | biting and standing still deformed nothing at all, and the tip never reached the teeth |
| `pinch` narrowed the influence radius to 0.30m, under the ~0.2m vertex spacing | a one-vertex needle with a crease under it, not a cone |
| the pinched weight was `smoothstep^k`, which is flat at its peak | a mushroom head instead of a converging apex |
| the pinch relied on force balance (`pullForce` 120 vs. skin ≈ 80) | the tip stalled at half its target however far the teeth moved |
| the contact stayed where it was grabbed while the source moved to the far side | after crossing over the target, the spike pointed away from the biter — the inward guard had nothing left to keep but the old normal |
| the whole hold was built on the mouse drag's channel: pick a vertex, bake weights, translate that patch | the shell tore into flat shards with cracks down the sides. Everything above is a symptom of the same wrong shape: a patch translation needs a contact point, a contact point needs re-anchoring, re-anchoring needs a revision, and none of it can be smooth on a 24×16 mesh |
| *(earlier)* the pull was `mouth − contact` with no guard | at bite range that vector points inside the body: the shell dented into a round lump |
| *(earlier)* `grab()` did not prime the leash anchor | one snapshot's leash pointed at the world origin and yanked the victim there |

Two of them are worth a second look, because of *how* they survived.

**A half-diagnosis got written down as a law.** The inward dent was real, and the fix — stop using `mouth − contact`, derive the direction from the two body positions instead — did remove it. It also quietly traded a wrong direction for a wrong length, and this file then recorded the replacement as an iron law ("the pull direction is source-position → not anchor-minus-contact"), so the next pass kept it and tuned around it. A rule that records the symptom instead of the geometry freezes the bug in place. Write down what the quantity *is* — the skin sits on the grip point, and never presses inward — rather than what it is not.

**The channel decided the shape.** A bite reached for the one deformation channel that already existed — the mouse drag's contact + pull — and every later problem followed from that choice rather than from the bite itself. Reuse is right when the *kind* matches: a drag grabs a point the pointer picked, a hold pulls whatever is nearest the teeth. Ask what the quantity is before asking which pipe is free.

**A sentence here contradicted the code and nothing checked it.** This file used to claim the grabbed patch "turns with the victim". It does not: `ThreeHybridSlimeVisual` counter-rotates the rig by `-yaw`. The frame bug lived directly under that sentence for two passes.

## Route adjacent work

- `skyland-render-boundary` for which channel a new value rides and where a visual System may live. It owns everything after the Replica exists.
- `skyland-actor-component` for the archetype → schema → catalog → snapshot chain a new source Component must go through.
- `skyland-input-system` when a new deformation has a player action behind it.

## Verify

1. Server tests for a new source cover the *relation* only: grab refused when out of range/blocked, no shape in the snapshot, the leash present and anchored on the holder, auto-release at the break distance, cleanup when either side leaves.
2. Client tests cover the vector: direction pointing at the grip, the `gripDepth` floor when the grip is inside the shell, length growing with separation. Sweep the source *through* and past the victim and all the way around them rather than testing one pose — every direction bug this feature has had lives at the poses where the grip crosses the shell, and a single face-off pose passes all of them.
3. A leash test that measures reach: free run vs. held run, then a second held run showing the reach has stopped growing. Settling, not oscillating, is the property that matters. For towing, have the victim struggle in the opposite direction and assert they still cover most of the holder's distance.
   Two things will waste an afternoon if you don't know them: a player who is sent **no** input is not stepped at all, so a test that models "not resisting" by sending nothing measures a frozen player, not a passive one — send a zero-move input. And the test scene's origin is inside scenery: place fixtures on open ground and sync both the Actor transform and the character body, or the KCC stays at spawn while your math runs somewhere else.
4. A render test that drives the real path — write params, `submitTransforms`, `updateVisuals` — not the solver directly. For a hold, assert the profile: bucket the vertices by `direction · axis` and require the displacement to fall off *monotonically* across several rings, with the far side barely moving. A single moving vertex is a needle, a flat profile is a lump, a non-monotonic one is the crack.
5. `tests/RenderSceneBoundary.test.ts`, always: a Component that quietly imported the solver fails there and nowhere else.
6. `npm test` and `npx tsc --noEmit`.
7. **Then look at it.** Nothing above catches a wrong frame or a needle — they are all plausible f32 in, plausible f32 out. Drive the whole chain once in a throwaway script: a `ServerScene` with two players, `toggleBite`, `createSnapshot`, then feed both transforms into a `ThreeRenderScene` and the bite vector into `setBiteTip`, step ~240 frames, project every surface triangle of both rigs through `rig.surface.matrixWorld` into one SVG, and mark the source's grip point. Give each triangle a consistent 2D winding or the nonzero fill rule cancels the far hemisphere against the near one and the page comes out blank. Headless Chromium renders the SVG to a PNG. The first rows of the table above are unmistakable in that picture and invisible in every other check.
