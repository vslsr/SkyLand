import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel, SlingshotVisualRig } from './ActorVisualModel';

export type SlingshotRender = Extract<ActorRenderDefinition, { model: 'line-art-slingshot-pile' }>;

/**
 * 一把弹弓：**一根 Y 形树杈，两个杈头之间绷着一条皮筋**。
 *
 * 躺在地上、拿在手上是同一副模型，理由和其它几件物品一样——地上那个和手上那个
 * 是同一件东西，换一副长相只会让玩家以为捡起来变了。
 *
 * 它的 `-pile` 后缀是随掉落物模型的命名走的，但**弹弓不堆**：`stackLimit` 是 1，
 * 一格只放得下一把，所以这里没有「摆成一小堆」的第二种摆法。
 */

/** 手柄有多高（占总高的比例）。杈从这里往上分开。 */
const GRIP_RATIO = 0.44;

/** 杈头往外张开多少弧度。张太开像叉子，太小看不出是弹弓。 */
const FORK_TILT = 0.44;

export function createSlingshotGripGeometry(radius: number, height: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radius * 0.34, radius * 0.46, height * GRIP_RATIO, 7, 1);
}

export function createSlingshotForkGeometry(radius: number, height: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radius * 0.22, radius * 0.3, height * 0.5, 6, 1);
}

/** 皮筋：一条压扁的细杆，横在两个杈头之间。 */
export function createSlingshotBandGeometry(radius: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(radius * 1.5, radius * 0.16, radius * 0.28);
}

/** 杈头在哪：两根杈各自的位置与倾角，合批模板和独立模型读同一份。 */
export function slingshotForkPlacements(
  radius: number,
  height: number,
): readonly { x: number; y: number; tilt: number }[] {
  const y = height * GRIP_RATIO + height * 0.25 * Math.cos(FORK_TILT);
  const x = radius * 0.22 + Math.sin(FORK_TILT) * height * 0.25;
  return [{ x: -x, y, tilt: FORK_TILT }, { x, y, tilt: -FORK_TILT }];
}

/** 皮筋横在多高：两个杈头顶端的高度。 */
export function slingshotBandHeight(height: number): number {
  return height * GRIP_RATIO + height * 0.5 * Math.cos(FORK_TILT);
}

/** 独立预览模型（手持物走这条）；地上那把由 ThreeHighCountBatchVisual 合批绘制。 */
export function createSlingshotModel(
  environment: FillMaterialEnvironment,
  definition: SlingshotRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  const outline = new THREE.LineBasicMaterial({ color: definition.inkColor });
  root.add(visualRoot);

  const frame = createFillMaterial(definition.frameColor, environment);
  const grip = createOutlinedObject(
    createSlingshotGripGeometry(definition.radius, definition.height),
    frame,
    1,
    outline,
  );
  grip.position.y = definition.height * GRIP_RATIO * 0.5;
  visualRoot.add(grip);

  for (const placement of slingshotForkPlacements(definition.radius, definition.height)) {
    const fork = createOutlinedObject(
      createSlingshotForkGeometry(definition.radius, definition.height),
      frame,
      1,
      outline,
    );
    fork.position.set(placement.x, placement.y, 0);
    fork.rotation.z = placement.tilt;
    visualRoot.add(fork);
  }

  // 皮筋是三段折线的两段：左杈头 → 兜 → 右杈头。拉开时中间那个点后移成 V 形，
  // 所以它必须是一条能改点的线，而不是一根定长的横杆。地上那把仍是横杆——它不会
  // 被拉开，一段几何更省（见 `ThreeHighCountBatchVisual`）。
  const bandHalfSpan = slingshotForkPlacements(definition.radius, definition.height)[1].x;
  const bandHeight = slingshotBandHeight(definition.height);
  const bandGeometry = new THREE.BufferGeometry();
  bandGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -bandHalfSpan, bandHeight, 0,
    0, bandHeight, 0,
    bandHalfSpan, bandHeight, 0,
  ]), 3));
  const band = new THREE.Line(
    bandGeometry,
    new THREE.LineBasicMaterial({ color: definition.bandColor }),
  );
  band.name = 'slingshot-band';
  band.frustumCulled = false;
  visualRoot.add(band);

  // 兜：皮筋中间那一小块。它是玩家眼里「弹丸在哪儿」的那个点，所以拉开时它要跟着
  // 中点一起后移——只动线不动兜的话，看上去像皮筋从兜里滑出去了。
  const pouch = createOutlinedObject(
    new THREE.BoxGeometry(definition.radius * 0.5, definition.radius * 0.34, definition.radius * 0.2),
    createFillMaterial(definition.bandColor, environment),
    1,
    outline,
  );
  pouch.position.set(0, bandHeight, 0);
  visualRoot.add(pouch);

  const slingshotRig: SlingshotVisualRig = { band, pouch, bandHalfSpan, bandHeight };

  return {
    root,
    visualRoot,
    length: definition.radius * 2,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: definition.height + 0.4,
    slingshotRig,
  };
}
