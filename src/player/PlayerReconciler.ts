import {
  RECONCILE_RATE,
  RECONCILE_SNAP_DISTANCE,
  RECONCILE_TOLERANCE,
} from '../../shared/networkTuning.mjs';

interface PredictionSample {
  sequence: number;
  x: number;
  y?: number;
  z: number;
}

export interface ReconcilerTarget {
  readonly position: { x: number; z: number };
  readonly verticalPosition?: number;
  translate(deltaX: number, deltaZ: number): void;
  translateVertical?(deltaY: number): void;
  setPosition(x: number, z: number): void;
  setVerticalPosition?(y: number): void;
  /** 瞬移之后重置随位置累积的本地状态，例如已经收起来的相机悬臂。 */
  resetCamera?(): void;
}

const HISTORY_LIMIT = 64;

/**
 * 本地预测与服务器权威位置的和解。
 *
 * 客户端按渲染帧率立刻响应自己的输入，并记下每条上行输入发出时的预测位置。
 * 服务器回包带着它确认到的序号，把当时的预测和权威结果一比就得到误差：
 * 误差很小就忽略，正常范围内按指数收敛慢慢拉回，大到明显异常（作弊、
 * 长时间丢包）就直接瞬移，保证服务器说了算。
 */
export class PlayerReconciler {
  private readonly history: PredictionSample[] = [];
  private pendingX = 0;
  private pendingY = 0;
  private pendingZ = 0;

  public reset(): void {
    this.history.length = 0;
    this.pendingX = 0;
    this.pendingY = 0;
    this.pendingZ = 0;
  }

  /** 发出一条输入之后，记录此刻的预测位置。 */
  public recordPrediction(sequence: number, x: number, z: number, y?: number): void {
    this.history.push({ sequence, x, y, z });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
  }

  /** 收到快照里属于自己的那条记录时调用。 */
  public acceptAuthoritative(
    sequence: number,
    x: number,
    z: number,
    target: ReconcilerTarget,
    y?: number,
  ): boolean {
    const sample = this.takeSample(sequence);
    if (!sample) return false;

    const errorX = x - sample.x;
    const hasVerticalAuthority = Number.isFinite(y)
      && Number.isFinite(sample.y)
      && Number.isFinite(target.verticalPosition)
      && target.setVerticalPosition !== undefined;
    const errorY = hasVerticalAuthority ? y! - sample.y! : 0;
    const errorZ = z - sample.z;
    const distance = Math.hypot(errorX, errorY, errorZ);

    if (distance > RECONCILE_SNAP_DISTANCE) {
      const currentX = target.position.x;
      const currentY = target.verticalPosition;
      const currentZ = target.position.z;
      target.setPosition(x, z);
      if (hasVerticalAuthority) target.setVerticalPosition?.(y!);
      // 瞬移可能跨过好几个 chunk，上一处收起来的悬臂长度在新位置没有意义。
      target.resetCamera?.();
      this.shiftHistory(
        target.position.x - currentX,
        target.position.z - currentZ,
        hasVerticalAuthority ? (target.verticalPosition ?? currentY!) - currentY! : 0,
      );
      this.pendingX = 0;
      this.pendingY = 0;
      this.pendingZ = 0;
      return true;
    }

    // 误差始终相对同一个参照系测量（历史已经跟着纠正一起平移过），
    // 所以这里是覆盖而不是累加。
    if (distance > RECONCILE_TOLERANCE) {
      this.pendingX = errorX;
      this.pendingY = errorY;
      this.pendingZ = errorZ;
    } else {
      this.pendingX = 0;
      this.pendingY = 0;
      this.pendingZ = 0;
    }
    return true;
  }

  /** 每帧把还没消化的误差按指数收敛地喂给玩家位置。 */
  public update(deltaSeconds: number, target: ReconcilerTarget): void {
    if (Math.hypot(this.pendingX, this.pendingY, this.pendingZ) < 0.0005) {
      this.pendingX = 0;
      this.pendingY = 0;
      this.pendingZ = 0;
      return;
    }

    const amount = 1 - Math.exp(-RECONCILE_RATE * deltaSeconds);
    const stepX = this.pendingX * amount;
    const stepY = this.pendingY * amount;
    const stepZ = this.pendingZ * amount;
    const beforeX = target.position.x;
    const beforeY = target.verticalPosition;
    const beforeZ = target.position.z;
    target.translate(stepX, stepZ);
    if (beforeY !== undefined) target.translateVertical?.(stepY);

    // 位置可能被活动范围截断，按实际生效的位移推进历史与剩余误差。
    const appliedX = target.position.x - beforeX;
    const appliedY = beforeY !== undefined ? (target.verticalPosition ?? beforeY) - beforeY : 0;
    const appliedZ = target.position.z - beforeZ;
    this.shiftHistory(appliedX, appliedZ, appliedY);
    this.pendingX -= appliedX;
    this.pendingY -= appliedY;
    this.pendingZ -= appliedZ;
  }

  /** 取出服务器确认到的那条预测，并丢弃更早的历史。 */
  private takeSample(sequence: number): PredictionSample | undefined {
    let found: PredictionSample | undefined;
    while (this.history.length > 0 && this.history[0].sequence <= sequence) {
      found = this.history.shift();
    }
    return found;
  }

  private shiftHistory(deltaX: number, deltaZ: number, deltaY = 0): void {
    for (const sample of this.history) {
      sample.x += deltaX;
      if (sample.y !== undefined) sample.y += deltaY;
      sample.z += deltaZ;
    }
  }
}
