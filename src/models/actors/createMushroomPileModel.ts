import * as THREE from 'three';
import { createSimpleCollisionFromRender } from '../../../shared/actor/simpleCollision.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorRenderDefinition } from '../../scenes/data/SceneDefinition';
import { createOutlinedObject } from '../outlinedObject';
import {
  MUSHROOM_CAP_FLATTEN,
  MUSHROOM_CAP_LIFT,
  MUSHROOM_CAP_SPOTS,
  createMushroomCapGeometry,
  createMushroomStemGeometry,
  mushroomStemLength,
} from './createElasticMushroomModel';
import type { ActorVisualModel } from './ActorVisualModel';

type MushroomPileRender = Extract<ActorRenderDefinition, { model: 'line-art-mushroom-pile' }>;

/**
 * 采下来的弹弹菇：**和世界里长着的那一株是同一个模型**，只是小一号、没有那套
 * 弹性骨架。曾经它借用果子堆的模板，于是拿在手上、掉在地上的「弹弹菇」是一小堆
 * 浆果——名字对不上东西，玩家只会以为自己捡错了。
 *
 * 摆位写死，和其它堆叠物一样：掉落物由 `ThreeHighCountBatchVisual` 统一绘制，
 * 模板必须是确定的一份。
 */
export const MUSHROOM_PILE_PIECES = [
  { offsetX: -0.42, offsetY: 0, offsetZ: -0.20, scale: 1.00, yaw: 0.35 },
  { offsetX: 0.40, offsetY: 0, offsetZ: 0.14, scale: 0.86, yaw: -0.92 },
  { offsetX: 0.04, offsetY: 0, offsetZ: -0.48, scale: 0.72, yaw: 1.42 },
] as const;

/** 一朵蘑菇的三种零件：菌柄、菌盖、盖上的白斑。位置都相对这一朵自己的根。 */
export interface MushroomPart {
  readonly geometry: THREE.BufferGeometry;
  /** 相对这一朵根节点的局部变换。 */
  readonly matrix: THREE.Matrix4;
  readonly part: 'stem' | 'cap' | 'spot';
  /** 描边角度阈值：菌盖是曲面，阈值高一点才不会画满网格线。 */
  readonly edgeThreshold: number;
}

/**
 * 一朵蘑菇拆成可合批的零件。
 *
 * 合批模板只认「几何 + 矩阵 + 颜色」，所以这里把弹性模型里那几层 Group 摊平成
 * 一串矩阵；几何本身仍然来自 `createElasticMushroomModel`，两处不会各长各的。
 */
export function createMushroomParts(radius: number, height: number): MushroomPart[] {
  const stemLength = mushroomStemLength(radius, height);
  const parts: MushroomPart[] = [
    {
      geometry: createMushroomStemGeometry(radius, stemLength),
      matrix: new THREE.Matrix4().setPosition(0, stemLength * 0.5, 0),
      part: 'stem',
      edgeThreshold: 1,
    },
    {
      geometry: createMushroomCapGeometry(radius),
      matrix: new THREE.Matrix4().compose(
        new THREE.Vector3(0, stemLength + radius * MUSHROOM_CAP_LIFT, 0),
        new THREE.Quaternion(),
        new THREE.Vector3(1, MUSHROOM_CAP_FLATTEN, 1),
      ),
      part: 'cap',
      edgeThreshold: 4,
    },
  ];
  for (const spot of MUSHROOM_CAP_SPOTS) {
    parts.push({
      geometry: new THREE.CircleGeometry(radius * spot.scale, 8),
      matrix: new THREE.Matrix4().compose(
        new THREE.Vector3(
          radius * spot.offset[0],
          stemLength + radius * spot.offset[1],
          radius * spot.offset[2],
        ),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...spot.rotation)),
        new THREE.Vector3(1, 1, 1),
      ),
      part: 'spot',
      edgeThreshold: 24,
    });
  }
  return parts;
}

/** 独立预览模型；实际高数量掉落由 ThreeHighCountBatchVisual 合并绘制。 */
export function createMushroomPileModel(
  environment: FillMaterialEnvironment,
  definition: MushroomPileRender,
): ActorVisualModel {
  const root = new THREE.Group();
  const visualRoot = new THREE.Group();
  const outline = new THREE.LineBasicMaterial({ color: definition.inkColor });
  const colors = {
    stem: definition.stemColor,
    cap: definition.capColor,
    spot: definition.spotColor,
  } as const;
  root.add(visualRoot);
  for (const piece of MUSHROOM_PILE_PIECES) {
    const mushroom = new THREE.Group();
    for (const part of createMushroomParts(
      definition.radius * piece.scale,
      definition.height * piece.scale,
    )) {
      const object = createOutlinedObject(
        part.geometry,
        createFillMaterial(colors[part.part], environment),
        part.edgeThreshold,
        outline,
      );
      object.applyMatrix4(part.matrix);
      mushroom.add(object);
    }
    mushroom.rotation.y = piece.yaw;
    mushroom.position.set(
      definition.radius * piece.offsetX,
      definition.height * piece.offsetY,
      definition.radius * piece.offsetZ,
    );
    visualRoot.add(mushroom);
  }
  return {
    root,
    visualRoot,
    length: definition.radius * 2,
    width: definition.radius * 2,
    simpleCollision: createSimpleCollisionFromRender(definition),
    interactionAnchorY: definition.height + 0.4,
  };
}
