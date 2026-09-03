import * as THREE from 'three';
import type {
  AbilityTargetVisualRig,
  ActorSimpleCollision,
  ActorVisualModel,
  DropRollVisualRig,
  ElasticTetherVisualRig,
  LineArtFireVisualRig,
  PbfSlimeVisualRig,
} from '../../models/actors/ActorVisualModel';
import { createSimpleCollisionHelper } from '../../models/actors/createSimpleCollisionHelper';
import { releaseOwnResources } from '../renderAssets';
import { ThreeActorMarkers } from './ThreeActorMarkers';
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
  // 轮廓线材质是全进程共享的：删一个 Actor 就把它 dispose 掉，会让每次拾取、
  // 每次物件消失都触发一次着色器重编译（路线图 §8.2）。
  releaseOwnResources(object);
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
  public readonly dropRollRig?: DropRollVisualRig;
  public readonly abilityTargetRig?: AbilityTargetVisualRig;
  public readonly fireVisualRig?: LineArtFireVisualRig;
  public readonly pbfSlimeVisualRig?: PbfSlimeVisualRig;
  private collisionHelper?: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  /** 交互标记与温度牌。挂在权威 root 上，不随 visualRoot 的波动摇晃。 */
  public readonly markers: ThreeActorMarkers;

  public constructor(public readonly id: ProxyId, model: ActorVisualModel) {
    this.root = model.root;
    this.visualRoot = model.visualRoot;
    this.length = model.length;
    this.width = model.width;
    this.simpleCollision = model.simpleCollision;
    this.interactionAnchorY = model.interactionAnchorY ?? 1.25;
    this.elasticTetherRig = model.elasticTetherRig;
    this.dropRollRig = model.dropRollRig;
    this.abilityTargetRig = model.abilityTargetRig;
    this.fireVisualRig = model.fireVisualRig;
    this.pbfSlimeVisualRig = model.pbfSlimeVisualRig;
    this.root.userData[PROXY_ROOT_MARKER] = true;
    this.markers = new ThreeActorMarkers(this.root);
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

  /** 温度牌挂在 simpleCollision 的右侧外沿——这段算术本来就产在渲染侧。 */
  public get temperatureAnchorX(): number {
    return this.simpleCollision.centerX + this.simpleCollision.halfWidth + 0.42;
  }

  public dispose(): void {
    this.root.parent?.remove(this.root);
    // 标记先释放：它们的 canvas 纹理不在 disposeSubtree 的覆盖范围内，
    // 而且必须在遍历走到它们的子树之前把自己摘下来（原来靠 Component 的
    // 逆序 endPlay 保证，现在由这一行显式保证）。
    this.markers.dispose();
    disposeSubtree(this.root, this.root);
  }
}
