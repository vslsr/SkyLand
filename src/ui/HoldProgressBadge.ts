import type { HeldItemProgress } from '../controllers/HotbarController';

/**
 * 键帽里放得下的字数。
 *
 * `E`、`Y`、`F8` 这种进圈里；`鼠标左键`、`触摸摇杆` 这类长名字塞进 38px 的井里
 * 会直接溢出到环外面，改挂到下面那行文字上，写成和交互提示同一个句式
 * 「鼠标左键 · 投掷」。
 */
const KEY_CAP_MAX_LENGTH = 3;

/**
 * 按住时的键位与进度环。
 *
 * 按住 E 收进背包这类动作，按下去之后画面上原本什么都不剩：交互提示那条
 * 「E · 收进背包」在按键落下的一瞬间就开始淡出（`InteractionPromptFade` 把
 * 「正在操作」当成让开画面的信号），而快捷栏那圈进度只画在当前手持的那一格上，
 * 叼着的蘑菇是个世界物件、根本没有格子，连圈都没有。于是玩家按住之后既不知道
 * 手该按着什么，也不知道还要按多久。
 *
 * 这个牌子补的就是这段空窗：按住期间贴在准星下方，键帽写着当前绑定的那个键，
 * 外圈是顺时针扫过去的进度环，圈满就是服务端判定满的那一刻（两端跑同一个
 * `chargeRatio`）。使用蓄力走同一条路，只是换个颜色。
 *
 * 它是纯 View：进度从哪来、算到几都不管，`HotbarController` 每帧喂一次。
 */
export class HoldProgressBadge {
  public readonly element: HTMLElement;
  private readonly dial: HTMLElement;
  private readonly key: HTMLElement;
  private readonly label: HTMLElement;
  private renderedKind = '';
  private renderedKey = '';
  private renderedLabel = '';
  private renderedPercent = -1;

  public constructor() {
    this.element = document.createElement('div');
    this.element.className = 'hold-progress';
    this.element.hidden = true;
    // 读屏只念一次结果，不逐帧播报百分比：这是个进行中的手感提示，不是状态播报。
    this.element.setAttribute('aria-hidden', 'true');

    this.dial = document.createElement('div');
    this.dial.className = 'hold-progress__dial';
    // 井盖在键帽之前入列：同一个网格单元里靠入列顺序分前后，不用 z-index。
    const well = document.createElement('span');
    well.className = 'hold-progress__well';
    this.key = document.createElement('span');
    this.key.className = 'hold-progress__key';
    this.dial.append(well, this.key);

    this.label = document.createElement('p');
    this.label.className = 'hold-progress__label';

    this.element.append(this.dial, this.label);
  }

  /** 每帧一次：`undefined` 表示这次按住结束了，把牌子收掉。 */
  public setProgress(progress: HeldItemProgress | undefined): void {
    if (!progress) {
      if (this.element.hidden) return;
      this.element.hidden = true;
      this.renderedPercent = -1;
      return;
    }
    this.element.hidden = false;

    if (progress.kind !== this.renderedKind) {
      this.renderedKind = progress.kind;
      this.element.dataset.kind = progress.kind;
    }
    // 没绑定键位时只留圈：与其画一个空键帽，不如让进度自己说话。
    const inputLabel = progress.inputLabel ?? '';
    const fitsCap = inputLabel !== '' && inputLabel.length <= KEY_CAP_MAX_LENGTH;
    const keyLabel = fitsCap ? inputLabel : '';
    if (keyLabel !== this.renderedKey) {
      this.renderedKey = keyLabel;
      this.key.textContent = keyLabel;
      this.key.hidden = keyLabel === '';
    }
    const label = fitsCap || inputLabel === ''
      ? progress.label
      : `${inputLabel} · ${progress.label}`;
    if (label !== this.renderedLabel) {
      this.renderedLabel = label;
      this.label.textContent = label;
    }
    // 取整到 1%：进度环每帧都在变，逐帧写同一个字符串只会让样式重算白跑。
    const percent = Math.round(clamp01(progress.ratio) * 100);
    if (percent === this.renderedPercent) return;
    this.renderedPercent = percent;
    this.dial.style.setProperty('--hold-progress', `${percent}%`);
  }

  public dispose(): void {
    this.element.remove();
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
