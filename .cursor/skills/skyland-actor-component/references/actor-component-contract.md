# SkyLand Actor/Component contract

Use this reference when adding a new Actor capability or diagnosing a break between scene data, room authority, replication, and client presentation.

## Runtime topology

```text
config/scenes/*.scene.json
  places { id, archetype, parentActorId?, localTransform }
          |
config/actors/*.actor.json + actor.schema.json
  defines reusable Component parameters
          |
SceneCatalog + ActorCatalog
  validate, sanitize, and send only used archetypes to the room
          |
room-worker -> ServerScene -> ActorWorld
  builds authoritative Components; movement Systems update parents
          |
AttachmentSystem
  resolves child world Transforms in parent-first topology order
          |
createActorSnapshots -> room:snapshot
  publishes compact public state
          |
ActorSnapshotBuffer -> ClientActorSystem
  creates heterogeneous Replicas and applies snapshots
          |
  Actor holds a ProxyId, not an Object3D
  Systems write world Transform + visual params into a shared byte segment
          |
======== Game World / Render World boundary ========
          |
ThreeMeshProxy (resolved from ProxyId)
  root (authoritative Transform, from the SoA)
  `- attachmentVisualRoot (inherited presentation only)
      `- visualRoot (waves, bobbing, tilt, outline, local animation)
```

The last three lines live **inside the render world**. A gameplay System reaches
none of them; it writes bytes and the render world applies them. See
`skyland-render-boundary`.

## Component responsibilities

The current implementation demonstrates these roles:

| Component | Authority and purpose |
| --- | --- |
| `TransformComponent` | Authoritative local and world position/yaw on the DS; the resolved world value is interpolated into the client Actor root. |
| `BuoyancyComponent` | Vessel mass, buoyancy parts, dynamic loads, damage and derived float state; dirty recalculation avoids unnecessary CPU work. |
| `VesselMotorComponent` | Throttle/steering intent and authoritative speed integration. |
| `ActorControlComponent` | Exclusive player owner, input/event sequences, timeout timestamps and revision. |
| `PlayerMovementComponent` | Authoritative walk speed, sprint multiplier and maximum step height for dynamically spawned player Actors. |
| `InteractableComponent` | Semantic action, label, enabled state and maximum DS interaction distance. |
| `CargoComponent` | Cargo mass, carrier Actor id and carrier-local mount offset. |
| `HazardComponent` | DS collision radius, damage/cooldown configuration and private per-vessel cooldown state. |
| `TemperatureComponent` | Current/ambient temperature, heat capacity and cooling rate; server-owned and compactly replicated. |
| `CombustibleComponent` | Ignition/extinguish thresholds, fuel, burn rate and the heat emitted while burning. |
| `HeatEmitterComponent` | Stable server heat source such as a campfire; nearby queries are spatially bucketed. |
| `ReplicationComponent` | Client-only applied snapshot revision. |
| `ThreeObjectComponent` | Client-only authority root, inherited presentation root, model visual root ownership and subtree-safe disposal. |
| `TemperatureMarkerComponent` | Client-only F8 world label; reuses one CanvasTexture per loaded temperature Actor and reads replicated temperature only. |

Player Actors are selected by `gameplay.playerActor`, then created once per connection rather than placed
in the scene's fixed `actors[]`. The DS stores them in `ActorWorld`; their high-frequency transform remains
in the dedicated `players` snapshot so local prediction/reconciliation does not create a duplicate Replica.

Create a new Component when the state is reusable and behavior can be selected by composition. Do not add an archetype switch to a global update loop when a System can query the required Component set.

## Actor hierarchy contract

- Scene placement and snapshots name the relationship `parentActorId`; `localTransform` is relative to that parent. For a root Actor, local and world Transform are equal.
- Create every Actor before assigning parents so JSON and snapshots are independent of declaration order. Both `SceneCatalog` and `ActorWorld.setActorParent` reject a missing parent, self-parenting and cycles.
- Gameplay movement runs first on the DS. `AttachmentSystem` then traverses roots to descendants and calculates each child world Transform from its parent's resolved world Transform plus its own local Transform.
- Reparenting with `worldPositionStays: true` recomputes local Transform from the current world pose. Use `false` when loading authored local placement or snapping to a mount.
- `parentActorId` and `localTransform` switch discretely. The client interpolates the already-resolved world Transform only and does not run the authority `AttachmentSystem`.
- Three.js may mirror Actor nesting by parenting a child root under the parent's authority root. Derive its render-local pose from the interpolated parent and child world poses; using replicated local Transform directly would overwrite world interpolation.
- Never parent an Actor root under a parent's `visualRoot`. `AttachmentVisualSystem` composes inherited bob/tilt into `attachmentVisualRoot`, leaving the authority root and interaction coordinates unchanged.
- `ActorWorld.removeActor(id)` defaults to `childPolicy: 'detach'` and preserves every direct child's world Transform. Use `removeActorTree(id)` or `{ childPolicy: 'cascade' }` only for an explicitly owned subtree; cascade disposes children before parents.

## Adding a Component

1. Define authorable fields in `config/actors/actor.schema.json`, including conditional requirements for render/model combinations when needed.
2. Sanitize every field in `ActorCatalog`; reject unknown Component keys so misspellings cannot silently change gameplay.
3. Add the Component class and stable type constant under `shared/actor/components/`, then export it from `shared/actor/index.mjs`.
4. Instantiate it conditionally in `ServerActorFactory`. Do the same in `ClientActorSystem` only when the Replica needs that state.
5. Add a focused server or client System. Register order explicitly when one System consumes another System's result—for example motor movement before cargo attachment and hazard checks.
6. Add only public fields to `createActorSnapshots`; mirror them in `src/network/protocol.ts` and apply them in `ClientActorSystem`.
7. Extend `ActorRenderDefinition` and `createActorVisualModel` only if the Component introduces a new visible model.
8. Update catalog, server, client, transport, and build tests before considering the Component reusable.

