import {
  ABILITY_LAB_ACTIONS,
  type AbilityLabAction,
  type AbilityLabUnitView,
  type AbilityLabViewState,
} from '../abilities/lab/AbilityLabSimulation';

interface AbilityButtonElements {
  readonly button: HTMLButtonElement;
  readonly status: HTMLElement;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function effectLabel(effectId: string): string {
  if (effectId.endsWith('.Burning')) return '燃烧';
  if (effectId.endsWith('.Rage')) return '狂暴';
  if (effectId.endsWith('.Silence')) return '沉默';
  if (effectId.endsWith('.ManaRegeneration')) return '法力恢复';
  return effectId.split('.').at(-1) ?? effectId;
}

export class AbilityLabPanel {
  public readonly element = createElement('aside', 'ability-lab-panel');
  private readonly casterHealth = createElement('span', 'ability-lab-stat__value');
  private readonly casterMana = createElement('span', 'ability-lab-stat__value');
  private readonly casterAttack = createElement('span', 'ability-lab-stat__value');
  private readonly casterHealthBar = createElement('i', 'ability-lab-bar__fill');
  private readonly casterManaBar = createElement('i', 'ability-lab-bar__fill ability-lab-bar__fill--mana');
  private readonly casterTags = createElement('div', 'ability-lab-tags');
  private readonly targetHealth = createElement('span', 'ability-lab-stat__value');
  private readonly targetHealthBar = createElement('i', 'ability-lab-bar__fill ability-lab-bar__fill--target');
  private readonly targetTags = createElement('div', 'ability-lab-tags');
  private readonly logList = createElement('ol', 'ability-lab-log');
  private readonly buttons = new Map<string, AbilityButtonElements>();
  private actionHandler?: (action: AbilityLabAction) => void;

  public constructor(root: HTMLElement) {
    this.element.hidden = true;
    this.element.setAttribute('aria-label', '能力系统实验室');

    const header = createElement('header', 'ability-lab-panel__header');
    const headingGroup = createElement('div', 'ability-lab-panel__heading');
    headingGroup.append(
      createElement('small', 'ability-lab-kicker', 'GAME ABILITY COMPONENT'),
      createElement('h2', 'ability-lab-title', '能力实验室'),
      createElement('p', 'ability-lab-summary', '观察消耗、冷却、标签门控、DOT 与效果叠层。'),
    );
    const resetButton = createElement('button', 'ability-lab-reset', '0 · 重置');
    resetButton.type = 'button';
    resetButton.addEventListener('click', () => this.actionHandler?.('reset'));
    header.append(headingGroup, resetButton);

    const units = createElement('div', 'ability-lab-units');
    units.append(
      this.createUnitCard('CASTER', '施法者', [
        this.createStat('生命', this.casterHealth, this.casterHealthBar),
        this.createStat('法力', this.casterMana, this.casterManaBar),
        this.createInlineStat('攻击', this.casterAttack),
      ], this.casterTags),
      this.createUnitCard('TARGET', '训练假人', [
        this.createStat('生命', this.targetHealth, this.targetHealthBar),
      ], this.targetTags),
    );

    const actions = createElement('div', 'ability-lab-actions');
    for (const action of ABILITY_LAB_ACTIONS) {
      const button = createElement('button', 'ability-lab-action');
      button.type = 'button';
      button.dataset.abilityAction = action.id;
      const key = createElement('kbd', 'ability-lab-action__key', action.key);
      const copy = createElement('span', 'ability-lab-action__copy');
      copy.append(
        createElement('strong', 'ability-lab-action__name', action.name),
        createElement('small', 'ability-lab-action__description', action.description),
      );
      const status = createElement('span', 'ability-lab-action__status', `${action.manaCost} MP`);
      button.append(key, copy, status);
      button.addEventListener('click', () => this.actionHandler?.(action.id));
      this.buttons.set(action.id, { button, status });
      actions.append(button);
    }

    const logSection = createElement('section', 'ability-lab-log-section');
    logSection.append(createElement('h3', 'ability-lab-log-title', 'RUNTIME EVENT LOG'), this.logList);
    this.element.append(header, units, actions, logSection);
    root.append(this.element);
  }

  public onAction(handler: (action: AbilityLabAction) => void): void {
    this.actionHandler = handler;
  }

  public setVisible(visible: boolean): void {
    this.element.hidden = !visible;
    document.body.classList.toggle('is-ability-lab', visible);
  }

