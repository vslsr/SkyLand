import type { CameraFrame } from '../camera/CameraTransform';
import { PlayerInputTags } from '../input/config/playerInput';
import type { InputSubsystem } from '../input/core/InputSubsystem';
import type { ActorInteractionCandidate } from '../scene/SceneVisualSystem';

export interface ActorInteractionPort {
  getPlayerId(): string | undefined;
  findOwnedActorId(playerId: string): string | undefined;
  pick(frame: CameraFrame): ActorInteractionCandidate | undefined;
  setHoveredActorId(actorId?: string): void;
  sendInteraction(actorId: string): void;
  setPrompt(text?: string): void;
}

/** 准星选择只负责意图和提示，装卸距离与所有权仍由 DS 判定。 */
export class ActorInteractionController {
  private candidate?: ActorInteractionCandidate;
  private interactionRequested = false;
  private readonly disposeBinding: () => void;

  public constructor(
    private readonly input: InputSubsystem,
    private readonly port: ActorInteractionPort,
  ) {
    this.disposeBinding = input.bind(
      PlayerInputTags.WorldInteract,
      () => { this.interactionRequested = true; },
      { phases: ['triggered'] },
    );
  }

  public update(frame: CameraFrame): void {
    if (!this.input.enabled) {
      this.clearSelection();
      return;
    }
    this.candidate = this.port.pick(frame);
    this.port.setHoveredActorId(this.candidate?.actorId);
    const playerId = this.port.getPlayerId();
    const vesselId = playerId ? this.port.findOwnedActorId(playerId) : undefined;
    const prompt = this.resolvePrompt(this.candidate, vesselId);
    this.port.setPrompt(prompt);
    if (this.interactionRequested && this.candidate && vesselId) {
      const carrierId = this.candidate.carrierActorId;
      if (!carrierId || carrierId === vesselId) {
        this.port.sendInteraction(this.candidate.actorId);
      }
    }
    this.interactionRequested = false;
  }

  public reset(): void {
    this.interactionRequested = false;
    this.clearSelection();
  }

  public dispose(): void {
    this.reset();
    this.disposeBinding();
  }

  private resolvePrompt(
    candidate: ActorInteractionCandidate | undefined,
    vesselId: string | undefined,
  ): string | undefined {
    if (!candidate) return undefined;
    if (!vesselId) return `先按 F 接管木筏，再装载「${candidate.label}」`;
    if (!candidate.carrierActorId) return `E · 装载「${candidate.label}」`;
    if (candidate.carrierActorId === vesselId) return `E · 卸载「${candidate.label}」`;
    return `「${candidate.label}」已被其他木筏装载`;
  }

  private clearSelection(): void {
    this.candidate = undefined;
    this.port.setHoveredActorId(undefined);
    this.port.setPrompt(undefined);
  }
}
