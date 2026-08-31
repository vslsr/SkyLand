# SkyLand input configuration and runtime contract

Use this reference when editing `config/input`, wiring a settings page, or extending the set of controls, devices, triggers, or prompts.

## Configuration ownership

`config/input/player.input.json` is the default player-input source of truth. Its schema is `config/input/input-profile.schema.json`.

```text
inputActions
  Defines value type, trigger, and Action-level modifiers.

inputConfig.bindings
  Assigns one semantic gameplay tag to each Action.

inputMappingContexts
  Maps physical or virtual controls to Actions, with priority and consume behavior.

devicePrompts
  Defines control display labels and mode/device/state-specific HUD content.

virtualControls
  Defines joystick behavior, dynamic buttons, orientation layouts, and desktop debugging.
```

The configuration is imported by `src/input/config/playerInput.ts`, parsed as unknown data, and validated by `parseInputSchemeDefinition`. Compatibility exports such as `PlayerInputActions` and `GameplayInputContext` are derived from that parsed definition; do not maintain separate hard-coded copies.

## Action and tag rules

- `digital` values are booleans. `axis2D` values are finite `{ x, y }` objects.
- Supported triggers are `pressed`, `hold`, and `doubleTap`.
- Supported axis modifiers are `deadZone`, `scale`, `negate`, `normalize`, and `swizzle`; order matters.
- Axis modifiers are invalid on digital Actions.
- Tags use non-empty dot-separated hierarchy such as `Input.Player.Move`.
- Each tag and each Action may appear only once in `inputConfig.bindings`.
- Every referenced Action must exist.

Gameplay callback example:

```ts
const dispose = input.bind(PlayerInputTags.Interact, (event) => {
  if (event.phase !== 'triggered') return;
  // Perform semantic gameplay behavior here.
});
```

Continuous value example:

```ts
const move = input.getAxis2D(PlayerInputTags.Move);
const sprinting = input.getDigital(PlayerInputTags.Sprint);
```

Dispose callbacks when their consumer is destroyed.

## Mapping rules

Mapping ids are public configuration identities. They are referenced by persisted overrides and prompt entries, so renaming one behaves like deleting the user's saved binding.

An axis Mapping may use:

- `axis2D` to turn a digital button into a direction;
- `scale` for simple per-axis multiplication;
- `modifiers` for ordered axis transforms;
- `consume: false` when a lower-priority Context is intentionally allowed to reuse the control.

Higher-priority active Contexts are evaluated first. A consumed control is unavailable to lower-priority Contexts, while multiple mappings for that control inside the same Context may still cooperate.

## Runtime construction

Use the project factory so local persisted overrides are restored before `InputSubsystem` sees the Contexts:

```ts
const scheme = createPlayerInputScheme();
const input = new InputSubsystem({
  actions: scheme.actions,
  config: scheme.config,
  contexts: scheme.contexts,
  devices,
});
```

Pass `{ storage: null }` for isolated tests. A custom `InputBindingStorage` can be used outside the browser.

The live scene exposes the same instance through `scene.inputBindings`:

```ts
scene.inputBindings.rebind('Move.Keyboard.Up', 'Keyboard.KeyI');
scene.inputBindings.rebind(
  'Dodge.Keyboard.Primary',
  'Keyboard.KeyQ',
  { conflict: 'reject' },
);
scene.inputBindings.resetBinding('Move.Keyboard.Up');
scene.inputBindings.resetAllBindings();
```

Rebinding is device-slot preserving. A keyboard Mapping cannot be assigned a `Gamepad.*` control; create or target a Gamepad Mapping instead.

## Prompt resolution

`InputSchemeRuntime.getPrompt(mode, deviceKind, state?)` resolves live Mapping controls into display labels. Resolution uses this order:

1. exact mode, device, and state;
2. same mode/device prompt without a state;
3. keyboard/mouse fallback for modes that have no device-specific prompt.

Use `mappingIds` for rebindable prompt entries. `controlLabels` provides curated display names; unknown but valid controls use a readable fallback. Call `HudController.refreshInputPrompt()` after runtime binding changes.

### Action-level HUD and world prompts

Mode-level help text uses `InputSchemeRuntime.getPrompt`. A prompt for one gameplay Action—such as a world-space interaction marker—must instead resolve the semantic tag against the currently effective Contexts and active device:

```ts
const [control] = input.getMappedControls(PlayerInputTags.WorldInteract);
const inputLabel = control ? scheme.getControlLabel(control) : undefined;
interactionMarker.setLabel(inputLabel);
```

Keep the ownership split explicit:

