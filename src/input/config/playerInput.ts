import rawPlayerInputScheme from '../../../config/input/player.input.json' with { type: 'json' };
import { defineTag } from '../../tags/index';
import { InputSchemeRuntime, type InputSchemeRuntimeOptions } from './InputSchemeRuntime';
import { parseInputSchemeDefinition } from './InputSchemeParser';

export const PlayerInputSchemeDefinition = parseInputSchemeDefinition(rawPlayerInputScheme);

export interface PlayerInputSchemeOptions extends InputSchemeRuntimeOptions {
  /** 测试可显式覆盖；产品构建默认移除开发 Context，F8 不会占用浏览器按键。 */
  readonly includeDevelopmentMappings?: boolean;
}

export function createPlayerInputScheme(
  options: PlayerInputSchemeOptions = {},
): InputSchemeRuntime {
  const {
    includeDevelopmentMappings = import.meta.env?.DEV === true,
    ...runtimeOptions
  } = options;
  const definition = includeDevelopmentMappings
    ? PlayerInputSchemeDefinition
    : {
        ...PlayerInputSchemeDefinition,
        inputMappingContexts: PlayerInputSchemeDefinition.inputMappingContexts.filter((context) => (
          context.id !== 'IMC.Development'
        )),
      };
  return new InputSchemeRuntime(definition, runtimeOptions);
}

export const PlayerInputActionIds = {
  Move: 'IA_Player_Move',
  VesselMove: 'IA_Vessel_Move',
  Sprint: 'IA_Player_Sprint',
  Jump: 'IA_Player_Jump',
  Primary: 'IA_Player_Primary',
  Interact: 'IA_Player_Interact',
  WorldInteract: 'IA_World_Interact',
  AbilityArcane: 'IA_AbilityLab_Arcane',
  AbilityBurn: 'IA_AbilityLab_Burn',
  AbilityRage: 'IA_AbilityLab_Rage',
  AbilitySilence: 'IA_AbilityLab_Silence',
  AbilityReset: 'IA_AbilityLab_Reset',
  Inventory: 'IA_Player_Inventory',
  DebugMenu: 'IA_Debug_Menu',
  Dodge: 'IA_Player_Dodge',
} as const;

export const PlayerInputMappingIds = {
  DebugMenuKeyboard: 'DebugMenu.Keyboard.F8',
  InventoryKeyboard: 'Inventory.Keyboard.Primary',
  JumpKeyboard: 'Jump.Keyboard.Primary',
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
  VesselMove: defineTag(tagForAction(PlayerInputActionIds.VesselMove)),
  Sprint: defineTag(tagForAction(PlayerInputActionIds.Sprint)),
  Jump: defineTag(tagForAction(PlayerInputActionIds.Jump)),
  Primary: defineTag(tagForAction(PlayerInputActionIds.Primary)),
  Interact: defineTag(tagForAction(PlayerInputActionIds.Interact)),
  WorldInteract: defineTag(tagForAction(PlayerInputActionIds.WorldInteract)),
  AbilityArcane: defineTag(tagForAction(PlayerInputActionIds.AbilityArcane)),
  AbilityBurn: defineTag(tagForAction(PlayerInputActionIds.AbilityBurn)),
  AbilityRage: defineTag(tagForAction(PlayerInputActionIds.AbilityRage)),
  AbilitySilence: defineTag(tagForAction(PlayerInputActionIds.AbilitySilence)),
  AbilityReset: defineTag(tagForAction(PlayerInputActionIds.AbilityReset)),
  Inventory: defineTag(tagForAction(PlayerInputActionIds.Inventory)),
  DebugMenu: defineTag(tagForAction(PlayerInputActionIds.DebugMenu)),
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
