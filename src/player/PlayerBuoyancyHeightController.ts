import * as THREE from 'three';

/**
 * 本地玩家的权威浮力高度平滑器。
 *
 * 服务端快照给目标 Y；客户端只平滑这个已批准的偏移，不自行扩大玩法高度。
 * 状态固定为两个数字，每帧 O(1)，快速离开水域时立即把目标收回地面。
 */
export class PlayerBuoyancyHeightController {
  private currentOffset = 0;
  private targetOffset = 0;

  public constructor(
    private readonly root: THREE.Object3D,
    private readonly sampleBaseHeight: (x: number, z: number) => number,
    private readonly maximumAmplitude: number,
  ) {}

  public sampleHeight = (x: number, z: number): number => (
    this.sampleBaseHeight(x, z) + this.currentOffset
  );

  public get offset(): number {
    return this.currentOffset;
  }

  public setAuthoritativeHeight(x: number, z: number, y: number): void {
    if (!Number.isFinite(y)) return;
    const offset = y - this.sampleBaseHeight(x, z);
    this.targetOffset = THREE.MathUtils.clamp(
      offset,
      -this.maximumAmplitude,
      this.maximumAmplitude,
    );
  }

  public update(deltaSeconds: number, inWater: boolean, grounded = true): void {
    // 跳跃拥有空中 Y；浮力只提供落地/水面支撑，不能把空中角色吸回水面。
    if (!grounded) return;
    if (!inWater) this.targetOffset = 0;
    const amount = deltaSeconds > 0 ? 1 - Math.exp(-14 * deltaSeconds) : 1;
    this.currentOffset = THREE.MathUtils.lerp(
      this.currentOffset,
      this.targetOffset,
      amount,
    );
    this.root.position.y = this.sampleHeight(this.root.position.x, this.root.position.z);
  }
}
