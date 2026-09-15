type ElementOptions = {
  className?: string;
  text?: string;
  attributes?: Record<string, string>;
};

/** 建元素的小工具：后台面板全是同一种「容器 + 文本」结构，逐行 createElement 会淹没逻辑。 */
export function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  for (const [name, value] of Object.entries(options.attributes ?? {})) element.setAttribute(name, value);
  return element;
}

/** 「标签 + 控件」竖排字段，与游戏内 `.field-control` 同一套视觉。 */
export function createField(labelText: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  const field = createElement('label', { className: 'admin-field' });
  field.append(createElement('span', { className: 'admin-field__label', text: labelText }), control);
  if (hint) field.append(createElement('span', { className: 'admin-field__hint', text: hint }));
  return field;
}

export function createButton(text: string, variant: 'primary' | 'quiet' | 'danger' = 'quiet'): HTMLButtonElement {
  const button = createElement('button', {
    className: `paper-button paper-button--${variant}`,
    text,
  });
  button.type = 'button';
  return button;
}

/** 面板标题栏：小标题 + 说明 + 右侧操作区。 */
export function createPanelHeader(title: string, description: string): {
  header: HTMLElement;
  actions: HTMLElement;
} {
  const header = createElement('header', { className: 'admin-panel__header' });
  const headings = createElement('div');
  headings.append(
    createElement('h2', { text: title }),
    createElement('p', { className: 'admin-panel__description', text: description }),
  );
  const actions = createElement('div', { className: 'admin-panel__actions' });
  header.append(headings, actions);
  return { header, actions };
}
