import { defineTag } from '../../tags/index';
import type {
  InputActionDefinition,
  InputConfigDefinition,
  InputMappingContextDefinition,
} from '../core/types';

export const PlayerInputTags = {
  Move: defineTag('Input.Player.Move'),
  Sprint: defineTag('Input.Player.Sprint'),
  Primary: defineTag('Input.Player.Primary'),
  Interact: defineTag('Input.Player.Interact'),
  Dodge: defineTag('Input.Player.Dodge'),
} as const;

export const PlayerInputActionIds = {
  Move: 'IA_Player_Move',
  Sprint: 'IA_Player_Sprint',
  Primary: 'IA_Player_Primary',
  Interact: 'IA_Player_Interact',
  Dodge: 'IA_Player_Dodge',
} as const;

export const PlayerInputActions: readonly InputActionDefinition[] = [
  {
    id: PlayerInputActionIds.Move,
    valueType: 'axis2D',
    deadZone: 0.1,
    trigger: { type: 'pressed' },
  },
  {
    id: PlayerInputActionIds.Sprint,
    valueType: 'digital',
    trigger: { type: 'pressed' },
  },
  {
    id: PlayerInputActionIds.Primary,
    valueType: 'digital',
    trigger: { type: 'pressed' },
  },
  {
    id: PlayerInputActionIds.Interact,
    valueType: 'digital',
    trigger: { type: 'hold', thresholdMs: 350 },
  },
  {
    id: PlayerInputActionIds.Dodge,
    valueType: 'digital',
    trigger: { type: 'doubleTap', maximumGapMs: 260, maximumTapMs: 220 },
  },
];

export const PlayerInputConfig: InputConfigDefinition = {
  bindings: [
    { tag: PlayerInputTags.Move, actionId: PlayerInputActionIds.Move },
    { tag: PlayerInputTags.Sprint, actionId: PlayerInputActionIds.Sprint },
    { tag: PlayerInputTags.Primary, actionId: PlayerInputActionIds.Primary },
    { tag: PlayerInputTags.Interact, actionId: PlayerInputActionIds.Interact },
    { tag: PlayerInputTags.Dodge, actionId: PlayerInputActionIds.Dodge },
  ],
};

export const GameplayInputContext: InputMappingContextDefinition = {
  id: 'IMC.Gameplay',
  priority: 100,
  activeByDefault: true,
  mappings: [
    { control: 'Keyboard.KeyW', actionId: PlayerInputActionIds.Move, axis2D: { x: 0, y: 1 } },
    { control: 'Keyboard.ArrowUp', actionId: PlayerInputActionIds.Move, axis2D: { x: 0, y: 1 } },
    { control: 'Keyboard.KeyS', actionId: PlayerInputActionIds.Move, axis2D: { x: 0, y: -1 } },
    { control: 'Keyboard.ArrowDown', actionId: PlayerInputActionIds.Move, axis2D: { x: 0, y: -1 } },
    { control: 'Keyboard.KeyA', actionId: PlayerInputActionIds.Move, axis2D: { x: -1, y: 0 } },
    { control: 'Keyboard.ArrowLeft', actionId: PlayerInputActionIds.Move, axis2D: { x: -1, y: 0 } },
    { control: 'Keyboard.KeyD', actionId: PlayerInputActionIds.Move, axis2D: { x: 1, y: 0 } },
    { control: 'Keyboard.ArrowRight', actionId: PlayerInputActionIds.Move, axis2D: { x: 1, y: 0 } },
    { control: 'Virtual.MoveStick', actionId: PlayerInputActionIds.Move },

    { control: 'Keyboard.ShiftLeft', actionId: PlayerInputActionIds.Sprint },
    { control: 'Keyboard.ShiftRight', actionId: PlayerInputActionIds.Sprint },
    { control: 'Virtual.SprintButton', actionId: PlayerInputActionIds.Sprint },

    { control: 'Mouse.Button0', actionId: PlayerInputActionIds.Primary },
    { control: 'Keyboard.KeyF', actionId: PlayerInputActionIds.Interact },
    { control: 'Virtual.InteractButton', actionId: PlayerInputActionIds.Interact },
    { control: 'Keyboard.Space', actionId: PlayerInputActionIds.Dodge },
    { control: 'Virtual.DodgeButton', actionId: PlayerInputActionIds.Dodge },
  ],
};

export const PREVENT_DEFAULT_GAMEPLAY_CONTROLS = GameplayInputContext.mappings
  .map((mapping) => mapping.control)
  .filter((control) => control.startsWith('Keyboard.'));
