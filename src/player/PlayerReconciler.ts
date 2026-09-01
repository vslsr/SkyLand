import type { PlayerInputStep } from '../network/protocol';
import type { AuthoritativeCharacterState } from '../controllers/TopDownController';

export interface ReconcilerTarget {
  rewindAndReplay(
    authoritative: AuthoritativeCharacterState,
    pendingInputs: readonly PlayerInputStep[],
  ): { replayed: number; residualDistance: number; corrected: boolean; snapped: boolean };
}

export interface PlayerReconciliationResult {
  replayed: number;
  residualDistance: number;
  corrected: boolean;
  snapped: boolean;
}

/** 以服务端状态为起点重放所有未确认固定步；不直接平滑修改逻辑坐标。 */
export class PlayerReconciler {
  private lastAckTick = -1;
  private latestResultValue?: PlayerReconciliationResult;

  public get latestResult(): PlayerReconciliationResult | undefined {
    return this.latestResultValue;
  }

  public reset(): void {
    this.lastAckTick = -1;
    this.latestResultValue = undefined;
  }

  public acceptAuthoritative(
    ackTick: number,
    authoritative: AuthoritativeCharacterState,
    pendingInputs: readonly PlayerInputStep[],
    target: ReconcilerTarget,
  ): boolean {
    const tick = Math.max(0, Math.floor(Number(ackTick) || 0));
    if (tick <= this.lastAckTick) return false;
    this.lastAckTick = tick;
    this.latestResultValue = target.rewindAndReplay(
      authoritative,
      pendingInputs.filter((input) => input.tick > tick),
    );
    return true;
  }
}
