import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import type { ActorVisualModel } from './ActorVisualModel';

type MushroomRender = Extract<ActorRenderDefinition, { model: 'line-art-elastic-mushroom' }>;

/**
 * 菌盖压扁到这个比例；菌柄顶端再抬这么多个半径。
 *
 * 这几条和下面的几何构造一起，就是「弹弹菇长什么样」的唯一一份答案：掉在地上、
 * 拿在手上的那一堆（`createMushroomPileModel` 与合批模板）读的都是它，换个数字
 * 三处一起变。世界里那一株和包里那一个本来就该是同一种蘑菇。
 */
export const MUSHROOM_CAP_FLATTEN = 0.42;
export const MUSHROOM_CAP_LIFT = 0.04;

/** 菌盖之下那截菌柄的长度。 */
export function mushroomStemLength(radius: number, height: number): number {
  return Math.max(0.1, height - radius * 0.46);
}

export function createMushroomStemGeometry(
  radius: number,
  stemLength: number,
): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radius * 0.2, radius * 0.31, stemLength, 10, 3);
}

export function createMushroomCapGeometry(radius: number): THREE.BufferGeometry {
  return new THREE.SphereGeometry(radius, 16, 9);
}

/** 菌盖上那三点白斑：半径、位置与朝向都按半径成比例。 */
export const MUSHROOM_CAP_SPOTS = [
  { scale: 0.105, offset: [-0.23, 0.39, 0.05], rotation: [-Math.PI / 2, 0, -0.32] },
  { scale: 0.085, offset: [0.25, 0.34, 0.16], rotation: [-1.18, 0.18, 0.42] },
  { scale: 0.07, offset: [0.08, 0.32, -0.27], rotation: [-1.02, -2.7, 0.1] },
] as const satisfies readonly {
  scale: number;
  offset: readonly [number, number, number];
  rotation: readonly [number, number, number];
}[];

function addSpot(
  capRoot: THREE.Group,
  radius: number,
  position: readonly [number, number, number],
  rotation: readonly [number, number, number],
  color: string,
  environment: FillMaterialEnvironment,
): void {
  const spot = createOutlinedObject(
    new THREE.CircleGeometry(radius, 8),
    createFillMaterial(color, environment),
    1,
    new THREE.LineBasicMaterial({ color: 0x4a382f, transparent: true, opacity: 0.72 }),
  );
  spot.position.set(...position);
  spot.rotation.set(...rotation);
  capRoot.add(spot);
}

/** 低多边形线稿菌盖与独立菌柄；只缩放局部节点，描边会自然跟随拉伸。 */
export function createElasticMushroomModel(
  environment: FillMaterialEnvironment,
  definition: MushroomRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  // 脱落之前 pivotRoot / bodyRoot 都是单位变换，蘑菇照旧立在原点上；
  // 拔断之后由 ActorDropRollSystem 把它们撑成绕刚体球心的翻滚枢轴。
  const pivotRoot = new THREE.Group();
  const bodyRoot = new THREE.Group();
  const elasticRoot = new THREE.Group();
  const stemRoot = new THREE.Group();
  const capRoot = new THREE.Group();
  root.add(visualRoot);
  visualRoot.add(pivotRoot);
  pivotRoot.add(bodyRoot);
  bodyRoot.add(elasticRoot);
  elasticRoot.add(stemRoot, capRoot);

  const outline = new THREE.LineBasicMaterial({ color: 0x352b27 });
  const restLength = mushroomStemLength(definition.radius, definition.height);
  const stem = createOutlinedObject(
    createMushroomStemGeometry(definition.radius, restLength),
    createFillMaterial(definition.stemColor, environment),
    1,
    outline,
  );
  stem.position.y = restLength * 0.5;
  stemRoot.add(stem);

  const cap = createOutlinedObject(
    createMushroomCapGeometry(definition.radius),
    createFillMaterial(definition.capColor, environment),
    4,
    outline,
  );
  cap.scale.y = MUSHROOM_CAP_FLATTEN;
  cap.position.y = definition.radius * MUSHROOM_CAP_LIFT;
  capRoot.add(cap);
  capRoot.position.y = restLength;

  for (const spot of MUSHROOM_CAP_SPOTS) {
    addSpot(
      capRoot,
      definition.radius * spot.scale,
      [
        definition.radius * spot.offset[0],
        definition.radius * spot.offset[1],
        definition.radius * spot.offset[2],
      ],
      spot.rotation,
      definition.spotColor,
      environment,
    );
  }

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(definition.radius * 0.7, 18),
    new THREE.MeshBasicMaterial({
      color: 0x60483d,
      transparent: true,
      opacity: 0.13,
      depthWrite: false,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.012;
  // 影子贴在地面上，不进翻滚枢轴，否则蘑菇躺下时影子会立起来。
  visualRoot.add(shadow);

  return {
    root,
    visualRoot,
    length: definition.radius * 2,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: definition.height + 0.48,
    elasticTetherRig: { elasticRoot, stemRoot, capRoot, restLength },
    dropRollRig: { pivotRoot, bodyRoot },
  };
}
