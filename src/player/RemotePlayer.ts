import * as THREE from 'three';
import { createPlayerSlimeModel, createSlimePalette } from '../models/playerSlime';
import { isSharedGeometry } from '../models/sharedGeometry';
import type { InterpolatedPlayerState } from '../network/protocol';
import { SlimeAnimator } from './SlimeAnimator';

/** 只释放这个物体独占的资源，共用的几何留给别的物体继续使用。 */
function disposeSubtree(root: THREE.Object3D): void {
  root.traverse((object) => {
    const target = object as Partial<THREE.Mesh>;
    if (target.geometry && !isSharedGeometry(target.geometry)) target.geometry.dispose();
    const material = target.material;
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
    else material?.dispose();
  });
}

/** 同房间的另一名玩家：状态全部来自快照插值，本地不做任何模拟。 */
export class RemotePlayer {
  public readonly id: string;
  public name: string;
  private readonly model: ReturnType<typeof createPlayerSlimeModel>;
  private readonly animator: SlimeAnimator;
  private speed = 0;

  public constructor(state: InterpolatedPlayerState) {
    this.id = state.id;
    this.name = state.name;
    this.model = createPlayerSlimeModel(createSlimePalette(state.id));
    this.model.root.name = `remote-player-${state.id}`;
    this.model.root.position.set(state.x, 0, state.z);
    this.model.root.rotation.y = state.yaw;
    this.animator = new SlimeAnimator(this.model);
  }

  public get object3D(): THREE.Object3D {
    return this.model.root;
  }

  public applyState(state: InterpolatedPlayerState): void {
    this.name = state.name;
    // 位置与朝向都已经在 SnapshotBuffer 里按渲染时间插值过，这里直接落到模型上。
    this.model.root.position.set(state.x, 0, state.z);
    this.model.root.rotation.y = state.yaw;
    this.speed = state.speed;
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.animator.update(deltaSeconds, elapsedSeconds, this.speed);
  }

  public dispose(): void {
    this.model.root.parent?.remove(this.model.root);
    disposeSubtree(this.model.root);
  }
}
