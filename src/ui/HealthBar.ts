import type { HealthDisplayState, HealthView } from '../health/HealthDisplay';

/**
 * 屏幕底部那条生命条。
 *
 * 纯 View：血从哪来、掉了多少、算不算警戒，一个都不判断——那些结论由
 * `HealthDisplayController` 算好，几种样式共用同一份，所以这条横条变红那一刻，
 * 别的样式也正好变红。这里只把状态翻成 DOM。
 *
 * 画三层，一层说一件事：
 *
 * - 残影（`__ghost`）：刚掉的那一截，退得比血慢，玩家因此看得见少了多少；
 * - 血（`__fill`）：当前值，掉血那一下立刻到位，不做补间——补间会让它比服务端慢；
 * - 闪光（`__track::after`）：最近一次结算，颜色分治疗与伤害，浓淡按事件年龄。
 *
 * 三层的宽度与浓淡都写成自定义属性，由这里每帧写、CSS 负责画。**CSS 里没有
 * transition 也没有 animation**：动画的时基在控制器那边，两处各跑一份的话，
 * 快照一到就会互相打断，横条反而抖。
 *
 * 每个字段都先比再写：这条横条每帧都在更新，而改 `textContent` 或属性会让浏览器
 * 重排这块 HUD，写自定义属性只是重画。不比一下就等于每帧白付一次重排。
 */
export class HealthBar implements HealthView {
  public readonly element: HTMLElement;
  private readonly track: HTMLElement;
  private readonly readout: HTMLElement;
  private renderedState = '';
  private renderedRatio = -1;
  private renderedGhost = -1;
  private renderedFlash = -1;
  private renderedChange = '';
  private renderedReadout = '';

  public constructor() {
    this.element = document.createElement('div');
    this.element.className = 'health-bar';
    this.element.hidden = true;
    // meter 而不是 progressbar：这是个「当前量在量程里的位置」，不是一件事的进度。
    this.element.setAttribute('role', 'meter');
    this.element.setAttribute('aria-label', '生命值');
    this.element.setAttribute('aria-valuemin', '0');

    this.track = document.createElement('div');
    this.track.className = 'health-bar__track';
    const ghost = document.createElement('span');
    ghost.className = 'health-bar__ghost';
    const fill = document.createElement('span');
    fill.className = 'health-bar__fill';
    this.track.append(ghost, fill);

    this.readout = document.createElement('p');
    this.readout.className = 'health-bar__readout';
    // 读数是给眼睛看的那一份；读屏从 role="meter" 的 aria-valuetext 上念，不必念两遍。
    this.readout.setAttribute('aria-hidden', 'true');

    this.element.append(this.track, this.readout);
  }

  public render(state: HealthDisplayState | undefined): void {
    if (!state) {
      if (this.element.hidden) return;
      this.element.hidden = true;
      // 下次显示的多半是另一条命，比对基准一起作废，免得漏掉第一帧的写入。
      this.renderedState = '';
      this.renderedRatio = -1;
      this.renderedGhost = -1;
      this.renderedFlash = -1;
      this.renderedReadout = '';
      // 空串是 `data-change` 的合法取值，光把比对基准清掉，再显示时这一条会被
      // 当成「没变」跳过，上一条命最后那一下的闪光颜色就留在了元素上。
      this.renderedChange = '';
      this.element.dataset.change = '';
      return;
    }
    this.element.hidden = false;

    const barState = state.dead ? 'dead' : state.critical ? 'critical' : 'normal';
    if (barState !== this.renderedState) {
      this.renderedState = barState;
      this.element.dataset.state = barState;
    }

    const ratio = permille(state.ratio);
    if (ratio !== this.renderedRatio) {
      this.renderedRatio = ratio;
      this.element.style.setProperty('--health-ratio', `${ratio / 10}%`);
    }
    const ghost = permille(state.trailingRatio);
    if (ghost !== this.renderedGhost) {
      this.renderedGhost = ghost;
      this.element.style.setProperty('--health-ghost', `${ghost / 10}%`);
    }
    this.renderChange(state.lastChange);

    const readout = `${Math.round(state.current)} / ${Math.round(state.maximum)}`;
    // 阵亡要进比对基准：`0 / 100` 在倒下前后是同一串字，只比读数的话，读屏的
    // 播报会停在「0 / 100」上，永远念不出那一句「已阵亡」。
    const key = state.dead ? `dead:${readout}` : readout;
    if (key !== this.renderedReadout) {
      this.renderedReadout = key;
      this.readout.textContent = readout;
      this.element.setAttribute('aria-valuemax', String(Math.round(state.maximum)));
      this.element.setAttribute('aria-valuenow', String(Math.round(state.current)));
      // 读屏念「72 / 100」比念一个孤零零的 72 有用；死了就直接说结果。
      this.element.setAttribute('aria-valuetext', state.dead ? '已阵亡' : readout);
    }
  }

  /** 这条横条不归控制器释放：它是屏幕上的一件常设物，没得显示时自己收起来。 */
  public dispose(): void {
    this.element.remove();
  }

  /**
   * 结算闪光。
   *
   * 浓淡按**事件年龄**线性退到 0，而不是挂一段 CSS 动画：控制器那边记的年龄是几种
   * 样式共用的同一份，闪的起止因此处处一致；CSS 动画则要靠「重新触发」才能重放，
   * 连着挨两下时第二下常常被吞掉。
   */
  private renderChange(change: HealthDisplayState['lastChange']): void {
    const kind = !change || !change.amount ? '' : change.amount < 0 ? 'damage' : 'heal';
    if (kind !== this.renderedChange) {
      this.renderedChange = kind;
      this.element.dataset.change = kind;
    }
    // 0.5 秒退完：闪光是「刚挨了一下」的提示，留久了会和下一次糊在一起。
    const strength = kind && change
      ? Math.max(0, 1 - change.ageSeconds / FLASH_SECONDS)
      : 0;
    const hundredths = Math.round(strength * 100);
    if (hundredths === this.renderedFlash) return;
    this.renderedFlash = hundredths;
    this.element.style.setProperty('--health-flash', (hundredths / 100).toFixed(2));
  }
}

/** 闪光从结算那一刻起退多久。比控制器记住一次结算的时长短：退完就静下来。 */
const FLASH_SECONDS = 0.5;

/** 比例取到千分位：一条 200px 的横条上 0.1% 是 0.2px，再细只是让样式白重算一次。 */
function permille(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  return Math.round(Math.min(1, Math.max(0, ratio)) * 1000);
}
