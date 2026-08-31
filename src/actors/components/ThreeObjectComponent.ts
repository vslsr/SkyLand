import * as THREE from 'three';
import { ActorComponent } from '../../../shared/actor/ActorComponent.mjs';
import type {
  AbilityTargetVisualRig,
  ActorSimpleCollision,
  ActorVisualModel,
  ElasticTetherVisualRig,
  LineArtFireVisualRig,
} from '../../models/actors/ActorVisualModel';
import { createSimpleCollisionHelper } from '../../models/actors/createSimpleCollisionHelper';

export const THREE_OBJECT_COMPONENT = 'three-object';
const ACTOR_ROOT_MARKER = 'skylandActorRoot';

function disposeObject(object: THREE.Object3D, ownerRoot: THREE.Object3D): void {
  // 父 Actor 删除但子 Actor 保留时，子 root 可能尚未来得及由渲染 System
  // 重挂到场景根；此处必须剪枝，不能顺带释放另一个 Actor 的资源。
  if (object !== ownerRoot && object.userData[ACTOR_ROOT_MARKER]) return;
  const renderable = object as THREE.Mesh & { material?: THREE.Material | THREE.Material[] };
  renderable.geometry?.dispose();
  if (Array.isArray(renderable.material)) {
    for (const material of renderable.material) material.dispose();
  } else {
    renderable.material?.dispose();
  }
  for (const child of object.children) disposeObject(child, ownerRoot);
}

export class ThreeObjectComponent extends ActorComponent {
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
  private collisionHelper?: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;

  public constructor(model: ActorVisualModel) {
    super(THREE_OBJECT_COMPONENT);
    this.root = model.root;
    this.visualRoot = model.visualRoot;
    this.length = model.length;
    this.width = model.width;
    this.simpleCollision = model.simpleCollision;
    this.interactionAnchorY = model.interactionAnchorY ?? 1.25;
    this.elasticTetherRig = model.elasticTetherRig;
    this.abilityTargetRig = model.abilityTargetRig;
    this.fireVisualRig = model.fireVisualRig;
    this.root.userData[ACTOR_ROOT_MARKER] = true;
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

  public override onEndPlay(): void {
    this.root.parent?.remove(this.root);
    disposeObject(this.root, this.root);
  }
}
