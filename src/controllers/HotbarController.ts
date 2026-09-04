import {
  HotbarSlotTags,
  ItemUseInputTags,
  PlayerInputTags,
} from '../input/config/playerInput';
import type { InputSubsystem } from '../input/core/InputSubsystem';
import type { InventoryModelLike } from '../inventory/index';
import type { InventoryCommand } from '../network/messages';
import type { TagLike } from '../tags';
import { holdRatio, resolveHeldItemAction } from '../../shared/actor/index.mjs';

/**
 * 界面要画的那圈圆形倒计时；没有正在进行的按住时是 undefined。
 *
 * 圈只有一种来源：**长按使用一件物品**。交互键那条「按住收进背包」已经删掉了——
 * 手上有东西时按交互键就是放下，一按就掉，没有第二层含义要靠计时区分。
 */
export interface HeldItemProgress {
  /**
   * 这次按住在用哪一种用法。
   *
   * 界面按它挑表现：`eat` 那一段是角色在嚼，模型要抖起来。表现读的是**同一次
   * 按住**，所以抖动的起止和圈的起止是同一件事，不需要另一条状态。
   */
  readonly action: 'eat' | 'tool' | 'throw';
  /** [0, 1]。到 1 表示服务端也认为倒计时走完了。 */
  readonly ratio: number;
  readonly label: string;
  /**
   * 这圈倒计时说的是不是物品栏里那一格。
   *
   * 是的话，圈画在那一格上就够了——**手持物品不需要在玩家上方再画一次**：同一件
   * 事画两遍，玩家的眼睛要在两处之间来回找，而格子上那圈已经同时说清了「哪一格」
   * 和「还要多久」。叼着的蘑菇和从背包里点出来的用法没有格子，那时才轮到准星
   * 下方那块牌子。
   */
  readonly onHotbar: boolean;
  /**
   * 要一直按住的那个键，按当前设备的绑定取（键盘是 `E`，手柄是 `Y`）。
   *
   * 按住期间交互提示是灭的——`InteractionPromptFade` 把「正在操作」当成让开画面的
   * 信号——所以圈旁边不自己写一遍键位，玩家就看不到手该按着什么。没绑定时是
   * undefined，界面只画圈。
   */
  readonly inputLabel?: string;
}

/** 「接下来的使用键说的是这件东西」。由界面在点「使用」的同一刻交上来。 */
export interface ArmedItemUse {
  readonly itemType: string;
  /**
   * 这次使用属不属于物品栏那一格。
   *
   * 决定圈画在哪：属于物品栏的画在那一格上，背包里点出来的画在准星下方。
   */
  readonly onHotbar: boolean;
}

export interface HotbarPort {
  getInventory(): InventoryModelLike | undefined;
  /**
   * 手上那个 Actor 的 id；空手时是 undefined。
   *
   * 用它而不是 `inventory.heldItemType` 来判断「手上有没有东西」：叼着的蘑菇是个
   * 世界物件，不在物品栏里，按 itemType 判断会让它整条漏掉长按计时——那正是
   * 「按下就掉」的成因。换手的作废检测也用它，因为它对两种手持物都成立。
   */
  getHeldActorId(): string | undefined;
  /** 现在能不能操作：界面盖着或没进房间时不能。 */
  isActive(): boolean;
  /** 当前绑定下这个 Action 的键位显示名；重绑定后立刻跟着变。 */
  getInputLabel(tag: TagLike): string | undefined;
  send(command: InventoryCommand): void;
  /** 每帧把进度交给界面；undefined 表示收掉那圈。 */
  setProgress(progress: HeldItemProgress | undefined): void;
}

/** 一次还没结束的按住（长按使用）。 */
interface PendingHold {
  readonly action: 'eat' | 'tool' | 'throw';
  /** 用的是哪件东西。它变了这次按住就作废。 */
  readonly itemType: string;
  readonly startedAt: number;
  /** 倒计时多长。0 表示这是一次点按，没有圈可画，松手即结算。 */
  readonly durationSeconds: number;
  readonly label: string;
  readonly onHotbar: boolean;
  /** 按下那一刻的键位。记在这次按住上：中途重绑定不该改写正在进行的这一次。 */
  readonly inputLabel?: string;
  /** 倒计时已经走完：服务端在同一刻激活了，松手不再有含义。 */
  completed: boolean;
}

