import {
  HotbarSlotTags,
  ItemUseInputTags,
  PlayerInputTags,
} from '../input/config/playerInput';
import type { InputSubsystem } from '../input/core/InputSubsystem';
import type { InventoryModelLike } from '../inventory/index';
import type { InventoryCommand } from '../network/messages';
import { chargeRatio, resolveHeldItemAction } from '../../shared/actor/index.mjs';

/** 界面要画的那两圈进度；没有正在进行的按住时是 undefined。 */
export interface HeldItemProgress {
  /** `charge` 是使用蓄力，`stow` 是交互键长按收回背包。 */
  readonly kind: 'charge' | 'stow';
  /** [0, 1]。到 1 表示服务端也认为满了。 */
  readonly ratio: number;
  readonly label: string;
}

export interface HotbarPort {
  getInventory(): InventoryModelLike | undefined;
  /** 现在能不能操作：界面盖着或没进房间时不能。 */
  isActive(): boolean;
  send(command: InventoryCommand): void;
  /** 每帧把进度交给界面；undefined 表示收掉那两圈。 */
  setProgress(progress: HeldItemProgress | undefined): void;
}

/** 一次还没结束的按住。 */
interface PendingHold {
  readonly kind: 'charge' | 'stow';
  readonly startedAt: number;
  readonly durationSeconds: number;
  readonly label: string;
}

/**
 * 快捷栏与手持物的输入层。
 *
 * 它只做三件事：把按键翻译成意图、把按住的时长翻译成给玩家看的进度、在状态变化时
 * 取消掉不再成立的按住。**它不判定结果**——蓄力够不够、长按算不算收包，全由服务端
 * 按自己记的时刻算。这里画的圈是预期，不是许可。
 *
 * 两端跑同一个 `chargeRatio`，圈满那一刻就是服务端判定满的那一刻。
 */
export class HotbarController {
  private pending?: PendingHold;
  private readonly disposers: (() => void)[] = [];
  /** 上一帧手上是什么；换手时要取消掉正在进行的按住。 */
  private lastHeldItemType?: string;

  public constructor(
    private readonly input: InputSubsystem,
    private readonly port: HotbarPort,
    private readonly now: () => number = () => performance.now(),
  ) {
    const triggered = { phases: ['triggered'] } as const;
    // 按住要的是明确的按下与释放，忽略 triggered/ongoing：多设备 Action 在持续阶段
    // 切换来源时，会把一次有效的按住误判成结束。
    const held = { phases: ['started', 'completed', 'canceled'] } as const;

    HotbarSlotTags.forEach((tag, index) => {
      this.disposers.push(this.input.bind(tag, () => this.selectSlot(index), triggered));
    });
    this.disposers.push(
      this.input.bind(PlayerInputTags.HotbarPrevious, () => this.cycle(-1), triggered),
      this.input.bind(PlayerInputTags.HotbarNext, () => this.cycle(1), triggered),
      // 交互键的按住语义只在手上有东西时成立；空手时它仍然是就近拾取，
      // 那条路走 ActorInteractionController，不经过这里。
      this.input.bind(
        PlayerInputTags.WorldInteract,
        (event) => this.handleStow(event.phase),
        held,
      ),
      this.input.bind(
        ItemUseInputTags.primary,
        (event) => this.handleUse('primary', event.phase),
        held,
      ),
    );
  }

  /** 每帧调用：推进进度圈，并在手上那件变了时作废正在进行的按住。 */
  public update(): void {
    const heldItemType = this.port.getInventory()?.heldItemType;
    if (heldItemType !== this.lastHeldItemType) {
      this.lastHeldItemType = heldItemType;
      // 换手了，这次按住指向的东西已经不在手上，继续算下去会打在新道具头上。
      this.cancelPending();
    }
    if (!this.pending) {
      this.port.setProgress(undefined);
      return;
    }
    const elapsed = (this.now() - this.pending.startedAt) / 1000;
    this.port.setProgress({
      kind: this.pending.kind,
      ratio: chargeRatio(elapsed, this.pending.durationSeconds),
      label: this.pending.label,
    });
  }

  public reset(): void {
    this.cancelPending();
    this.lastHeldItemType = undefined;
  }

  public dispose(): void {
    this.reset();
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }

  private selectSlot(index: number): void {
    const inventory = this.port.getInventory();
    if (!this.port.isActive() || !inventory) return;
    // 超出这名角色实际格数的数字键什么都不做，而不是报错或绕回第一格。
    if (index >= (inventory.hotbar?.length ?? 0)) return;
    this.port.send({ kind: 'select', slotIndex: index });
  }

  private cycle(direction: 1 | -1): void {
    if (!this.port.isActive()) return;
    this.port.send({ kind: 'cycle', direction });
  }

  /** 交互键：手上有东西时短按放下、长按收回背包；空手时这里不参与。 */
  private handleStow(phase: string): void {
    const inventory = this.port.getInventory();
    const heldItemType = inventory?.heldItemType;
    if (!this.port.isActive() || !inventory || !heldItemType) {
      if (phase !== 'started') this.cancelPending();
      return;
    }
    if (phase === 'started') {
      this.begin({
        kind: 'stow',
        startedAt: this.now(),
        durationSeconds: inventory.stowHoldSeconds ?? 0.6,
        label: '收进背包',
      }, { kind: 'stow:begin' });
      return;
    }
    if (phase === 'canceled') {
      this.cancelPending();
      return;
    }
    // 松手了：短按还是长按由服务端按自己的计时判定，这里不预判。
    if (this.pending?.kind !== 'stow') return;
    this.pending = undefined;
    this.port.setProgress(undefined);
    this.port.send({ kind: 'stow:release' });
  }

  private handleUse(slot: keyof typeof ItemUseInputTags, phase: string): void {
    const heldItemType = this.port.getInventory()?.heldItemType;
    const use = resolveHeldItemAction(heldItemType);
    // 这件道具没登记这个输入槽，就当这个键在手持这件东西时没有含义。
    if (!this.port.isActive() || !use || use.input !== slot) {
      if (phase !== 'started') this.cancelPending();
      return;
    }
    if (phase === 'started') {
      this.begin({
        kind: 'charge',
        startedAt: this.now(),
        durationSeconds: use.chargeSeconds,
        label: use.verb,
      }, { kind: 'use:begin' });
      return;
    }
    if (phase === 'canceled') {
      this.cancelPending();
      return;
    }
    if (this.pending?.kind !== 'charge') return;
    this.pending = undefined;
    this.port.setProgress(undefined);
    this.port.send({ kind: 'use:release' });
  }

  private begin(pending: PendingHold, command: InventoryCommand): void {
    // 两次按住不能重叠：交互键按着再按使用键，服务端每种只有一个起始时刻，
    // 后到的那次会把前一次的计时抢走。先取消，语义才是确定的。
    this.cancelPending();
    this.pending = pending;
    this.port.send(command);
  }

  private cancelPending(): void {
    if (!this.pending) return;
    const kind = this.pending.kind;
    this.pending = undefined;
    this.port.setProgress(undefined);
    this.port.send({ kind: kind === 'charge' ? 'use:cancel' : 'stow:cancel' });
  }
}
