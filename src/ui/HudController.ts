export class HudController {
  private readonly panel: HTMLElement;
  private readonly enterButton: HTMLButtonElement;
  private readonly lockHint: HTMLElement;
  private hasEntered = false;

  public constructor() {
    this.panel = this.requireElement<HTMLElement>('start-panel');
    this.enterButton = this.requireElement<HTMLButtonElement>('enter-button');
    this.lockHint = this.requireElement<HTMLElement>('lock-hint');
  }

  public onEnter(handler: () => void): void {
    this.enterButton.addEventListener('click', () => {
      this.hasEntered = true;
      this.panel.classList.add('is-hidden');
      handler();
    });
  }

  public setLocked(locked: boolean): void {
    document.body.classList.toggle('is-locked', locked);
    if (locked) {
      this.hasEntered = true;
      this.panel.classList.add('is-hidden');
      this.lockHint.textContent = 'Esc · 释放鼠标';
    } else {
      this.lockHint.textContent = this.hasEntered ? '点击画面重新控制镜头' : '点击画面控制镜头';
    }
  }

  private requireElement<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`缺少界面元素 #${id}`);
    return element as T;
  }
}
