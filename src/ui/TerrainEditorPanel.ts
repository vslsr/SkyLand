import type { TerrainEditOperation } from '../network/messages';
import { createIcon, type IconId } from './icons/IconSprite';

interface TerrainToolDefinition {
  readonly operation: TerrainEditOperation;
  readonly icon: IconId;
  readonly label: string;
}

/** 圆形按钮从上到下的顺序。图标走 sprite 引用，路径数据只存在一份。 */
const TERRAIN_TOOLS: readonly TerrainToolDefinition[] = [
  { operation: 'raise', icon: 'terrain-raise', label: '抬高一层' },
  { operation: 'lower', icon: 'terrain-lower', label: '下挖一层' },
  { operation: 'flatten', icon: 'terrain-flatten', label: '铺平' },
  { operation: 'water', icon: 'terrain-water', label: '注水' },
  { operation: 'ground', icon: 'terrain-ground', label: '填成陆地' },
  { operation: 'reset', icon: 'terrain-reset', label: '还原成原始地形' },
];

/**
 * 屏幕左侧的地形编辑栏。
 *
 * 收起时**整套编辑功能都关掉**——不是只把按钮藏起来：当前工具会被清空，
 * 场景那边收到 undefined 就不再高亮、点击也不再改地形。这样「收起」是一个
 * 明确的安全状态，而不是一个仍然带着隐藏状态的外观变化。
 */
export class TerrainEditorPanel {
  private readonly root: HTMLElement;
  private readonly tab: HTMLButtonElement;
  private readonly tools: HTMLElement;
  private readonly buttons = new Map<TerrainEditOperation, HTMLButtonElement>();
  private handler?: (operation?: TerrainEditOperation) => void;
  private expanded = false;
  private available = false;
  private activeOperation?: TerrainEditOperation;

  public constructor() {
    this.root = this.requireElement<HTMLElement>('terrain-editor');
    this.tab = this.requireElement<HTMLButtonElement>('terrain-editor-toggle');
    this.tools = this.requireElement<HTMLElement>('terrain-editor-tools');
    for (const tool of TERRAIN_TOOLS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'terrain-editor__tool';
      button.dataset.operation = tool.operation;
      button.title = tool.label;
      button.setAttribute('aria-label', tool.label);
      button.setAttribute('aria-pressed', 'false');
      button.append(createIcon(tool.icon, { className: 'terrain-editor__icon' }));
      button.addEventListener('click', () => this.toggleOperation(tool.operation));
      this.tools.append(button);
      this.buttons.set(tool.operation, button);
    }
    this.tab.addEventListener('click', () => this.setExpanded(!this.expanded));
    this.render();
  }

  /** 只有流式大世界才有可编辑地形；其余场景整条栏都不出现。 */
  public setAvailable(available: boolean): void {
    if (this.available === available) return;
    this.available = available;
    if (!available) this.setExpanded(false);
    this.render();
  }

  public onOperationChange(handler: (operation?: TerrainEditOperation) => void): void {
    this.handler = handler;
  }

  public get operation(): TerrainEditOperation | undefined {
    return this.activeOperation;
  }

  /** 展开状态；收起会一并清掉当前工具。 */
  public setExpanded(expanded: boolean): void {
    const next = expanded && this.available;
    if (this.expanded === next) return;
    this.expanded = next;
    if (!next) this.selectOperation(undefined);
    this.render();
  }

  private toggleOperation(operation: TerrainEditOperation): void {
    // 再点一次同一个按钮就退出该模式，不用先收起整条栏。
    this.selectOperation(this.activeOperation === operation ? undefined : operation);
  }

  private selectOperation(operation?: TerrainEditOperation): void {
    if (this.activeOperation === operation) return;
    this.activeOperation = operation;
    this.render();
    this.handler?.(operation);
  }

  private render(): void {
    this.root.hidden = !this.available;
    this.tools.hidden = !this.expanded;
    this.tab.setAttribute('aria-expanded', this.expanded ? 'true' : 'false');
    this.tab.setAttribute('aria-label', this.expanded ? '收起地形编辑' : '展开地形编辑');
    this.root.classList.toggle('is-expanded', this.expanded);
    for (const [operation, button] of this.buttons) {
      const active = operation === this.activeOperation;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  private requireElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`缺少地形编辑界面元素：${id}`);
    return element as T;
  }
}