/**
 * 物品栏与物品使用的输入层。
 *
 * 它只做三件事：把按键翻译成意图、把按住的时长翻译成给玩家看的圆形倒计时、在
 * 状态变化时取消掉不再成立的按住。**它不判定结果**——长按算不算数、投掷成不成立，
 * 全由服务端按自己记的时刻算。这里画的圈是预期，不是许可。
 *
 * 两端跑同一个 `holdRatio`，圈满那一刻就是服务端激活那一刻。长按尤其如此：激活
 * 发生在倒计时走完的那一瞬间，不是松手那一瞬间，所以圈画满之后就不必再按着了。
 */
export class HotbarController {
  private pending?: PendingHold;
  /**
   * 菜单里点「使用」之后要用的那件东西。
   *
   * 它优先于手持物，而且**不等快照**：点「使用」时界面就知道说的是哪一件，而
   * 快照 10Hz——等它回来再认，玩家在这 100 毫秒里按下的那一下会因为「手上还是
   * 空的」被整条忽略，表现就是「点了使用，按下去没反应」。
   *
   * 一次激活、一次取消、或者玩家自己换手（数字键、肩键）都会把它清掉。
   */
  private armed?: ArmedItemUse;
  private readonly disposers: (() => void)[] = [];

  public constructor(
    private readonly input: InputSubsystem,
    private readonly port: HotbarPort,
    private readonly now: () => number = () => performance.now(),
  ) {
    const triggered = { phases: ['triggered'] } as const;
    // 长按要的是明确的按下与释放，忽略 triggered/ongoing：多设备 Action 在持续阶段
    // 切换来源时，会把一次有效的按住误判成结束。
    const held = { phases: ['started', 'completed', 'canceled'] } as const;

    HotbarSlotTags.forEach((tag, index) => {
      this.disposers.push(this.input.bind(tag, () => this.selectSlot(index), triggered));
    });
    this.disposers.push(
      this.input.bind(PlayerInputTags.HotbarPrevious, () => this.cycle(-1), triggered),
      this.input.bind(PlayerInputTags.HotbarNext, () => this.cycle(1), triggered),
      // 丢出键单独一个：一个键一件事。交互键归「和世界互动」（拾取、采集、开箱），
      // 手上有没有东西都不改变它的含义。
      this.input.bind(PlayerInputTags.Drop, () => this.dropHeld(), triggered),
      this.input.bind(
        ItemUseInputTags.primary,
        (event) => this.handleUse('primary', event.phase),
        held,
      ),
    );
  }

  /**
   * 背包里点了「使用」：接下来的使用键说的是这件东西。
   *
   * 传 undefined 是撤销。由 `InventoryController` 在发出 `use:arm` 的同一刻调用，
   * 两边说的是同一件事。
   */
  public armItem(itemType: string | undefined, options: { onHotbar?: boolean } = {}): void {
    this.armed = itemType === undefined
      ? undefined
      : { itemType, onHotbar: options.onHotbar === true };
  }

  /** 每帧调用：推进倒计时，并在这次按住指向的东西变了时作废它。 */
  public update(): void {
    // 一次使用认的是**用的哪件东西**，不是嘴上那个 Actor：点「使用」之后手持
    // 表现体会换一个新 id（服务端换手时重新生成），按 id 判断会把刚开始的这次
    // 按住当成「换手了」立刻取消掉。
    if (this.pending && this.currentUseItemType() !== this.pending.itemType) {
      this.cancelPending();
    }
    if (!this.pending || this.pending.completed || this.pending.durationSeconds <= 0) {
      // 点按没有倒计时可画；走完的那一次已经在服务端结算过，圈留着只会误导。
      this.port.setProgress(undefined);
      return;
    }
    const elapsed = (this.now() - this.pending.startedAt) / 1000;
    const ratio = holdRatio(elapsed, this.pending.durationSeconds);
    if (ratio >= 1) {
      // 圈满即激活：服务端在同一刻自己动手，客户端不再发任何东西，也不再画圈。
      this.pending.completed = true;
      this.port.setProgress(undefined);
      this.armed = undefined;
      return;
    }
    this.port.setProgress({
      action: this.pending.action,
      ratio,
      label: this.pending.label,
      onHotbar: this.pending.onHotbar,
      inputLabel: this.pending.inputLabel,
    });
  }

