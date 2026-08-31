import rawPlayerInputScheme from '../../../config/input/player.input.json' with { type: 'json' };
import { defineTag } from '../../tags/index';
import { InputSchemeRuntime, type InputSchemeRuntimeOptions } from './InputSchemeRuntime';
import { parseInputSchemeDefinition } from './InputSchemeParser';

export const PlayerInputSchemeDefinition = parseInputSchemeDefinition(rawPlayerInputScheme);

export function createPlayerInputScheme(
  options: InputSchemeRuntimeOptions = {},
): InputSchemeRuntime {
  return new InputSchemeRuntime(PlayerInputSchemeDefinition, options);
}

export const PlayerInputActionIds = {
  Move: 'IA_Player_Move',
  Sprint: 'IA_Player_Sprint',
  Primary: 'IA_Player_Primary',
  Interact: 'IA_Player_Interact',
  Dodge: 'IA_Player_Dodge',
} as const;

const tagForAction = (actionId: string): string => {
  const binding = PlayerInputSchemeDefinition.inputConfig.bindings.find((item) => (
    item.actionId === actionId
  ));
  if (!binding) throw new Error(`Player InputScheme 缺少 ${actionId} 的标签`);
  return String(binding.tag);
};

export const PlayerInputTags = {
  Move: defineTag(tagForAction(PlayerInputActionIds.Move)),
  Sprint: defineTag(tagForAction(PlayerInputActionIds.Sprint)),
  Primary: defineTag(tagForAction(PlayerInputActionIds.Primary)),
  Interact: defineTag(tagForAction(PlayerInputActionIds.Interact)),
  Dodge: defineTag(tagForAction(PlayerInputActionIds.Dodge)),
} as const;

// 兼容现有业务层导入；数据源均来自 player.input.json。
export const PlayerInputActions = PlayerInputSchemeDefinition.inputActions;
export const PlayerInputConfig = PlayerInputSchemeDefinition.inputConfig;
export const GameplayInputContext = PlayerInputSchemeDefinition.inputMappingContexts.find((context) => (
  context.id === 'IMC.Gameplay'
)) ?? (() => { throw new Error('Player InputScheme 缺少 IMC.Gameplay'); })();
export const PREVENT_DEFAULT_GAMEPLAY_CONTROLS = GameplayInputContext.mappings
  .map((mapping) => mapping.control)
  .filter((control) => control.startsWith('Keyboard.'));
