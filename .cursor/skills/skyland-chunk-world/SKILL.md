---
name: skyland-chunk-world
description: Work on the SkyLand streaming chunk world — deterministic world generation from a seed, the paired JavaScript and Rust/WASM generation backends, vertex batching, ChunkStreamer loading policy, and streaming-scene configuration under renderer.world. Use when adding or tuning a streaming map, changing what chunks contain, adding a prop kind, touching native/chunkgen, or debugging a world that differs between client and server. Do not use for fixed-size scene authoring (see skyland-scene-authoring) or unrelated Three.js model work.
---

# SkyLand Chunk World

The streaming world is not data. It is the output of a pure function of `(worldSeed, chunkX, chunkZ)`, evaluated independently on every machine. Nothing static is ever sent over the network. Every rule below exists to protect that property.

## The one rule that matters

The placement algorithm has **two implementations that must produce bit-identical output**:

- `shared/world/chunkContent.mjs` — the JavaScript reference
- `native/chunkgen/src/placement.rs` — the Rust/WASM implementation

Change one and you must change the other, rebuild the WASM, and commit the rebuilt binary. If they diverge, one player sees a tree where another sees open ground, and the "never sync static content" premise silently collapses.

`server/tests/chunkGenerator.test.mjs` is the safety net: it loads the checked-in `shared/world/wasm/chunkgen.wasm` and asserts every placement record matches the JavaScript reference across 81 chunks. A one-sided edit — or a forgotten `npm run build:wasm` — fails that test.

## Read before editing

1. Read [references/chunk-world.md](references/chunk-world.md) completely. It maps every module, lists the constants that must stay paired across the two implementations, and documents the WASM ABI.
2. Read `shared/world/worldConfig.mjs`. World size, chunk size, the prop grid and the play-area margin all live there and apply to every streaming scene.
3. For scene-level work, also read `config/scenes/open-world.scene.json` and the `renderer.world` block in `config/scenes/scene.schema.json`.
4. For generation changes, read both `shared/world/chunkContent.mjs` and `native/chunkgen/src/placement.rs` side by side before touching either.

## Choose the change scope

- **Tune one map** (load distance, rock colour, bounds, fog): edit only that `.scene.json`. No code, no WASM rebuild.
- **Tune what the world looks like** (density, prop mix, scale ranges, jitter): edit both placement implementations, rebuild the WASM, commit the binary.
- **Add a prop kind**: touches both implementations, the template registry, and buffer capacity. See below.
- **Change loading policy** (when chunks load and unload): edit `shared/world/chunkStream.mjs` only. It is pure and has no WASM counterpart.
- **Change rendering only** (materials, batching, draw calls): edit `src/models/chunkMesh.ts`, `src/models/chunkTemplates.ts` or `src/world/`. Placement is untouched, so no WASM rebuild.
- **Change what blocks the player or the camera**: edit `PROP_COLLIDER_TEMPLATES` in `shared/world/chunkColliders.mjs` only. It is derived from the placement records, has no WASM counterpart, and both the browser and the room DS read it, so a one-sided edit is impossible. Keep it in step with the models in `src/models/`.

## Keep generation deterministic

Inside the placement algorithm:

- Use 32-bit integer arithmetic only. Millimetres for positions, milliradians for angles, thousandths for scale. `Math.imul` and `wrapping_mul` are bit-equivalent; floating point is not.
- Divide by 1000 only at the very end, in the consumer. That single division is identical under IEEE 754 on both sides.
- Never branch on anything a scene can configure. Content toggles belong in template registration, not in placement, or the two backends stop agreeing.
- Never use `%` on floats, `sin`, `cos`, `sqrt` or `abs` in the Rust crate. It is `no_std` on `wasm32-unknown-unknown` with no libm; see `native/chunkgen/src/math.rs` for the polynomial the batching step uses instead.

## Change the generation algorithm

1. Edit `shared/world/chunkContent.mjs`.
2. Mirror the change exactly in `native/chunkgen/src/placement.rs`, including constant values.
3. Run `npm run build:wasm`. This needs a Rust toolchain and the `wasm32-unknown-unknown` target; the rebuilt `shared/world/wasm/chunkgen.wasm` must be committed alongside the source.
4. Run `npm run test:server`. The parity test must pass before anything else is worth checking.
5. Confirm the world still fits its budgets: props per chunk stay within `MAXIMUM_PROPS_PER_CHUNK`, and vertices stay within the buffer caps.

Skipping step 3 leaves the client running stale generation while the server runs the new code. That is the one failure this system cannot detect at runtime.

## Add a prop kind

Both implementations carry the kind list and its scale table, and the ground template sits immediately after the prop kinds:

1. `shared/world/worldConfig.mjs`: add to `PROP_KIND` and bump `PROP_KIND_COUNT`. `GROUND_TEMPLATE_INDEX` follows it automatically.
2. `shared/world/chunkContent.mjs`: add the scale range and the selection branch.
3. `native/chunkgen/src/placement.rs`: add `KIND_*`, bump `KIND_COUNT`, extend `SCALE_MINIMUM` and `SCALE_MAXIMUM`. `TEMPLATE_GROUND` and `TEMPLATE_COUNT` in `lib.rs` follow `KIND_COUNT`.
4. `src/models/`: add the model, and register its template in `src/models/chunkTemplates.ts`.
   Then give it a collision template in `shared/world/chunkColliders.mjs` — an empty
   array if it should not collide (grass), a box list otherwise. A prop kind with no
   entry there is visible but not solid, and the camera boom will pass straight
   through it.
5. Give it a colour. Prop colours come from the scene: either reuse `renderer.palette`, or add a field to `renderer.world` and validate it in `server/scenes/SceneCatalog.mjs`, `config/scenes/scene.schema.json` and `src/scenes/data/SceneDefinition.ts` together.
6. Rebuild the WASM and run the full suite.

`registerChunkTemplates` warns at startup if the worst case — every prop cell holding the heaviest template — would overflow the vertex buffers. Heed that warning: raise `MAX_FILL_VERTICES` / `MAX_LINE_VERTICES` in `native/chunkgen/src/lib.rs` **and** the matching constants in `shared/world/chunkGenerator.mjs`, then rebuild.

## Add a streaming scene

Add `renderer.world` to a scene JSON and the scene stops placing fixed content; chunks take over ground, trees, grass and rocks. `SceneCatalog` enforces three invariants at startup and names the offending field:

- `keepRadius > loadRadius`, so chunks do not thrash on a boundary.
- `fog.far <= loadRadius * CHUNK_SIZE`, so the fog always hides the nearest unloaded chunk.
- `gameplay.bounds` inside `WORLD_PLAY_AREA`, so players never reach ungenerated ground.

Everything else follows `skyland-scene-authoring`. Note that the interactive `GrassFieldSystem` does not serve streaming scenes — it fills the whole play area once with a capped blade count, which is far too sparse across a 384 m world.

## Verify

1. `npm run test:server` — placement parity, chunk coordinates, streaming plans, scene invariants. Run this first; the parity test is the one that catches the dangerous class of mistake.
2. `npm test` — adds the client-side pure logic suites.
3. `npm run build` — type errors and the WASM asset emission.
4. Start the server and client, join a room on a streaming map, and walk across several chunk boundaries. Watch for chunks appearing inside the fog rather than beyond it, gaps at the seams, or a frame hitch when crossing a boundary.
5. Open the same map with `?chunkgen=js` and confirm the world looks identical. That is the fallback path, and a visible difference means the two backends have diverged in a way the tests did not cover.

Update `README.md` when the generation contract, the streaming policy or the scene fields change.
