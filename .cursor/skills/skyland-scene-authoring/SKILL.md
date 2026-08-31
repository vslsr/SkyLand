---
name: skyland-scene-authoring
description: Add, duplicate, revise, or debug SkyLand data-driven selectable scenes under config/scenes, including scene JSON authoring, renderer/gameplay/camera configuration, server catalog validation, DS initialization, and client loading. Use for SkyLand map or scene configuration work; do not use for unrelated Three.js model work or generic scene lifecycle changes.
---

# Skyland Scene Authoring

Create scenes as server-authoritative JSON data. Keep the lobby on its empty scene; load a configured world only after a room DS accepts the player and returns the validated scene definition.

## Read before editing

1. Read `config/scenes/scene.schema.json` and the existing `.scene.json` closest to the desired result.
   When the scene places Actors, also read `config/actors/actor.schema.json` and the referenced `.actor.json` files.
2. Read [references/scene-config.md](references/scene-config.md) completely when adding or reviewing a scene. It defines every field, its runtime effect, and cross-field constraints.
3. If the request introduces a new renderer type, content kind, or field, inspect these integration points before editing:
   - `server/scenes/SceneCatalog.mjs`
   - `server/actors/ActorCatalog.mjs` for Actor archetypes or placements
   - `src/scenes/data/SceneDefinition.ts`
   - `src/scene/createLineArtScene.ts`
   - the relevant module under `src/models/` or visual system under `src/`

## Choose the change scope

- For a new composition of supported content (`ground`, `trees`, `grass`, `ocean`), add only a new `config/scenes/<id>.scene.json` file.
- For a new field or content type, update the JSON Schema, runtime server validation/sanitization, client TypeScript definitions, renderer factory, and tests together. Do not place unsupported data in JSON and expect the client to discover it dynamically.
- For a scene carrying `renderer.world`, the world is streamed from a seed rather than authored. Adding such a map is still configuration-only, but changing what the chunks contain or how they load belongs to the `skyland-chunk-world` skill.
- Keep `.cursor/demo/` read-only. Adapt ideas into the active modular source tree.

## Add a scene

1. Copy the closest existing scene configuration.
2. Rename it to `<id>.scene.json`; use the same unique lowercase kebab-case value for `id`.
3. Keep `"$schema": "./scene.schema.json"` and `"schemaVersion": 1`.
4. Configure metadata, rendering, gameplay, and camera using the reference.
5. Check these invariants:
   - `renderer.fog.far` is greater than `renderer.fog.near`.
   - The spawn center is inside `gameplay.bounds`; keep the full spawn radius inside where practical.
   - Prefer `gameplay.spawn.slots >= capacity` so each possible player has a distinct spawn slot.
   - If `renderer.content.ocean` is `true`, provide both `renderer.ocean` and `gameplay.water`.
   - Size visible geometry to cover the gameplay bounds; for ocean, `renderer.ocean.size` should normally cover both the X and Z spans.
   - Keep all `renderer.palette` fields even when their corresponding content is disabled; the current schema and server validator require them.
6. Restart the Node server. `SceneCatalog` scans scene files only during server startup.

## Preserve the authoritative flow

Do not load the scene selected in the browser directly from local JSON. The expected flow is:

`SceneCatalog startup scan -> /api/scenes -> room creation -> fork room worker -> room:initialize -> room:ready -> WebSocket room:joined -> client loadScene(joined.scene)`

Actor-bearing scenes extend the same flow with:
`ActorCatalog resolution -> room worker ActorWorld -> actors snapshot -> client Actor Replica`.

An invalid or unknown scene ID must fail room creation. Leaving or losing the room must return the renderer to `showEmptyScene()`.

## Verify

For a configuration-only scene addition:

1. Run `npm run test:server` to exercise catalog and DS behavior.
2. Run `npm run build` to catch client type and bundle errors.
3. Start the server and confirm the new scene appears in `/api/scenes`, can create a room, and loads only after joining.
4. For Actor scenes, confirm the room snapshot contains the Actor and that the client creates it only after receiving that snapshot.

For schema, validation, renderer, or gameplay changes, also run `npm test` and add focused tests for the new invariant or system.

Update `README.md` when the scene contract or authoring workflow changes. A routine new map entry does not require duplicating its full configuration in the README.
