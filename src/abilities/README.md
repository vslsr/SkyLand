# SkyLand Ability System

这是一个面向 SkyLand 的原创 TypeScript 能力系统。它借鉴数据驱动能力系统的职责划分，但不包含或翻译 Unreal Engine/Lyra 源码。

## 模块边界

- `AbilitySystem`：实体运行时；管理能力、活跃效果、标签、冷却和快照。
- `AttributeSet`：维护 `BaseValue`/`CurrentValue`，负责 Modifier 排序、聚合和 Clamp。
- `AbilityLoadout`：把能力和初始效果成组授予，适合装备、职业或角色模板。
- `GameAbilityComponent`：把纯运行时挂到 Actor，维护稳定的语义槽位和 Actor 生命周期。
- `GameAbilitySystem`：在 `ActorWorld` 的权威 tick 中统一推进所有能力 Component。
- `definitions`：只包含公开的定义、上下文、结果和快照类型。

系统不依赖 Three.js、DOM、Node 或具体网络库。服务端持有权威 `AbilitySystem`，客户端可消费 `createSnapshot()` 的结果更新 HUD 和表现。

## 最小示例

```ts
import { AbilitySystem, type EffectDefinition } from './abilities';

const caster = new AbilitySystem({
  ownerId: 'player:1',
  attributes: [
    { id: 'Mana', initialValue: 100, minimum: 0, maximum: 100 },
    { id: 'Attack', initialValue: 12, minimum: 0 },
  ],
});

const target = new AbilitySystem({
  ownerId: 'enemy:1',
  attributes: [{ id: 'Health', initialValue: 100, minimum: 0, maximum: 100 }],
});

const damage: EffectDefinition = {
  id: 'Effect.Damage.Fire',
  lifetime: { kind: 'instant' },
  modifiers: [{
    attributeId: 'Health',
    operation: 'add',
    magnitude: ({ source }) => -(source?.attributes.getCurrentValue('Attack') ?? 0),
  }],
};

const fireball = caster.grantAbility({
  id: 'Ability.Fireball',
  tags: ['Ability.Magic.Fire'],
  activationRequirements: { none: ['State.Silenced'] },
  costs: [{ attributeId: 'Mana', amount: 20 }],
  cooldown: { seconds: 1.5 },
  effects: [{ effect: damage, target: 'target' }],
});

caster.activateAbility(fireball, { target });
caster.update(1 / 60);
```

## Game Ability Component

`GameAbilityComponent` 使用组合而不是继承扩展能力内核：挂载到 Actor 时，以 Actor id
创建 `AbilitySystem`；`primary`、`skill-1` 这类稳定槽位映射到运行时 Handle；卸载时取消
仍活跃的能力并释放槽位。输入 Controller、AI 和 UI 只调用槽位，不保存内部 Handle。

```ts
import { Actor } from '../../shared/actor/Actor.mjs';
import { GameAbilityComponent } from './abilities';

const actor = new Actor('player:1', 'mage');
const abilities = actor.addComponent(new GameAbilityComponent({
  attributes: [{ id: 'Mana', initialValue: 100, minimum: 0, maximum: 100 }],
  abilities: [{
    slot: 'primary',
    ability: {
      id: 'Ability.Fireball',
      costs: [{ attributeId: 'Mana', amount: 20 }],
    },
  }],
})) as GameAbilityComponent;

abilities.activate('primary');
```

在 `ActorWorld` 中注册一次 `GameAbilitySystem`，冷却和周期效果就会随世界 tick 推进。
输入绑定、网络意图、快照复制和视觉反馈仍由各自适配层负责，Component 不直接监听 DOM
按键，也不把客户端动画当成权威状态。

当前“能力系统实验室”是客户端本地测试夹具。用于多人正式玩法时，应让房间 DS 持有
Component，客户端只发送能力槽位和目标意图；DS 校验后把属性、标签、效果和冷却摘要放入
快照。当前 Node 房间进程直接运行 `.mjs`，接入生产权威链路前还需要把这套 TypeScript
编译为服务端可导入的 shared 包，不能直接把实验室模拟当作联机权威实现。

## 数值与时间规则

- Instant Modifier 修改属性基础值。
- 非周期的 Timed/Infinite Modifier 只影响当前值，移除后自动还原。
- 设置 `period` 后，Modifier 按周期修改基础值，不作为持续 Modifier 聚合。
- Modifier 先按 `priority`、再按效果应用顺序执行，因此结果可重复。
- 所有时间单位都是秒；调用方负责使用服务端权威的固定或可控步长调用 `update()`。

## WASM 边界

能力生命周期、字符串标签和事件回调保留在 TypeScript。`AttributeCalculationBackend` 是可替换数值边界；只有性能分析证明批量属性聚合成为热点后，才应使用 TypedArray 将整批输入交给 WASM，避免每个 Modifier 跨一次 JS/WASM 边界。

## 当前范围

已经支持属性、Instant/Timed/Infinite/Periodic Effect、层级标签门控、标签引用计数、效果堆叠、能力消耗、共享冷却、能力并发组、Loadout 以及 JSON 可序列化快照。

客户端预测、回滚、快照恢复和输入 Tag 绑定属于网络/输入适配层，不在核心运行时中隐式实现。

## 可视化测试场景

启动服务后，在大厅创建“能力系统实验室”房间。场景中的施法水晶、测试木桩与侧边测试台会实时展示属性、标签、效果层数和冷却；可点击按钮或按 `1`–`4` 验证奥术伤害、燃烧 DOT、狂暴叠层与沉默阻断，使用“重置实验”恢复初始状态。
