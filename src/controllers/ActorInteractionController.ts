import { resolveActorAction } from '../../shared/actor/index.mjs';
import type { CameraFrame } from '../camera/CameraTransform';
import { PlayerInputTags } from '../input/config/playerInput';
import type { InputSubsystem } from '../input/core/InputSubsystem';
import { InteractionPromptFade } from '../interaction/InteractionPromptFade';
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
  /** `opacity` 是提示的淡入淡出进度，和 HUD 那条文字共用一个值。 */
  setInteractionMarkerActorId?(actorId?: string, inputLabel?: string, opacity?: number): void;
  sendInteraction(actorId: string): void;
  setPrompt(text?: string, opacity?: number): void;
  /** 正咬着别人；这时交互键说的是「松口」。 */
  isBiting?(): boolean;
  /** 咬住 / 松口。目标由服务端按权威位姿判定，这里不指定。 */
  sendBite?(): void;
}

/** 准星选择只负责意图和提示，装卸距离与所有权仍由 DS 判定。 */
export class ActorInteractionController {
  private candidate?: ActorInteractionCandidate;
  private interactionRequested = false;
  private readonly promptFade = new InteractionPromptFade();
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

  /**
   * `deltaSeconds` 只用于提示的淡入淡出；省略时提示停在当前状态，交互判定不受影响。
   */
  public update(frame: CameraFrame, deltaSeconds = 0): void {
    if (!this.input.enabled) {
      this.clearSelection();
      return;
    }
    // 提示只在玩家停手之后现身。界面操作不算：CommonUI 一开就把整个输入关掉，
    // 上面那条早退已经先把提示清干净了，这里读到的永远是游戏层的操作。
    const promptOpacity = this.promptFade.update(deltaSeconds, this.input.hasActiveInput);
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
      promptOpacity,
    );
    const vesselId = playerId ? this.port.findOwnedActorId(playerId) : undefined;
    const prompt = this.resolvePrompt(this.candidate, vesselId, playerId);
    this.port.setPrompt(prompt, promptOpacity);
    // 咬着人的时候交互键先归松口，和「手上已经有一株」同一条规矩：
    // 一个已经建立的持续状态必须有一个确定的退出入口。
    if (this.interactionRequested && this.port.isBiting?.()) {
      this.port.sendBite?.();
      this.interactionRequested = false;
      return;
    }
    if (this.interactionRequested && this.candidate) {
      // 发不发由动作表说了算，和上面那句提示是同一个判定——不再各写一遍。
      const action = resolveActorAction(
        this.toActionTarget(this.candidate),
        { playerId, controlledActorId: vesselId },
      );
      if (action && !action.blocked) this.port.sendInteraction(this.candidate.actorId);
    } else if (this.interactionRequested && playerId) {
      // 没有任何候选可按时，交互键落到彩蛋上：咬面前的人。它排在最后，所以永远
      // 抢不走正经交互；也不出提示、不出标记，找得到才有反应，是个藏着的动作。
      this.port.sendBite?.();
    }
    this.interactionRequested = false;
  }

  public reset(): void {
    this.interactionRequested = false;
    this.promptFade.reset();
    this.clearSelection();
  }

  public dispose(): void {
    this.reset();
    this.disposeBinding();
  }

  /**
   * 候选 Actor 的复制态转成动作表认识的形状。
   *
   * `enabled` 一律给 true：就近搜索本来就滤掉了关着的，而手上那件虽然是关着的，
   * 却由动作表的第一支（「手上那件压过所有分支」）接住，不看这个字段。
   */
  private toActionTarget(candidate: ActorInteractionCandidate) {
    return {
      actorId: candidate.actorId,
      label: candidate.label,
      action: candidate.action,
      enabled: true,
      quantity: candidate.quantity,
      carrierActorId: candidate.carrierActorId,
      holderPlayerId: candidate.holderPlayerId,
      pickupHolderActorId: candidate.pickupHolderActorId,
      containerOpen: candidate.containerOpen,
    };
  }

  private resolvePrompt(
    candidate: ActorInteractionCandidate | undefined,
    vesselId: string | undefined,
    playerId: string | undefined,
  ): string | undefined {
    if (!candidate) return undefined;
    const action = resolveActorAction(
      this.toActionTarget(candidate),
      { playerId, controlledActorId: vesselId },
    );
    if (!action) return undefined;
    if (action.blocked) {
      // 挡下的动作不挂交互键——挂了等于告诉玩家按下去会有反应。但如果差的只是一个
      // 前置动作，就把「去按哪个键」补上：动作表只报缺什么，键位在这一层才知道。
      if (action.requires === 'vessel-control') {
        const label = this.port.getInputLabel(PlayerInputTags.Interact);
        return label ? action.verb.replace('先接管木筏', `先按 ${label} 接管木筏`) : action.verb;
      }
      return action.verb;
    }
    return this.withInputLabel(
      this.port.getInputLabel(PlayerInputTags.WorldInteract),
      action.verb,
    );
  }

  private withInputLabel(label: string | undefined, action: string): string {
    return label ? `${label} · ${action}` : `当前设备未绑定交互 · ${action}`;
  }

  private clearSelection(): void {
    this.candidate = undefined;
    this.port.setHoveredActorId(undefined);
    this.port.setInteractionMarkerActorId?.(undefined, undefined, this.promptFade.opacity);
    this.port.setPrompt(undefined, this.promptFade.opacity);
  }
}