  public setState(state: AbilityLabViewState): void {
    this.renderUnit(state.caster, {
      health: this.casterHealth,
      healthBar: this.casterHealthBar,
      mana: this.casterMana,
      manaBar: this.casterManaBar,
      attack: this.casterAttack,
      tags: this.casterTags,
    });
    this.renderUnit(state.target, {
      health: this.targetHealth,
      healthBar: this.targetHealthBar,
      tags: this.targetTags,
    });

    for (const action of ABILITY_LAB_ACTIONS) {
      const elements = this.buttons.get(action.id);
      if (!elements) continue;
      const cooldown = state.cooldowns[action.id] ?? 0;
      elements.button.classList.toggle('is-cooling-down', cooldown > 0);
      elements.status.textContent = cooldown > 0
        ? `${cooldown.toFixed(1)}s`
        : action.manaCost > 0 ? `${action.manaCost} MP` : 'TAG';
    }

    this.logList.replaceChildren(...state.logs.map((message) => (
      createElement('li', 'ability-lab-log__entry', message)
    )));
  }

  public dispose(): void {
    this.setVisible(false);
    this.element.remove();
    this.actionHandler = undefined;
  }

  private createUnitCard(
    kicker: string,
    title: string,
    stats: readonly HTMLElement[],
    tags: HTMLElement,
  ): HTMLElement {
    const card = createElement('section', 'ability-lab-unit');
    const heading = createElement('div', 'ability-lab-unit__heading');
    heading.append(
      createElement('small', 'ability-lab-unit__kicker', kicker),
      createElement('strong', 'ability-lab-unit__name', title),
    );
    card.append(heading, ...stats, tags);
    return card;
  }

  private createStat(label: string, value: HTMLElement, fill: HTMLElement): HTMLElement {
    const row = createElement('div', 'ability-lab-stat');
    const caption = createElement('span', 'ability-lab-stat__caption', label);
    const bar = createElement('span', 'ability-lab-bar');
    bar.append(fill);
    row.append(caption, value, bar);
    return row;
  }

  private createInlineStat(label: string, value: HTMLElement): HTMLElement {
    const row = createElement('div', 'ability-lab-stat ability-lab-stat--inline');
    row.append(createElement('span', 'ability-lab-stat__caption', label), value);
    return row;
  }

  private renderUnit(
    unit: AbilityLabUnitView,
    elements: {
      readonly health: HTMLElement;
      readonly healthBar: HTMLElement;
      readonly mana?: HTMLElement;
      readonly manaBar?: HTMLElement;
      readonly attack?: HTMLElement;
      readonly tags: HTMLElement;
    },
  ): void {
    elements.health.textContent = `${Math.ceil(unit.health)} / ${unit.maximumHealth}`;
    this.setBar(elements.healthBar, unit.health / unit.maximumHealth);
    if (elements.mana && elements.manaBar && unit.mana !== undefined && unit.maximumMana !== undefined) {
      elements.mana.textContent = `${Math.ceil(unit.mana)} / ${unit.maximumMana}`;
      this.setBar(elements.manaBar, unit.mana / unit.maximumMana);
    }
    if (elements.attack) elements.attack.textContent = unit.attack?.toFixed(0) ?? '—';

    const effectTags = unit.effects
      .filter((effect) => !effect.id.endsWith('.ManaRegeneration'))
      .map((effect) => {
        const duration = effect.remainingSeconds === undefined ? '' : ` ${effect.remainingSeconds.toFixed(1)}s`;
        const stacks = effect.stacks > 1 ? ` ×${effect.stacks}` : '';
        return `${effectLabel(effect.id)}${stacks}${duration}`;
      });
    const stateTags = unit.tags
      .filter((tag) => !tag.startsWith('State.Regenerating') && tag !== 'State.CanCast')
      .map((tag) => tag.replace('State.', ''));
    const labels = [...new Set([...stateTags, ...effectTags])];
    elements.tags.replaceChildren(...(labels.length > 0 ? labels : ['无活跃标签']).map((label) => (
      createElement('span', 'ability-lab-tag', label)
    )));
  }

  private setBar(element: HTMLElement, ratio: number): void {
    element.style.setProperty('--ability-lab-ratio', `${Math.max(0, Math.min(1, ratio)) * 100}%`);
  }
}
