import * as THREE from 'three';
import {
  fruitDropWorldPosition,
  selectFruitDropAnchors,
} from '../../../shared/world/fruitDrop.mjs';
import {
  FRUIT_COUNT,
  FRUIT_SCALE,
  FRUIT_X,
  FRUIT_Y,
  FRUIT_YAW,
  FRUIT_Z,
} from '../fruitInstanceLayout';
import type { RenderInstanceBuffer } from '../RenderInstanceBuffer';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';

const FRUIT_RADIUS = 0.14;

function nextCapacity(required: number): number {
  let capacity = 32;
  while (capacity < required) capacity *= 2;
  return capacity;
}

/**
 * 可再生物件的果子。
 *
 * 果子**不进 chunk 合批**：合批器只能按放置记录里的 kind 选模板，没有逐实例的
 * 状态通道，要让「同一棵树有果子/没果子」两种外观就得改 WASM 的 ABI。而果子
 * 本来就是挂在树上的一层薄东西，客户端拿已有的派生 Actor 单独铺一层实例化网格
 * 更简单，代价是每帧多两次绘制。
 *
 * 「长回来」不需要服务端再发一条快照：`readyAt` 是绝对服务端时间，这里每帧拿
 * 换算过的服务端时钟比一次就知道熟没熟，顺带把交互提示也开关掉。
 */
export class ThreeFruitBatchVisual {
  public readonly root = new THREE.Group();
  private readonly fillGeometry: THREE.SphereGeometry;
  private readonly fillMaterial: THREE.Material;
  private readonly outlineMaterial: THREE.LineBasicMaterial;
  private readonly baseOutlinePositions: Float32Array;
  private readonly outline: THREE.LineSegments;
  private fill: THREE.InstancedMesh;
  private capacity = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly point = new THREE.Vector3();
  private signature = '';
  /** 借给 `fruitDropWorldPosition` 的树姿态，逐棵改字段而不是每棵新建。 */
  private readonly treePose = { x: 0, y: 0, z: 0, yaw: 0 };

  public constructor(
    environment: FillMaterialEnvironment,
    color: THREE.ColorRepresentation = 0xd4694f,
    inkColor: THREE.ColorRepresentation = 0x5c2f26,
  ) {
    this.root.name = 'generated-prop-fruit';
    this.fillGeometry = new THREE.SphereGeometry(FRUIT_RADIUS, 6, 4);
    this.fillMaterial = createFillMaterial(color, environment);
    this.outlineMaterial = new THREE.LineBasicMaterial({ color: inkColor });
    const edges = new THREE.EdgesGeometry(this.fillGeometry, 24);
    this.baseOutlinePositions = new Float32Array(
      (edges.getAttribute('position') as THREE.BufferAttribute).array,
    );
    edges.dispose();
    this.outline = new THREE.LineSegments(new THREE.BufferGeometry(), this.outlineMaterial);
    this.outline.frustumCulled = false;
    this.fill = new THREE.InstancedMesh(this.fillGeometry, this.fillMaterial, 0);
    this.fill.frustumCulled = false;
    this.root.add(this.fill, this.outline);
  }

  /**
   * 从果实实例通道重建这一帧的果子（实现路径文档 §3）。
   *
   * 这里以前直接扫 `ActorWorld`，还顺手改 `interactable.enabled`——一个渲染系统
   * 在写玩法状态。现在输入只是一串「树在哪、多大、结几个」，判熟和开关交互提示
   * 都留在 `ActorFruitInstanceSystem` 那一侧。
   *
   * 挂在哪几个枝头由这里按 `selectFruitDropAnchors` 自己推：那份锚点表本来就是
   * 两端共用的（服务端采摘后也照它抛），没必要再摊进字节里传一遍。
   */
  public sync(instances: RenderInstanceBuffer): void {
    this.update(instances);
  }

  /** 当前画出来的果子数。为 0 时调用方可以不把这一层挂进场景。 */
  public get instanceCount(): number {
    return this.fill.count;
  }

  public dispose(): void {
    this.fill.dispose();
    this.fillGeometry.dispose();
    this.fillMaterial.dispose();
    this.outline.geometry.dispose();
    this.outlineMaterial.dispose();
    this.root.parent?.remove(this.root);
  }

  private update(instances: RenderInstanceBuffer): void {
    let signature = '';
    let required = 0;
    for (let index = 0; index < instances.count; index += 1) {
      const count = instances.readFloat(index, FRUIT_COUNT);
      signature += `${instances.readFloat(index, FRUIT_X).toFixed(2)},`
        + `${instances.readFloat(index, FRUIT_Z).toFixed(2)},${count}|`;
      required += selectFruitDropAnchors(count).length;
    }
    if (signature === this.signature) return;
    this.signature = signature;

    if (required > this.capacity) {
      this.root.remove(this.fill);
      this.fill.dispose();
      this.capacity = nextCapacity(required);
      this.fill = new THREE.InstancedMesh(this.fillGeometry, this.fillMaterial, this.capacity);
      this.fill.frustumCulled = false;
      this.root.add(this.fill);
    }
    this.fill.count = required;
    const source = this.baseOutlinePositions;
    const outlinePositions = new Float32Array(source.length * required);
    let instance = 0;
    let output = 0;
    for (let index = 0; index < instances.count; index += 1) {
      const scale = instances.readFloat(index, FRUIT_SCALE);
      // fruitDropWorldPosition 要的就是这四个字段，直接借这个对象喂进去。
      this.treePose.x = instances.readFloat(index, FRUIT_X);
      this.treePose.y = instances.readFloat(index, FRUIT_Y);
      this.treePose.z = instances.readFloat(index, FRUIT_Z);
      this.treePose.yaw = instances.readFloat(index, FRUIT_YAW);
      for (const anchor of selectFruitDropAnchors(instances.readFloat(index, FRUIT_COUNT))) {
        const position = fruitDropWorldPosition(this.treePose, scale, anchor);
        this.position.set(position.x, position.y, position.z);
        this.scale.setScalar(scale);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        this.fill.setMatrixAt(instance, this.matrix);
        instance += 1;
        for (let offset = 0; offset < source.length; offset += 3) {
          this.point
            .set(source[offset], source[offset + 1], source[offset + 2])
            .applyMatrix4(this.matrix);
          outlinePositions[output++] = this.point.x;
          outlinePositions[output++] = this.point.y;
          outlinePositions[output++] = this.point.z;
        }
      }
    }
    this.fill.instanceMatrix.needsUpdate = true;
    this.outline.geometry.dispose();
    this.outline.geometry = new THREE.BufferGeometry();
    this.outline.geometry.setAttribute('position', new THREE.BufferAttribute(outlinePositions, 3));
    this.outline.geometry.computeBoundingSphere();
  }
}