## Authoritative interaction pattern

The verified cargo/reef loop is the reference pattern:

```text
F input tag -> vessel control request -> DS exclusive owner -> control snapshot
camera ray -> E input tag -> actor:interact intent
  -> hub rate limit -> manager IPC -> room-worker
  -> ServerScene validates player, sequence, target, owner and distance
  -> cargo relation + buoyancy load mutate atomically
  -> attachment System updates cargo Transform after vessel movement
  -> Actor snapshot returns carrier/load/event state
  -> client Replica, highlight and HUD update

vessel Transform enters hazard radius
  -> DS hazard System applies cooldown and damage
  -> buoyancy is marked dirty and recalculated
  -> damage event/float state returns in snapshot
```

The free camera is presentation only, so it cannot be used as the authoritative distance origin. Use the player-owned gameplay Actor. A client-side distance check may improve feedback, but the DS check remains mandatory.

When one action changes multiple Components, use one handler or shared mutation helper and return success only after every invariant can be maintained. For cargo, `carrierActorId` and the vessel load entry are a pair; direct changes to only one side create desynchronized snapshots.

## Replication and visual rules

- Use the Actor snapshot buffer for Transform and other continuous values. Stop at the newest snapshot rather than extrapolating an authoritative vessel indefinitely.
- Treat ownership, carrier relation, interaction enabled state and event ids as discrete snapshot data; do not blend identifiers or invent intermediate states.
- Treat `parentActorId` and `localTransform` as discrete data too. Blend the final world Transform, then derive the Three.js local pose from parent/child world poses.
- The replicated root receives Transform. Proxies expose a child `visualRoot` for shader waves, water bob, damage shake, selection effects and other presentation. Both roots are render-world objects; gameplay drives them through the transform and visual-param SoA.
- A free floating object may sample the same deterministic client wave function as the water surface. A carried object should inherit its carrier's visual bob/tilt while its DS root continues to follow the authoritative carrier mount.
- Selection outlines and helpers are client resources: dispose their geometry/material when the target changes, its Actor disappears, or the scene is destroyed.
- Fire geometry is transient presentation under `visualRoot`, built and animated entirely in the render world. The DS replicates thermal state; gameplay forwards it as a visual param (`PARAM_FIRE_TARGET_INTENSITY`), and visual particles never feed back into temperature authority.
- Temperature debug labels are client-only world UI attached to the Actor authority root. Keep them hidden by default, face them toward the active camera only while enabled, and bound their resources to loaded temperature Actors rather than world area.

## Network channel rules

- Control ownership, interaction, inventory relationship changes and other must-arrive commands use the reliable `control` channel.
- High-frequency vessel/player intent uses `realtime`; the current WebSocket transport may carry both, but gameplay code still declares the intended channel for a future split transport.
- Add a typed client message, hub route, manager method, worker case and `ServerScene` handler together.
- Rate-limit player-generated gameplay messages and validate ids, finite values, ranges, owner, monotonic sequence and current world state on the DS.
- Use the authoritative snapshot as the normal success acknowledgement. If rejection must be actionable to the player, add an explicit reliable result instead of assuming a missing snapshot is understandable feedback.

## Failure signatures

| Symptom | Likely break |
| --- | --- |
| Actor exists in JSON but never appears | Archetype was not sanitized into `actorArchetypes`, snapshot target was absent, or the client model factory lacks the render variant. |
| Model moves but server state does not | Motion was applied to the client root or visual model instead of a DS System. |
| Waves make interaction positions drift | Visual animation was written to the replicated root instead of `visualRoot`. |
| A visual effect trails motion by one frame | Its param was written after `RenderTransformSyncSystem` published the bank. |
| `RenderSceneBoundary` test fails | A Component or ActorWorld System picked up a render import, or a new System was not registered in the ratchet list. |
| Child snaps or double-moves between snapshots | The client interpolated/re-resolved `localTransform` instead of interpolating the server-resolved world Transform. |
| Child bob changes its gameplay position | Its root was attached under the parent's `visualRoot`; inherited presentation belongs in `attachmentVisualRoot`. |
| Deleting a parent destroys an unrelated child | Callers used cascade deletion where detach-and-keep-world was intended, or parent disposal traversed into another Actor root. |
| Control/interaction input appears dead | Check tag trigger, controller candidate, transport state, hub route, room IPC, DS owner validation, then the returning control snapshot in that order. |
| Cargo is visually attached but load stays zero | Carrier relation and buoyancy load were not mutated as one server operation. |
| Damage happens every tick | Cooldown is missing or stored on the client instead of the hazard Component on the DS. |
| Old highlight remains after an Actor disappears | Replica removal did not clear/dispose the selection helper. |
| Unit tests pass but gameplay still fails | Add a WebSocket test that includes the gateway and independent room process; direct handler tests do not cover routing/IPC. |

## Completion checklist

- The scene and archetype JSON parse and pass both catalogs.
- The room's first snapshot contains the Actor and its initial public Component state.
- Unauthorized, out-of-range, malformed and replayed intent is rejected.
- The successful state change survives a room tick and is visible in a later snapshot.
- The client creates/removes the Replica solely from snapshots.
- Missing/self/cyclic parents are rejected, and both detach and cascade deletion policies have focused tests.
- Parent changes are discrete while the final child world Transform remains smoothly interpolated.
- Visual animation affects only `visualRoot`, and is driven across the boundary rather than by reaching into the proxy.
- HUD/interaction feedback reads replicated state rather than optimistic local truth.
- Server, client, transport and real WebSocket tests pass, followed by the production build.
