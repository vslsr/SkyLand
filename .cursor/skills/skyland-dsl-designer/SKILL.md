---
name: skyland-dsl-designer
description: Read, write, and implement SkyLand's `@` design-note DSL — the `@i` item, `@b` building-piece, `@w` tool/weapon and reserved `@e` entity entries used in doc/designer-*.md, their M/I/F/G/N/R, T/L, B/D fields, the `#design` placeholder, and how each field lands in config/items/item-catalog.json, a config/actors/*.actor.json buildPiece, or an item-use Ability. Use when a request quotes or asks for an `@i` / `@b` / `@w` entry, when adding an item, build piece, tool or weapon from a design note, or when extending the notation itself. For scene placement use skyland-scene-authoring; for new Components, Systems or replication use skyland-actor-component.
---

# SkyLand Design-Note DSL

`@i` / `@b` / `@w` entries in `doc/designer-*.md` are a design language, not free prose. Each entry fixes the fields one thing must declare, so a missing field is visible rather than silently unimplemented. Your job is either to write a well-formed entry or to land an existing one in configuration — never to treat the entry as a loose description you paraphrase into code.

## Read before editing

1. Read [`doc/dsl-designer.md`](../../../doc/dsl-designer.md) completely. It is the normative definition of the notation, the per-field landing table, and the honest implementation status of each field.
2. Read [references/dsl-authoring.md](references/dsl-authoring.md) when writing a new entry or reviewing one for completeness.
3. Read the design note that owns the entry: `doc/designer-inventory.md` for `@i`, `doc/desinger-buildsys.md` for `@b`, `doc/designer-toolandweapon.md` for `@w`.
4. Read the schema that receives the fields before writing any JSON:
   - `config/items/item-catalog.schema.json` and `config/items/item-catalog.json` for `@i`
   - the `buildPiece` definition inside `config/actors/actor.schema.json` and the closest existing piece (`campfire`, `float-wall`, `ground-foundation`) for `@b`
   - `shared/items/ItemAbility.mjs` and `server/actors/ItemAbilityRuntime.mjs` for any `F` that is not "不能使用"

## Separate the three places a fact can live

- **The notation** lives in `doc/dsl-designer.md`. Change it only when adding a field, a type letter, or a syntax rule.
- **The content** lives in the design notes. A new item, piece, tool or weapon is a new entry there.
- **The truth** lives in `config/`. The runtime reads JSON, never the Markdown.

Do not restate a full entry in `doc/dsl-designer.md`, and do not restate catalog JSON in a design note. When they disagree, the JSON is what ships; fix whichever side is wrong rather than leaving both.

## Land an entry, field by field

Work the landing tables in `doc/dsl-designer.md` in order and account for every field. The mapping in one line each:

- `@i` → one entry in `config/items/item-catalog.json` (name/summary/`I`/`G`/`N`/`R`) plus one drop archetype `config/actors/<id>-pile.actor.json` carrying `M` as `components.render`. There is only one model: the held item is that drop archetype with collision, drop physics, lifetime and interaction stripped by `heldItemArchetype()`. Do not author a second held model.
- `@b` → one `config/actors/<id>.actor.json` with a `buildPiece` Component. `T` picks `kind`, `L` becomes `slot`, `M` becomes `render`.
- `@w` → **no dedicated config exists.** A light tool (`B` empty or `0`) is today an `@i` with `category: "tool"` and `use.action: "tool"`. A heavy tool (`B` set) is an `@i` plus a `fixture` `@b`, the way 篝火 already is.

Three rules that decide whether a request is data or architecture:

1. A field with a landing cell is **data**: write the JSON and stop.
2. A field marked ❌ in `doc/dsl-designer.md` (`@b`'s `I`, all of `@w`'s `D`) needs a **new system**. Say so, scope the system, and do not fake it by overloading an existing field — `use.value` is harvest strength, not attack power.
3. Adding a value to `category`, `use.action`, or `buildPiece.kind` is **extending the language**. Change the JSON Schema, the server validation, the client TypeScript types, the renderer or runtime that consumes it, and tests together.

## Fill the gaps the notation leaves

The DSL does not carry every field a schema requires. Supply these explicitly rather than letting an implementer guess, and write the answer back into the entry:

- `@i` also needs a kebab-case `id`, a `tint`, and `slotCost` (`0` puts it in an independent pool — that is what tools and ammunition use, not the backpack grid).
- `@b` also needs `surface`, `reach`, `cost`, and for floating pieces `mass`, plus `buoyancy` and `hull` on a floating foundation.
- `holdable` is separate from `M`: a thing can have a model and still not be holdable.

A value written `#design` is a deliberate blank you are being asked to fill — answer it and record the answer. A field that is simply absent is an omission; ask for it or state the assumption. `0` and an absent line both mean "none" for `R` and `B`.

## Preserve the constraints the catalogs enforce

These fail at server startup, not at runtime, so check them before running anything:

- A foundation must render `line-art-build-foundation`, a wall must render `line-art-build-wall`, and a fixture must render neither. A wall's `width` must equal the build cell size.
- Any `buildPiece` archetype needs a `replicationPolicy`.
- `use.holdSeconds` is required for `mode: "hold"` and forbidden for `mode: "tap"`.
- `slot` is two-state. Same slot excludes, different slots coexist. An `L` table asking for a count above 1 in one slot has no landing today — raise it instead of approximating.
- Every `iconId` needs a real sprite in `src/ui/icons/ItemIconSprite.ts`; an unregistered id silently falls back.
- `cost.itemType` must name an item that exists in the catalog.

## Verify

1. `npm run test:server` — covers `ItemCatalog`, `ActorCatalog`, and `BuildSystem` validation.
2. `npm run test:client` for anything touching inventory, hotbar, build UI, or icons.
3. `npm run build` for type and bundle errors.
4. Start the server and confirm the new item or piece is accepted; a schema-valid file that the server rejects means a cross-field rule above was missed.

For a schema or enum change, also add a focused test for the new value and update `README.md` when the authoring contract changes. Adding one ordinary entry does not need a README change.
