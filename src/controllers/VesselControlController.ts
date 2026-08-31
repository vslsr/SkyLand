import { INPUT_SEND_INTERVAL_SECONDS } from '../../shared/networkTuning.mjs';
import { PlayerInputTags } from '../input/config/playerInput';
import type { InputSubsystem } from '../input/core/InputSubsystem';

export interface VesselControlPort {
  getPlayerId(): string | undefined;
  findOwnedActorId(playerId: string): string | undefined;
  findControllableActorId(): string | undefined;
  requestControl(actorId: string): void;
  releaseControl(actorId: string): void;
  sendInput(actorId: string, input: { throttle: number; steering: number }): void;
}

/** 把输入标签转换成控制权命令和定频船舶意图，不参与权威运动计算。 */
export class VesselControlController {
  private timeSinceInputSent = 0;
  private readonly disposeInteractBinding: () => void;

  public constructor(
    private readonly input: InputSubsystem,
    private readonly port: VesselControlPort,
  ) {
    this.disposeInteractBinding = input.bind(
      PlayerInputTags.Interact,
      () => this.toggleControl(),
      { phases: ['triggered'] },
    );
  }

  public update(deltaSeconds: number): void {
    const playerId = this.port.getPlayerId();
    const actorId = playerId ? this.port.findOwnedActorId(playerId) : undefined;
    if (!actorId) {
      this.timeSinceInputSent = 0;
      return;
    }
    this.timeSinceInputSent += deltaSeconds;
    if (this.timeSinceInputSent < INPUT_SEND_INTERVAL_SECONDS) return;
    this.timeSinceInputSent = 0;
    const move = this.input.getAxis2D(PlayerInputTags.VesselMove);
    this.port.sendInput(actorId, { throttle: move.y, steering: move.x });
  }

  public reset(): void {
    this.timeSinceInputSent = 0;
  }

  public dispose(): void {
    this.disposeInteractBinding();
  }

  private toggleControl(): void {
    const playerId = this.port.getPlayerId();
    if (!playerId) return;
    const ownedActorId = this.port.findOwnedActorId(playerId);
    if (ownedActorId) {
      this.port.releaseControl(ownedActorId);
      return;
    }
    const candidate = this.port.findControllableActorId();
    if (candidate) this.port.requestControl(candidate);
  }
}
