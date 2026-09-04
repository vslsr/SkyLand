/**
 * 物品种类到 Actor 原型的映射。
 *
 * 一件物品在世界里有两副面孔——掉在地上的那个和拿在手上的那个——它们用的是**同一个
 * 原型**：同一套模型、同一条复制链路，区别只在挂不挂在角色身上、要不要物理。
 * 地上能画出来的东西，拿在手上就能画出来，不需要「手持专用原型」这一层配置。
 *
 * 拿在手上那副面孔由 `heldItemArchetype` 现场裁出来：把掉落物那一整套物理与
 * 世界身份摘掉，只留下模型。裁剪写在这里而不是各调用点，是因为「手持物没有碰撞
 * 和移动」是一条整体规则，散在几处迟早漏掉一项。
 */

/** 手持表现体保留的 Component。留下的每一样都只关乎「怎么画出来」。 */
const HELD_ITEM_COMPONENTS = Object.freeze(['render', 'itemStack', 'replicationPolicy']);

export function findItemArchetypeId(archetypes, itemType) {
  if (!archetypes || !itemType) return undefined;
  for (const [id, archetype] of archetypes) {
    if (archetype?.components?.itemStack?.itemType === itemType) return id;
  }
  return undefined;
}

/**
 * 把掉落原型裁成手持表现体的原型。
 *
 * 摘掉的都是「它是世界里一个独立物件」才需要的东西：
 *
 * - `dropMotion` / `actorResidency` / `lifetime`：手持物不掉落、不休眠、不过期。
 *   留着的话 `HighCountActorSystem` 会一边按重力积分它的世界坐标、一边和地上的
 *   同类堆合并，还会在 900 秒后把它从玩家嘴上删掉。
 * - `interactable`：手上那件不参与就近拾取，否则交互键会在「放下」和「拾取自己」
 *   之间摇摆。
 * - `combustible` / `temperature`：烧起来的是地上那堆柴，不是拿在手里的这一根。
 *
 * 坐标因此完全由 Actor 嵌套关系解算：父 Actor（玩家）动完，`AttachmentSystem`
 * 按 localTransform 重建它的世界坐标，中间没有任何一步物理。
 */
export function heldItemArchetype(archetype) {
  if (!archetype) return undefined;
  const components = {};
  for (const name of HELD_ITEM_COMPONENTS) {
    if (archetype.components?.[name]) components[name] = archetype.components[name];
  }
  return { ...archetype, components };
}
