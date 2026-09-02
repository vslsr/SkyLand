import type { PhysicsWorld } from '../../shared/physics/PhysicsWorld.mjs';

export interface RemotePlayerColliderShape {
  readonly radius: number;
  readonly height: number;
}

export interface RemotePlayerColliderState {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * 远端玩家在本地物理世界里的形体。
 *
 * 房间进程给每名玩家都建了角色刚体，玩家之间本来就互相阻挡。浏览器这边只有
 * 本地玩家进物理世界，于是预测会直接从别人身上穿过去，再被每一份快照拽回来。
 * 这里按快照插值出的位置维护一组运动学代理，把同一条阻挡规则补进本地预测。
 *
 * 数量跟着房间里的远端玩家走，不随世界面积增长；玩家离开就立刻撤掉代理。
 *
 * 已知近似：代理是被「瞬移」到插值位置的，而角色控制器不会把已经嵌进去的身体
 * 推开。所以理论上代理可能落在本地玩家身上而不把人挤出去——但代理位置来自
 * 权威模拟，那边两名玩家本来就被隔开了一个半径和，真正会发生的重叠只有预测
 * 误差那么大（通常几厘米），随下一份快照的和解一起消掉。
 */
export class RemotePlayerColliders {
  private readonly live = new Set<string>();

  public constructor(
    private readonly physics: PhysicsWorld | undefined,
    private readonly shape: RemotePlayerColliderShape,
  ) {}

  /** 用本帧仍在场的远端玩家整体刷新；缺席的代理在这里被回收。 */
  public sync(states: Iterable<RemotePlayerColliderState>): void {
    if (!this.physics) return;
    const seen = new Set<string>();
    for (const state of states) {
      seen.add(state.id);
      this.live.add(state.id);
      this.physics.setCharacterProxy(state.id, {
        x: state.x,
        y: state.y,
        z: state.z,
        radius: this.shape.radius,
        halfHeight: this.shape.height * 0.5,
      });
    }
    for (const id of this.live) {
      if (seen.has(id)) continue;
      this.physics.removeCharacterProxy(id);
      this.live.delete(id);
    }
  }

  public clear(): void {
    for (const id of this.live) this.physics?.removeCharacterProxy(id);
    this.live.clear();
  }
}
