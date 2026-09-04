import * as THREE from 'three';
import { createCharacterInkMaterial } from '../../materials/createCharacterInkMaterial';
import { createContactShadowMaterial } from '../../materials/createContactShadowMaterial';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import {
  leggedSlimeBodyCenterY,
  leggedSlimeTopY,
} from '../../../shared/actor/leggedSlimeShape.mjs';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createSlimeSoftBody, type SlimePalette } from '../slimeSoftBody';
import type {
  ActorVisualModel,
  SlimeLegBoneVisual,
  SlimeLegVisualRig,
} from './ActorVisualModel';

export type LeggedSlimeRenderDefinition = Extract<
  ActorRenderDefinition,
  { model: 'line-art-legged-slime' }
>;

/**
 * 骨头是圆柱，不是线段。
 *
 * `LineBasicMaterial.linewidth` 在几乎所有 WebGL 实现上都被忽略（永远画 1px），
 * 所以「较粗的黑色线条」只能用实体几何画。几何沿 +Y 从 0 长到 1，摆的时候
 * 直接把 `scale.y` 设成骨长，一根几何就够所有腿共用。
 */
function createBoneGeometry(thickness: number): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(thickness, thickness, 1, 7, 1, false);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

function createPalette(definition: LeggedSlimeRenderDefinition): SlimePalette {
  return {
    membrane: definition.membraneColor,
    middle: definition.middleColor,
    core: definition.coreColor,
    bubble: definition.bubbleColor,
    ink: definition.inkColor,
    shadow: definition.shadowColor,
  };
}

/**
 * 髋点绕身体均匀分布。
 *
 * 双足时 i=0 落在 +X、i=1 落在 -X，正好是草图里那两条腿；四足及以上自动摊成
 * 四角/多角，不需要为每种腿数再写一张表。
 */
function hipAngle(index: number, legCount: number): number {
  return ((index + 0.5) / legCount) * Math.PI * 2;
}

/**
 * 圆球软体身体 + 骨骼腿。
 *
 * 身体沿用 `line-art-player-slime` 的那套软体（`createSlimeSoftBody`），只是
 * 不再贴地：腿把它撑到髋高，`ThreeSlimeAnimator` 让它在髋点上原地挤压。
 *
 * 腿本身不在这里动——这里只建节点。落脚点、抬腿落下与两节 IK 全部由
 * `ThreeSlimeLegVisual` 每帧解算（步态是表现，住在渲染世界里）。
 */
export function createLeggedSlimeModel(
  definition: LeggedSlimeRenderDefinition,
  palette: SlimePalette = createPalette(definition),
): ActorVisualModel {
  const root = new THREE.Group();
  root.name = 'legged-slime';
  const visualRoot = new THREE.Group();
  visualRoot.name = 'legged-slime-visual';
  root.add(visualRoot);

  const bodyRoot = new THREE.Group();
  bodyRoot.name = 'legged-slime-body';
  // 身体骑在髋点**上方**，不是以髋点为中心：草图里腿是从身体底下伸出来的，
  // 把身体中心放在髋高会让两条腿的上半截穿在半透明的软体里。
  bodyRoot.position.y = leggedSlimeBodyCenterY(definition.hipHeight, definition.radius);
  visualRoot.add(bodyRoot);
  const softBody = createSlimeSoftBody(definition.radius, palette);
  bodyRoot.add(softBody.body);

  // 腿挂在权威 root 而不是 visualRoot 下：脚踩的是世界的地面，不该跟着身体的
  // 挤压、摇晃一起上下浮动。
  const legRoot = new THREE.Group();
  legRoot.name = 'legged-slime-legs';
  root.add(legRoot);

  // 腿和眼睛一样属于角色墨记层：不受昼夜光照、距离雾与色调映射影响，任何时刻
  // 都是同一道纯黑的剪影。之前它只关了色调映射，雾天与入夜时腿会被混向雾色，
  // 在沉下去的纸面上淡成几道看不清的浅痕。见 createCharacterInkMaterial。
  const boneMaterial = createCharacterInkMaterial(definition.legColor);
  const boneGeometry = createBoneGeometry(definition.legThickness);
  const shadowGeometry = new THREE.CircleGeometry(definition.footLength * 1.6, 16);

  const legs: SlimeLegBoneVisual[] = [];
  for (let index = 0; index < definition.legCount; index += 1) {
    const angle = hipAngle(index, definition.legCount);
    const thigh = new THREE.Mesh(boneGeometry, boneMaterial);
    thigh.name = `legged-slime-thigh-${index}`;
    thigh.frustumCulled = false;
    const shin = new THREE.Mesh(boneGeometry, boneMaterial);
    shin.name = `legged-slime-shin-${index}`;
    shin.frustumCulled = false;
    // 脚就是第三节骨头：从踝点朝正前方折出去的一小段。膝关节不再单画一个环——
    // 两节骨头本身的夹角已经把关节画出来了。
    const foot = new THREE.Mesh(boneGeometry, boneMaterial);
    foot.name = `legged-slime-foot-${index}`;
    foot.frustumCulled = false;
    // 影子的方向、长度和浓度跟着房间权威时刻走，见 createContactShadowMaterial。
    // 它是画出来的接触提示，不是实时阴影贴图。
    const shadow = new THREE.Mesh(
      shadowGeometry,
      createContactShadowMaterial(definition.footShadowColor, { opacity: 0.3 }),
    );
    shadow.name = `legged-slime-foot-shadow-${index}`;
    shadow.rotation.x = -Math.PI / 2;
    shadow.renderOrder = 1;
    shadow.frustumCulled = false;
    legRoot.add(thigh, shin, foot, shadow);
    legs.push({
      thigh,
      shin,
      foot,
      shadow,
      hipLocalX: Math.sin(angle) * definition.legSpread,
      hipLocalZ: Math.cos(angle) * definition.legSpread,
      // 半格偏置让相位左右对称：`index / legCount` 会把第一条腿的偏置压成 0，
      // 起步时两条腿就是从同一个位置一起往前赶。
      phase: (index + 0.5) / definition.legCount,
    });
  }

  const slimeLegVisualRig: SlimeLegVisualRig = { bodyRoot, legRoot, softBody, legs };
  return {
    root,
    visualRoot,
    length: definition.radius * 2,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: leggedSlimeTopY(definition.hipHeight, definition.radius) + definition.radius * 0.3,
    slimeLegVisualRig,
  };
}
