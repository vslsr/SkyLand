import * as THREE from 'three';
import type {
  AbilityTargetVisualRig,
  ActorSimpleCollision,
  ActorVisualModel,
  ElasticTetherVisualRig,
  LineArtFireVisualRig,
  PbfSlimeVisualRig,
} from '../../models/actors/ActorVisualModel';
import { createSimpleCollisionHelper } from '../../models/actors/createSimpleCollisionHelper';
import type { ProxyId } from '../RenderScene';

/**
 * 渲染世界里一个 Actor 网格 proxy 的实体（路线图 §2「FPrimitiveSceneProxy」那一格）。
 *
 * **它没有指向 Actor 的字段，也不知道 Actor 是什么。** 认识它的只有 `ProxyId`。
 * 这是从 `ThreeObjectComponent` 搬过来的那份状态——同样的 Object3D，换了个住处：
 * 从 Actor 上搬到了渲染世界里。
 */
export const PROXY_ROOT_MARKER = 'skylandRenderProxyRoot';

function disposeSubtree(object: THREE.Object3D, ownerRoot: THREE.Object3D): void {
  // 父 proxy 销毁但子 proxy 还活着时，子 root 可能尚未被 submitTransforms 重挂到
  // 世界根；此处必须剪枝，不能顺带释放另一个 proxy 的资源。
  if (object !== ownerRoot && object.userData[PROXY_ROOT_MARKER]) return;
  const renderable = object as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
  renderable.geometry?.dispose();
  if (Array.isArray(renderable.material)) {
    for (const material of renderable.material) material.dispose();
  } else {
    renderable.material?.dispose();
  }
  for (const child of object.children) disposeSubtree(child, ownerRoot);
}

export class ThreeMeshProxy {
  public readonly root: THREE.Group;
  public readonly attachmentVisualRoot = new THREE.Group();
  public readonly visualRoot: THREE.Group;
  public readonly length: number;
  public readonly width: number;
  public readonly simpleCollision: ActorSimpleCollision;
  public readonly interactionAnchorY: number;
  public readonly elasticTetherRig?: ElasticTetherVisualRig;
  public readonly abilityTargetRig?: AbilityTargetVisualRig;
  public readonly fireVisualRig?: LineArtFireVisualRig;
  public readonly pbfSlimeVisualRig?: PbfSlimeVisualRig;
  private collisionHelper?: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;

  public constructor(public readonly id: ProxyId, model: ActorVisualModel) {
    this.root = model.root;
    this.visualRoot = model.visualRoot;
    this.length = model.length;
    this.width = model.width;
    this.simpleCollision = model.simpleCollision;
    this.interactionAnchorY = model.interactionAnchorY ?? 1.25;
    this.elasticTetherRig = model.elasticTetherRig;
    this.abilityTargetRig = model.abilityTargetRig;
    this.fireVisualRig = model.fireVisualRig;
    this.pbfSlimeVisualRig = model.pbfSlimeVisualRig;
    this.root.userData[PROXY_ROOT_MARKER] = true;
    this.attachmentVisualRoot.name = 'actor-attachment-visual-root';
    const visualParent = this.visualRoot.parent ?? this.root;
    visualParent.add(this.attachmentVisualRoot);
    this.attachmentVisualRoot.add(this.visualRoot);
  }

  public get simpleCollisionVisible(): boolean {
    return this.collisionHelper?.visible === true;
  }

  public setSimpleCollisionVisible(visible: boolean): void {
    if (!this.collisionHelper && visible) {
      this.collisionHelper = createSimpleCollisionHelper(this.simpleCollision);
      this.root.add(this.collisionHelper);
    }
    if (this.collisionHelper) this.collisionHelper.visible = visible;
  }

  public dispose(): void {
    this.root.parent?.remove(this.root);
    disposeSubtree(this.root, this.root);
  }
}
