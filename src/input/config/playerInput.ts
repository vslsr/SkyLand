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
  Aim: 'IA_Player_Aim',
  VesselMove: 'IA_Vessel_Move',
  Sprint: 'IA_Player_Sprint',
  Jump: 'IA_Player_Jump',
  Primary: 'IA_Player_Primary',
  Interact: 'IA_Player_Interact',
  WorldInteract: 'IA_World_Interact',
  Drop: 'IA_Player_Drop',
  AbilityArcane: 'IA_AbilityLab_Arcane',
  AbilityBurn: 'IA_AbilityLab_Burn',
  AbilityRage: 'IA_AbilityLab_Rage',
  AbilitySilence: 'IA_AbilityLab_Silence',
  AbilityReset: 'IA_AbilityLab_Reset',
  Inventory: 'IA_Player_Inventory',
  DebugMenu: 'IA_Debug_Menu',
  Dodge: 'IA_Player_Dodge',
  HotbarPrevious: 'IA_Hotbar_Previous',
  HotbarNext: 'IA_Hotbar_Next',
} as const;

/** 快捷栏直选：数字键 1-9。格数由玩家原型决定，超出的那几个标签不会有人监听。 */
export const HotbarSlotActionIds = Array.from(
  { length: 9 },
  (_, index) => `IA_Hotbar_Slot${index + 1}`,
) as readonly string[];

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
  Aim: defineTag(tagForAction(PlayerInputActionIds.Aim)),
  VesselMove: defineTag(tagForAction(PlayerInputActionIds.VesselMove)),
  Sprint: defineTag(tagForAction(PlayerInputActionIds.Sprint)),
  Jump: defineTag(tagForAction(PlayerInputActionIds.Jump)),
  Primary: defineTag(tagForAction(PlayerInputActionIds.Primary)),
  Interact: defineTag(tagForAction(PlayerInputActionIds.Interact)),
  WorldInteract: defineTag(tagForAction(PlayerInputActionIds.WorldInteract)),
  Drop: defineTag(tagForAction(PlayerInputActionIds.Drop)),
  AbilityArcane: defineTag(tagForAction(PlayerInputActionIds.AbilityArcane)),
  AbilityBurn: defineTag(tagForAction(PlayerInputActionIds.AbilityBurn)),
  AbilityRage: defineTag(tagForAction(PlayerInputActionIds.AbilityRage)),
  AbilitySilence: defineTag(tagForAction(PlayerInputActionIds.AbilitySilence)),
  AbilityReset: defineTag(tagForAction(PlayerInputActionIds.AbilityReset)),
  Inventory: defineTag(tagForAction(PlayerInputActionIds.Inventory)),
  DebugMenu: defineTag(tagForAction(PlayerInputActionIds.DebugMenu)),
  Dodge: defineTag(tagForAction(PlayerInputActionIds.Dodge)),
  HotbarPrevious: defineTag(tagForAction(PlayerInputActionIds.HotbarPrevious)),
  HotbarNext: defineTag(tagForAction(PlayerInputActionIds.HotbarNext)),
} as const;

/** 第 N 格（从 0 起）的输入标签。 */
export const HotbarSlotTags = HotbarSlotActionIds.map(
  (actionId) => defineTag(tagForAction(actionId)),
);

/**
 * 物品目录里的逻辑输入槽到输入标签的映射。
 *
 * 这是「配置里写 `input: "primary"`」与「实际按哪个键」之间唯一的接缝：物品不认识
 * 键位，输入方案不认识物品。想让某件道具改用别的键，改物品目录；想让那个槽换成
 * 别的物理键，改输入方案。目前只有主手一个槽。
 */
export const ItemUseInputTags = {
  primary: PlayerInputTags.Primary,
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
