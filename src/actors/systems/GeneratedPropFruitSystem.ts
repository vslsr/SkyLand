import * as THREE from 'three';
import {
  GENERATED_PROP_COMPONENT,
  INTERACTABLE_COMPONENT,
  TRANSFORM_COMPONENT,
  type Actor,
  type ActorWorld,
  type GeneratedPropComponent,
  type InteractableComponent,
  type TransformComponent,
} from '../../../shared/actor/index.mjs';
import {
  fruitDropWorldPosition,
  selectFruitDropAnchors,
} from '../../../shared/world/fruitDrop.mjs';
import { createFillMaterial, type FillMaterialEnvironment } from '../../materials/createFillMaterial';
import type { ActorArchetypeDefinition } from '../../scenes/data/SceneDefinition';

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
export class GeneratedPropFruitSystem {
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

  public constructor(
    environment: FillMaterialEnvironment,
    private readonly archetypes: ReadonlyMap<string, ActorArchetypeDefinition>,
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
   * @param world 客户端 Actor 世界
   * @param serverSeconds 换算过的服务端秒数；还没收到快照时传 undefined，
   *   那时一律按「熟了」处理，避免刚进场的一瞬间满树果子闪一下才出现。
   */
  public sync(world: ActorWorld, serverSeconds?: number): void {
    const ready: Array<{ transform: TransformComponent; scale: number; fruitCount: number }> = [];
    for (const actor of world.query(TRANSFORM_COMPONENT, GENERATED_PROP_COMPONENT) as Actor[]) {
      const prop = actor.requireComponent(GENERATED_PROP_COMPONENT) as GeneratedPropComponent;
      if (
        !this.archetypes.get(actor.archetypeId)?.components.generatedProp?.regrow
        || prop.dropSpawnPattern !== 'fruit-anchors'
      ) continue;
      const isReady = serverSeconds === undefined || prop.isReady(serverSeconds);
      // 冷却中的树没有可采的东西，交互提示也跟着关掉。
      const interactable = actor.getComponent(INTERACTABLE_COMPONENT) as
        | InteractableComponent
        | undefined;
      if (interactable) interactable.enabled = isReady;
      if (!isReady) continue;
      ready.push({
        transform: actor.requireComponent(TRANSFORM_COMPONENT) as TransformComponent,
        scale: prop.scale,
        fruitCount: prop.dropQuantity,
      });
    }
    this.update(ready);
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

  private update(
    trees: ReadonlyArray<{ transform: TransformComponent; scale: number; fruitCount: number }>,
  ): void {
    const signature = trees
      .map((tree) => `${tree.transform.x.toFixed(2)},${tree.transform.z.toFixed(2)},${tree.fruitCount}`)
      .join('|');
    if (signature === this.signature) return;
    this.signature = signature;

    const required = trees.reduce(
      (total, tree) => total + selectFruitDropAnchors(tree.fruitCount).length,
      0,
    );
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
    for (const tree of trees) {
      const { transform } = tree;
      for (const anchor of selectFruitDropAnchors(tree.fruitCount)) {
        const position = fruitDropWorldPosition(transform, tree.scale, anchor);
        this.position.set(position.x, position.y, position.z);
        this.scale.setScalar(tree.scale);
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