- `InputSubsystem.getMappedControls` owns active Context priority, consume behavior and the most recently active `InputDeviceKind`.
- `InputSchemeRuntime.getControlLabel` owns curated names and readable fallback formatting, including live rebinding results.
- Gameplay controllers consume tags and may request a resolved label for prompt composition; they do not embed `E`, `Y`, `ACT` or Mapping ids.
- HUD and Actor visual Components receive only the resolved label. A reusable world marker remains an input-agnostic visual Component and does not import `InputSubsystem`.

Do not resolve an action prompt by scanning every raw scheme Context: that can expose an inactive or priority-shadowed Mapping. Do not fall back to a keyboard label when the current device has no Mapping for that Action; hide the actionable marker or show an explicit unbound state instead.

Every device advertised by an action prompt needs a usable Mapping and a `controlLabels` entry. For touch, add a distinct `Virtual.*` button when reusing another semantic button would fire two unrelated Actions. The virtual button definition, touch Mapping and label must name the same control path.

Standard Gamepad control paths describe logical button positions, not controller artwork. A single `gamepad` device kind can use a generic label such as `Y`/`△`; exact Xbox, PlayStation and Switch glyphs require a separate device-layout profile selected from the connected Gamepad identity, while the Action Mapping remains unchanged.

Device activity and binding replacement can change the label between frames. Re-resolve while the interaction candidate is active, or cache the result behind both active-device and binding-change invalidation. Dynamic texture/icon resources in world markers must be replaced only when the label changes and disposed when the marker is cleared, keeping resource use bounded by visible prompts rather than world size.

## Virtual input contract

`VirtualControls` converts pointer gestures into the same input pipeline as physical devices:

- joystick -> `Virtual.MoveStick` axis2D;
- run button -> `Virtual.SprintButton` digital;
- hold button -> `Virtual.InteractButton` digital;
- world interaction button -> `Virtual.WorldInteractButton` digital;
- double-tap button -> `Virtual.DodgeButton` digital.

The Action trigger, not the button widget, decides whether a press becomes Pressed, Hold, or DoubleTap. Keep that semantic in JSON/Action runtime so keyboard, touch, and Gamepad behave consistently.

V2 builds its DOM from `virtualControls` rather than fixed markup. The JSON contract owns:

- `joystick.mode`: `fixed` or `floating`;
- base, knob, and travel radii;
- radial dead zone and sensitivity;
- floating activation-area width and height ratios;
- button labels, sizes, grid positions, and control paths;
- landscape/portrait edge inset, bottom inset, gap, and scale;
- the desktop debug query parameter.

The browser layout adds `env(safe-area-inset-*)` to configured offsets. Floating centers are clamped so the complete base remains inside the activation region. Visual knob travel remains continuous inside the dead zone while the emitted axis stays zero; outside it, output is radially remapped and clamped to the unit circle.

Every joystick/button control must have a touch Mapping in the same input scheme. Keep only the empty `#virtual-controls` host in `index.html`; `VirtualControls` owns all generated child elements and pointer listeners.

## Failure signatures

| Symptom | Check |
| --- | --- |
| JSON loads but startup throws | Action ids, duplicate tags/Mapping ids, device prefix, prompt references |
| Rebind API reports device mismatch | Control namespace does not match the Mapping's fixed `deviceKind` |
| New key appears in storage but has no effect | Live scene did not call `replaceMappingContexts` after the change |
| Movement remains active after rebinding | Context replacement did not clear device state and cancel Actions |
| HUD shows the old key | Prompt used literal text, omitted the Mapping id, or was not refreshed |
| World marker stays on `E` after device switch or rebind | Controller or marker owns a literal glyph instead of resolving tag -> effective Mapping -> control label |
| World marker shows a key from an inactive Context | Prompt scanned raw scheme Contexts instead of `InputSubsystem.getMappedControls` |
| Touch marker is visible but cannot interact | A touch label exists without a matching virtual button and touch Mapping, or one virtual control was unintentionally shared by unrelated Actions |
| Touch input changes movement but HUD stays on keyboard | Device events were not emitted with `deviceKind: touch` or activity was below threshold |
| Virtual joystick is absent on desktop | It is gated by `topdown`; add the configured debug query parameter, currently `?virtual-controls=1` |
| Virtual-control JSON fails during startup | A `Virtual.*` control lacks a touch Mapping, dimensions are out of bounds, or ids/controls are duplicated |
| Floating base is clipped near an edge | Clamp the center against the activation-zone rectangle using the scaled base radius |
| Keyboard and joystick cancel each other or produce oversized values | Axis sources were combined across device kinds instead of using last-active arbitration |