  public reset(): void {
    this.cancelPending();
    this.armed = undefined;
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
    this.armed = undefined;
    this.port.send({ kind: 'select', slotIndex: index });
  }

  private cycle(direction: 1 | -1): void {
    if (!this.port.isActive()) return;
    this.armed = undefined;
    this.port.send({ kind: 'cycle', direction });
  }

  /**
   * 丢出键：把手上那件放到身前地上。空手时什么都不做。
   *
   * **它有自己的一个键**，不和交互键挤在一起。挤在一起时一次按下会同时触发两件
   * 事——手上那件掉出去，脚下那堆又被捡回来——因为「和世界互动」和「处理手上那件」
   * 本来就是两条独立的判断，共用一个键就只能靠优先级把其中一条藏起来。
   *
   * 它也曾经是交互键上的一次按住计时（短按放下、长按收进背包），那把一个常用动作
   * 压在了不常用动作下面。现在是：按一下 Q，掉。
   *
   * 「手上有东西」按嘴上那个 Actor 判，不按物品栏：叼着的蘑菇也是手上那件，
   * 它同样该被这一下丢出去。
   */
  private dropHeld(): void {
    if (!this.port.isActive() || !this.port.getHeldActorId()) return;
    this.port.send({ kind: 'drop' });
  }

  /**
   * 使用键：激活当前授予的那条物品能力。
   *
   * 用哪件东西的用法，看的是「玩家刚在背包里点出来的那件」，其次才是手上那件——
   * 两者都由服务端授予同一个能力槽位，客户端这里只是把同一份判断复述一遍，好在
   * 按下的那一刻就知道该不该画圈。
   */
  private handleUse(slot: keyof typeof ItemUseInputTags, phase: string): void {
    const use = resolveHeldItemAction(this.currentUseItemType());
    // 这件道具没登记这个输入槽，就当这个键在它身上没有含义。
    if (!this.port.isActive() || !use || use.input !== slot) {
      if (phase !== 'started') this.cancelPending();
      return;
    }
    if (phase === 'started') {
      this.begin({
        action: use.action as HeldItemProgress['action'],
        startedAt: this.now(),
        // 点按没有倒计时；长按的圈满那一刻就是服务端激活那一刻。
        durationSeconds: use.mode === 'hold' ? use.holdSeconds : 0,
        label: use.verb,
        itemType: use.itemType,
        // 从背包点出来的那条没有格子，圈只能画在准星下方。
        onHotbar: this.armed ? this.armed.onHotbar : true,
        inputLabel: this.port.getInputLabel(ItemUseInputTags[slot]),
        completed: false,
      }, { kind: 'use:begin' });
      return;
    }
    if (phase === 'canceled') {
      this.cancelPending();
      return;
    }
    if (!this.pending) return;
    const completed = this.pending.completed;
    this.pending = undefined;
    this.port.setProgress(undefined);
    // 倒计时已经走完的那一次，服务端在圈满那一刻就结算了，松手不再有含义。
    if (completed) return;
    this.armed = undefined;
    this.port.send({ kind: 'use:release' });
  }

  /**
   * 这一下使用键说的是哪件东西：菜单里刚点出来的那件优先，其次是手上那件。
   *
   * 两者都可能在同一帧里变，所以每次都重新问一遍，而不是记在按住上。
   */
  private currentUseItemType(): string | undefined {
    return this.armed?.itemType ?? this.port.getInventory()?.heldItemType;
  }

  private begin(pending: PendingHold, command: InventoryCommand): void {
    // 两次按住不能重叠：服务端只记一个起始时刻，后到的那次会把前一次的计时抢走。
    // 先取消，语义才是确定的。
    this.cancelPending();
    this.pending = pending;
    this.port.send(command);
  }

  private cancelPending(): void {
    if (!this.pending) return;
    const { completed } = this.pending;
    this.pending = undefined;
    this.port.setProgress(undefined);
    this.armed = undefined;
    // 已经结算过的那次没有什么可取消的，再发一条只会打断下一次按住。
    if (completed) return;
    this.port.send({ kind: 'use:cancel' });
  }
}
