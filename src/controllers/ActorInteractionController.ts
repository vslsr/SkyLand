import type { CameraFrame } from '../camera/CameraTransform';
import { PlayerInputTags } from '../input/config/playerInput';
import type { InputSubsystem } from '../input/core/InputSubsystem';
import type { ActorInteractionCandidate } from '../scene/SceneVisualSystem';
import type { TagLike } from '../tags';

export interface ActorInteractionPort {
  getPlayerId(): string | undefined;
  getPlayerPosition?(): { x: number; z: number } | undefined;
  findOwnedActorId(playerId: string): string | undefined;
  pick(frame: CameraFrame): ActorInteractionCandidate | undefined;
  findNearby?(position: { x: number; z: number }): ActorInteractionCandidate | undefined;
  findHeld?(playerId: string): ActorInteractionCandidate | undefined;
  getInputLabel(tag: TagLike): string | undefined;
  setHoveredActorId(actorId?: string): void;
  setInteractionMarkerActorId?(actorId?: string, inputLabel?: string): void;
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
    const playerId = this.port.getPlayerId();
    const playerPosition = this.port.getPlayerPosition?.();
    const usesProximity = playerPosition !== undefined;
    // 手上已经有一株时，交互键说的是「放下」或「松开」，指向的永远是它自己：
    // 拉着的那株可能已经被拖出就近搜索半径，叼着的那株 interactable 是关的。
    const held = playerId ? this.port.findHeld?.(playerId) : undefined;
    this.candidate = held ?? (playerPosition
      ? this.port.findNearby?.(playerPosition)
      : this.port.pick(frame));
    this.port.setHoveredActorId(usesProximity ? undefined : this.candidate?.actorId);
    const worldInteractionLabel = this.port.getInputLabel(PlayerInputTags.WorldInteract);
    this.port.setInteractionMarkerActorId?.(
      usesProximity && this.candidate?.action === 'mushroom-bite' && worldInteractionLabel
        ? this.candidate.actorId
        : undefined,
      worldInteractionLabel,
    );
    const vesselId = playerId ? this.port.findOwnedActorId(playerId) : undefined;
    const prompt = this.resolvePrompt(this.candidate, vesselId, playerId);
    this.port.setPrompt(prompt);
    if (this.interactionRequested && this.candidate) {
      if (this.candidate.action === 'pickup-stack' || this.candidate.action === 'harvest-prop') {
        if (playerId) this.port.sendInteraction(this.candidate.actorId);
      } else if (this.candidate.action === 'mushroom-bite') {
        // 手上那一株一律放行：服务端按状态分派成放下或取消。别人手上的不行。
        const mine = this.candidate === held;
        if (playerId && (mine || !this.candidate.holderPlayerId)) {
          this.port.sendInteraction(this.candidate.actorId);
        }
      } else if (vesselId) {
        const carrierId = this.candidate.carrierActorId;
        if (!carrierId || carrierId === vesselId) {
          this.port.sendInteraction(this.candidate.actorId);
        }
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
    playerId: string | undefined,
  ): string | undefined {
    if (!candidate) return undefined;
    if (candidate.action === 'pickup-stack') {
      const quantity = candidate.quantity ? ` ×${candidate.quantity}` : '';
      return this.withInputLabel(
        this.port.getInputLabel(PlayerInputTags.WorldInteract),
        `拾取「${candidate.label}${quantity}」`,
      );
    }
    if (candidate.action === 'harvest-prop') {
      return this.withInputLabel(
        this.port.getInputLabel(PlayerInputTags.WorldInteract),
        `砍伐「${candidate.label}」`,
      );
    }
    if (candidate.action === 'mushroom-bite') {
      if (playerId && candidate.pickupHolderActorId === playerId) {
        return this.withInputLabel(
          this.port.getInputLabel(PlayerInputTags.WorldInteract),
          `放下「${candidate.label}」`,
        );
      }
      if (playerId && candidate.holderPlayerId === playerId) {
        return this.withInputLabel(
          this.port.getInputLabel(PlayerInputTags.WorldInteract),
          `松开「${candidate.label}」`,
        );
      }
      if (!candidate.holderPlayerId) {
        return this.withInputLabel(
          this.port.getInputLabel(PlayerInputTags.WorldInteract),
          `叼住「${candidate.label}」`,
        );
      }
      return `「${candidate.label}」正被叼住`;
    }
    if (!vesselId) {
      const label = this.port.getInputLabel(PlayerInputTags.Interact);
      return label
        ? `先按 ${label} 接管木筏，再装载「${candidate.label}」`
        : `请先接管木筏，再装载「${candidate.label}」`;
    }
    if (!candidate.carrierActorId) {
      return this.withInputLabel(
        this.port.getInputLabel(PlayerInputTags.WorldInteract),
        `装载「${candidate.label}」`,
      );
    }
    if (candidate.carrierActorId === vesselId) {
      return this.withInputLabel(
        this.port.getInputLabel(PlayerInputTags.WorldInteract),
        `卸载「${candidate.label}」`,
      );
    }
    return `「${candidate.label}」已被其他木筏装载`;
  }

  private withInputLabel(label: string | undefined, action: string): string {
    return label ? `${label} · ${action}` : `当前设备未绑定交互 · ${action}`;
  }

  private clearSelection(): void {
    this.candidate = undefined;
    this.port.setHoveredActorId(undefined);
    this.port.setInteractionMarkerActorId?.(undefined);
    this.port.setPrompt(undefined);
  }
}
