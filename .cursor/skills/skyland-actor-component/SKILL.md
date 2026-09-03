---
name: skyland-actor-component
description: Extend or debug SkyLand's reusable Actor + Component pipeline across JSON archetypes, authoritative room simulation, Actor nesting/attachments, snapshots, client Replicas, interactions, and visual-only effects. Use when adding Actor state, Components, Systems, replicated gameplay objects, parent-child transforms, ownership, cargo, damage, hazards, or Actor interpolation. For scene-only placement use skyland-scene-authoring; for physical input mappings use skyland-input-system; do not use for unrelated standalone Three.js models.
---

# SkyLand Actor Component

Build scene objects as data-driven Actors whose gameplay state is owned by the room DS and whose client representation is created from snapshots. Keep visual animation below the replicated root so presentation never becomes authority.

## Read before editing

1. Read [references/actor-component-contract.md](references/actor-component-contract.md) completely. It records the end-to-end contract and the verified interaction workflow.
2. Inspect the closest existing archetype under `config/actors/` and its matching shared Component under `shared/actor/components/`.
3. Trace the affected path before editing:
   - schema and sanitization: `config/actors/actor.schema.json`, `server/actors/ActorCatalog.mjs`;
   - DS construction and simulation: `server/actors/ServerActorFactory.mjs`, the relevant server System, `server/scene/ServerScene.mjs`;
   - transport: `src/network/messages.ts`, `RoomConnectionHub`, `RoomProcessManager`, and `room-worker`;
   - Replica and presentation: `src/network/protocol.ts`, `src/scenes/data/SceneDefinition.ts`, `src/actors/ClientActorSystem.ts`, and the relevant render-world visual System. Presentation now sits on the far side of a byte boundary — read `skyland-render-boundary` before touching it.

## Choose the owning layer first

- Put persistent gameplay state and validation on the server. Clients send intent, not final positions, damage, attachment state, or buoyancy results.
- Put deterministic per-tick gameplay behavior in a focused server System that queries the Components it needs.
- Put reusable state transitions in mutation helpers when interaction handlers and Systems must perform the same change.
- Replicate only the compact public state required by clients. Keep cooldown maps, dirty flags, cached calculations, and other DS internals private.
- Put shader waves, bobbing, deformation, selection outlines, and smoothing in **render-world** visual Systems. They read the visual-param SoA and apply to the proxy's `visualRoot`; the replicated Actor root stays on the authoritative Transform.
- **An Actor Component may not hold a `THREE.Object3D`, and may not import `three`.** It holds a `ProxyId` and writes bytes. `tests/RenderSceneBoundary.test.ts` enforces this; see `skyland-render-boundary` for which channel a new value belongs in.
- Store hierarchy as server-owned `parentActorId + localTransform`. Run `AttachmentSystem` after parent movement to rebuild child world Transforms in parent-first topology order.

## Extend the complete chain

Do not stop after adding a Component class. For every new replicated capability, update the applicable parts of this chain together:

`actor JSON -> Actor Schema -> ActorCatalog -> shared Component -> ServerActorFactory -> server System/interaction -> snapshot -> client protocol/types -> ClientActorSystem -> render boundary channel -> render-world visual System -> HUD or feedback`

The client half of that chain crosses a boundary. Which channel depends on the data's shape — a spawn-time fact rides `MeshProxyDesc`, a per-frame scalar rides the param SoA, a variable-length or occasional change rides a command, high-count batched content rides an instance channel. `skyland-render-boundary` owns that choice; getting it wrong is cheap to write and expensive to undo.

If the feature has a player action, continue through:

`input tag -> gameplay controller -> RoomClient message -> RoomConnectionHub -> RoomProcessManager -> room-worker -> ServerScene validation -> Component mutation`

Use a semantic message such as `actor:interact` when an action changes relationships between multiple Actors. Apply all related Component changes atomically on the DS, then let the resulting snapshot acknowledge the action.

## Preserve invariants

- Scene JSON places Actor instances; archetype JSON owns reusable Component parameters.
- `ActorWorld` owns lifecycle. Systems discover behavior through Component composition rather than archetype-id conditionals.
- Control ownership is exclusive and released when its player leaves.
- Interaction distance is checked against an authoritative gameplay Actor, not a free camera position.
- Snapshot interpolation affects continuous motion. Ownership, carrier ids, enabled flags, damage events, and other discrete state come from a received snapshot without local prediction.
- Parent changes and `localTransform` are discrete snapshot state. Interpolate only the server-resolved world Transform; never let client hierarchy resolution overwrite it.
- Reject missing parents, self-parenting and cycles. By default, deleting a parent detaches its children while preserving their world Transform; use explicit cascade deletion only when the feature owns the whole subtree.
- A child proxy is parented only under the parent's authoritative root, never its `visualRoot`. Parenting crosses the boundary as `parentSlot` in the transform SoA; inherited bob/tilt is composed inside the render world, under the child's presentation-only attachment root.
- A carried object has one authoritative carrier relation and one matching load entry. Loading/unloading updates both or neither.
- Server wave simulation is not required for visual water. Gameplay buoyancy remains low-frequency/analytic; client bobbing never writes back to the DS Transform.

## Route adjacent work

- Use `skyland-scene-authoring` when only placing supported archetypes or changing scene renderer/gameplay/camera data.
- Use `skyland-input-system` when changing key, touch, Gamepad, trigger, rebinding, or prompt semantics. Actor controllers consume tags and must not listen to DOM events directly.
- Use `skyland-collision-partition` for player movement physics, Actor/simple-collision shapes or layers, Rapier registration, grounding, camera probes, and client/server collision parity. This skill still owns the Actor Component and snapshot state that supplies that authoring, but not the character solver.
- Use `skyland-render-boundary` for how a Replica becomes pixels: proxies, the transform and visual-param SoA, instance channels, and where a visual System is allowed to live. This skill owns state and authority up to the point the Replica exists; that one owns everything after.
- Follow `.cursor/rules/line-art-reference.mdc` for Actor geometry and keep procedural models under `src/models/`.

## Verify

Add focused tests at the lowest useful layer, then prove the chain:

1. Catalog tests reject malformed Component definitions and preserve valid archetypes.
2. Server tests cover authority, replay/sequence rejection, distance, atomic relationship changes, cooldowns, and snapshots.
3. Client tests cover heterogeneous Replica creation, snapshot application/removal, discrete reparenting, world-Transform interpolation, picking, feedback state, and `visualRoot`-only motion. Run `tests/RenderSceneBoundary.test.ts` too — a Component that quietly picked up a render import fails there and nowhere else.
4. Transport tests cover channel selection and routing for every new message.
5. For a complete interaction, add or run a real WebSocket test through the room child process.
6. Run `npm test`, `npm run build`, JSON parsing for edited configs, and `git diff --check`.

Do not claim completion from a model screenshot or a direct `ServerScene` call alone; the verified outcome is a server-approved state change returning through a snapshot and becoming visible on the client.
