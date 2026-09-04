import { itemCatalog } from '../../shared/items/index.mjs';
import type { BuildSelection } from '../controllers/BuildController';
import type { ActorArchetypeDefinition } from '../scenes/data/SceneDefinition';
import { createIcon, type IconId } from './icons/IconSprite';

const REMOVE_KEY = 'remove';

/**
 * 屏幕右侧的建造栏，和左侧的地形编辑栏镜像。
 *
 * 列表里的件来自这张地图声明的建造件原型（`gameplay.runtimeActorArchetypes`），
 * 每一行写着名字和材料价；背包里材料不够的那一行标红，但仍然点得动——幽灵会
 * 告诉玩家缺什么。最后一行是「拆除」。
 *
 * 收起时**整套建造功能都关掉**：当前选择被清空，场景那边收到 undefined 就收起
 * 幽灵、也不再把交互键当成「放置」。
 */
export class BuildPanel {
  private readonly root: HTMLElement;
  private readonly tab: HTMLButtonElement;
  private readonly tools: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly pieces = new Map<string, ActorArchetypeDefinition>();
  private handler?: (selection?: BuildSelection) => void;
  private quantityOf?: (itemType: string) => number;
  private expanded = false;
  private available = false;
  private activeKey?: string;

  public constructor() {
    this.root = this.requireElement<HTMLElement>('build-editor');
    this.tab = this.requireElement<HTMLButtonElement>('build-editor-toggle');
    this.tools = this.requireElement<HTMLElement>('build-editor-tools');
    this.tab.append(createIcon('build-panel', { className: 'build-editor__tab-icon' }));
    this.tab.addEventListener('click', () => this.setExpanded(!this.expanded));
    this.render();
  }

  /** 这张地图能建什么。空列表 = 整条栏不出现，并清掉残留的选择。 */
  public setPieces(archetypes: readonly ActorArchetypeDefinition[]): void {
    this.pieces.clear();
    for (const archetype of archetypes) {
      if (archetype.components.buildPiece && archetype.components.render) {
        this.pieces.set(archetype.id, archetype);
      }
    }
    this.rebuild();
    if (this.activeKey && this.activeKey !== REMOVE_KEY && !this.pieces.has(this.activeKey)) {
      this.select(undefined);
    }
    this.setAvailable(this.pieces.size > 0);
  }

  /** 背包镜像变了就重标一遍「买不买得起」。传 undefined 表示没有背包（自由镜头）。 */
  public setInventory(quantityOf?: (itemType: string) => number): void {
    this.quantityOf = quantityOf;
    this.render();
  }

  public onSelectionChange(handler: (selection?: BuildSelection) => void): void {
    this.handler = handler;
  }

  public get selection(): BuildSelection | undefined {
    return this.selectionFor(this.activeKey);
  }

  public setAvailable(available: boolean): void {
    if (this.available === available) return;
    this.available = available;
    if (!available) this.setExpanded(false);
    this.render();
  }

  /** 展开状态；收起会一并清掉当前选择。 */
  public setExpanded(expanded: boolean): void {
    const next = expanded && this.available;
    if (this.expanded === next) return;
    this.expanded = next;
    if (!next) this.select(undefined);
    this.render();
  }

  private toggle(key: string): void {
    // 再点一次同一行就退出该模式，不用先收起整条栏。
    this.select(this.activeKey === key ? undefined : key);
  }

  private select(key?: string): void {
    if (this.activeKey === key) return;
    this.activeKey = key;
    this.render();
    this.handler?.(this.selectionFor(key));
  }

  private selectionFor(key?: string): BuildSelection | undefined {
    if (key === REMOVE_KEY) return { kind: 'remove' };
    const archetype = key ? this.pieces.get(key) : undefined;
    return archetype ? { kind: 'piece', archetype } : undefined;
  }

  private rebuild(): void {
    for (const button of this.buttons.values()) button.remove();
    this.buttons.clear();
    for (const archetype of this.pieces.values()) {
      const piece = archetype.components.buildPiece!;
      const icon: IconId = piece.kind === 'foundation'
        ? 'build-foundation'
        : (piece.kind === 'wall' ? 'build-wall' : 'build-fixture');
      this.addButton(archetype.id, icon, piece.label, this.costText(piece.cost));
    }
    if (this.pieces.size > 0) this.addButton(REMOVE_KEY, 'build-remove', '拆除', '退回材料');
  }

  private addButton(key: string, icon: IconId, label: string, cost: string): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'build-editor__tool';
    button.dataset.build = key;
    button.title = `${label} · ${cost}`;
    button.setAttribute('aria-label', `${label}，${cost}`);
    button.setAttribute('aria-pressed', 'false');
    const name = document.createElement('span');
    name.className = 'build-editor__label';
    name.textContent = label;
    const price = document.createElement('span');
    price.className = 'build-editor__cost';
    price.textContent = cost;
    button.append(createIcon(icon, { className: 'build-editor__icon' }), name, price);
    button.addEventListener('click', () => this.toggle(key));
    this.tools.append(button);
    this.buttons.set(key, button);
  }

  private costText(cost: readonly { itemType: string; quantity: number }[]): string {
    return cost
      .map((entry) => `${itemCatalog.get(entry.itemType)?.displayName ?? entry.itemType} ×${entry.quantity}`)
      .join('  ');
  }

  private affordable(key: string): boolean {
    const piece = this.pieces.get(key)?.components.buildPiece;
    if (!piece || !this.quantityOf) return true;
    const quantityOf = this.quantityOf;
    return piece.cost.every((entry) => quantityOf(entry.itemType) >= entry.quantity);
  }

  private render(): void {
    this.root.hidden = !this.available;
    this.tools.hidden = !this.expanded;
    this.tab.setAttribute('aria-expanded', this.expanded ? 'true' : 'false');
    this.tab.setAttribute('aria-label', this.expanded ? '收起建造栏' : '展开建造栏');
    this.root.classList.toggle('is-expanded', this.expanded);
    for (const [key, button] of this.buttons) {
      const active = key === this.activeKey;
      button.classList.toggle('is-active', active);
      button.classList.toggle('is-unaffordable', !this.affordable(key));
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  private requireElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`缺少建造界面元素：${id}`);
    return element as T;
  }
}
