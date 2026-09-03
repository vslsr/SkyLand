---
name: skyland-input-system
description: Configure, extend, integrate, rebind, or debug SkyLand's tag-driven cross-device input system under config/input and src/input, including InputAction, InputConfig tags, InputMappingContext, keyboard/mouse, touch, Gamepad, triggers, modifiers, prompts, and persisted runtime bindings. Use for SkyLand input-pipeline work; do not use for generic UI, camera math, or movement/network simulation that does not change input semantics.
---

# SkyLand Input System

Keep physical controls, input evaluation, semantic tags, and gameplay callbacks as separate layers. Gameplay code consumes tags or evaluated values; it must not depend directly on DOM keyboard, pointer, touch, or Gamepad events.

## Read before editing

1. Read `config/input/player.input.json` and `config/input/input-profile.schema.json` completely.
2. Read [references/input-contract.md](references/input-contract.md) when changing configuration, runtime rebinding, prompts, or adding a device/control namespace.
3. Inspect only the affected runtime layer:
   - `src/input/core/InputSubsystem.ts` for Context priority, aggregation, cancellation, or hot replacement.
   - `src/input/core/InputActionRuntime.ts` for trigger-state behavior.
   - `src/input/core/InputModifiers.ts` for axis calculation.
   - `src/input/config/InputSchemeParser.ts` and `InputSchemeRuntime.ts` for JSON validation, rebinding, persistence, or prompt formatting.
   - the matching adapter under `src/input/devices/` or `src/input/ui/VirtualControls.ts` for physical/virtual device behavior.

## Preserve the layer boundaries

The stable flow is:

```text
KeyboardMouse / Gamepad / Virtual device
  -> control path and InputValue
  -> prioritized InputMappingContext
  -> modifiers and InputAction trigger state
  -> InputConfig action-to-tag relation
  -> tag callback or value query
```

- Put authorable defaults in `config/input/player.input.json`, not in scene or gameplay classes.
- Keep parsing and cross-reference validation in `InputSchemeParser`; do not trust imported JSON through a type assertion alone.
- Keep user overrides in `InputSchemeRuntime`. Persist only differences from defaults.
- Let `InputSubsystem` own live input state. Replacing Context definitions must reset device state and cancel active Actions so held controls cannot become stuck.
- Let device adapters emit stable control paths. They do not decide gameplay tags, Action triggers, or Context priority.
- Bind gameplay behavior through `Input.Player.*` tags or use `getDigital` / `getAxis2D`; do not add a second key-event route in gameplay code.
- Treat HUD and world-space action markers as input-prompt consumers. Resolve their control from the live `InputSubsystem`, format it through `InputSchemeRuntime`, then pass only the final label into UI or Actor visual Components; those consumers must not know physical controls or Mapping ids.

## Choose the smallest change

- For a new key, alternate binding, Action, tag, prompt, or existing trigger/Modifier combination, prefer a configuration-only change plus tests.
- For a new trigger or Modifier type, update core types, runtime evaluation, JSON parser, JSON Schema, public exports, and focused tests together.
- For a new device family, add a focused adapter, extend `InputDeviceKind`, control-prefix inference, JSON Schema, prompt configuration, source arbitration, and cancel/disconnect tests.
- For a settings page, call the live `InputSchemeRuntime` exposed as `scene.inputBindings`; do not mutate Context arrays directly.
- For virtual-control layout or gesture changes, keep DOM/pointer behavior in `VirtualControls` and keep the resulting `Virtual.*` mapping in JSON.
- For a report that on-screen UI stopped responding to taps, check the screen layer order in `src/style.css` before touching gesture code: the joystick activation zone is a large transparent rectangle and must stay below every interactive UI layer.

## Configure safely

Every configurable Mapping needs a globally stable `id`, a `deviceKind`, a control path, and an Action id. Preserve Mapping ids across ordinary default-key changes because prompts and persisted overrides reference them.

Control namespaces and device slots must agree:

- `Keyboard.*` and `Mouse.*` -> `keyboardMouse`
- `Virtual.*` -> `touch`
- `Gamepad.*` -> `gamepad`

Prompt entries should reference Mapping ids for controls that can be rebound. Use literal prompt text only for behavior outside the configurable input pipeline, such as pointer-lock instructions. A prompt may only reference Mappings from its own device kind.

For an action-level prompt, configure a Mapping and display label for every supported device. A touch label is not enough by itself: its `Virtual.*` control also needs a real virtual button and a touch Mapping to the same Action.

## Integrate and rebind

Construct one `InputSchemeRuntime` per live input subsystem, then pass its `actions`, `config`, and `contexts` into `InputSubsystem`. Subscribe to binding changes and apply all four observable consequences:

1. call `replaceMappingContexts(runtime.contexts)`;
2. refresh keyboard default-prevention controls;
3. refresh cached HUD prompts;
4. invalidate or re-resolve action-level HUD/world prompts so they read the replacement Context on the next update.

Use `rebind(mappingId, control, { conflict })` for changes. `swap` is the default and preserves both bindings, `reject` reports an occupied control, and `allow` intentionally permits duplicates. Use `resetBinding` or `resetAllBindings` instead of rebuilding defaults manually.

## Preserve device behavior

- Do not sum axis values across keyboard/mouse, touch, and Gamepad. Select the most recently active device source; aggregate only within that device.
- Ignore zero/release noise when choosing the active device.
- On blur, visibility loss, pointer cancellation, device disconnect, input disable, or Context replacement, clear device state and dispatch `canceled` for active Actions.
- Keep touch controls multi-pointer safe by tracking pointer ids independently for the joystick and each button.
- Build virtual controls dynamically from `virtualControls`; do not restore hard-coded button markup in `index.html`.
- The virtual joystick is visible in `topdown` mode on coarse/no-hover devices. For desktop inspection, use the JSON-configured query parameter (currently `?virtual-controls=1`) and verify the control mode before debugging mappings.
- Virtual controls are game-layer input, not UI. Their layer (`--layer-game-input`) stays below every interactive UI layer (`--layer-game-ui` and above), so a pointer that lands on UI is consumed by that UI and never reaches the joystick; only unclaimed pointers become joystick input. `tests/ScreenLayerOrder.test.ts` ratchets that order.

## Verify

For configuration, prompt, or rebinding changes:

1. Add or update `tests/InputSchemeRuntime.test.ts`.
2. Run `npm run test:client`.
3. Run `npm run build` to exercise TypeScript, JSON import, and bundling.
4. Run `git diff --check`.

For virtual joystick math or layout configuration, update `tests/VirtualJoystick.test.ts` and the virtual-controls cases in `tests/InputSchemeRuntime.test.ts`. For core trigger, Context, arbitration, cancellation, or effective-Mapping prompt queries, also update `tests/InputSubsystem.test.ts` and run `npm test`. For action-level interaction markers, cover device switching and rebinding in the owning interaction test. For Gamepad adapter changes, update `tests/GamepadInputDevice.test.ts`. A change is complete only when invalid references fail deterministically, old bindings stop producing values after hot replacement, new bindings work immediately, HUD and world prompts reflect the active device and live binding, and full build/tests pass.
