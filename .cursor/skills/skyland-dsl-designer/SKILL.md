---
name: skyland-dsl-designer
description: Read, write, review, and implement SkyLand's `@` design-note DSL in doc/designer-*.md, including global `@design`, `@advice`, and `@todo` prompts and gameplay entries for items, build pieces, tools, weapons, and procedural animation. Use when handling these markers, authoring or reviewing `@i` / `@b` / `@w` entries, extending the notation, or landing an entry in config and code. For scene placement use skyland-scene-authoring; for new Components, Systems, or replication use skyland-actor-component.
---

# SkyLand Design-Note DSL

Treat `@` entries as a binding design language, not loose prose. Keep notation, design content, and shipped configuration distinct:

- Notation and marker behavior live in this skill's references.
- Content lives in `doc/designer-*.md`.
- Runtime truth lives in `config/` and code.

## Load only what the task needs

- For any `@` syntax or marker task, read [references/common-prompts.md](references/common-prompts.md) completely.
- For `@i`, `@b`, `@w`, `@e`, animation `A`, landing mappings, or implementation work, read [references/gameplay-prompts.md](references/gameplay-prompts.md) completely.
- When writing a new entry or reviewing one for completeness, also read [references/dsl-authoring.md](references/dsl-authoring.md).
- Do not load the gameplay reference for a task that only interprets or updates global markers; this separation exists so subagents can avoid irrelevant context.

## Before changing shipped data or code

Read the design note that owns the entry:

- `doc/designer-inventory.md` for `@i`.
- `doc/desinger-buildsys.md` for `@b` source constraints.
- `doc/designer-toolandweapon.md` for `@b` / `@w`.

Before writing JSON, inspect its receiving schema and closest existing example. For item-use behavior, inspect `shared/items/ItemAbility.mjs` and `server/actors/ItemAbilityRuntime.mjs`.

A field with an existing landing is data. A field marked unsupported in the gameplay reference requires a new system; do not approximate it through an unrelated field. Extending a closed enum requires schema, server validation, client types, consumers, and focused tests together.

## Verify implementation work

Run the checks proportional to the changed layer:

1. `npm run test:server` for item, actor, build, or server validation.
2. `npm run test:client` for inventory, hotbar, build UI, icons, or client behavior.
3. `npm run build` for type and bundle errors.

For a schema or enum change, add a focused test. An ordinary documentation-only DSL edit does not require runtime tests.
