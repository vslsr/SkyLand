import { ModalWindow } from '../common/ModalWindow';

export class DebugMenuPage extends ModalWindow {
  private readonly collisionButton: HTMLButtonElement;
  private collisionToggleHandler?: (visible: boolean) => void;
  private collisionVisible = false;

  public constructor() {
    super({
      id: 'development-debug-menu',
      kicker: 'DEVELOPMENT ONLY · F8',
      title: '调试菜单',
      description: '检查运行时 Actor 的模型边界与简易碰撞。',
      size: 'compact',
    });

    const section = document.createElement('section');
    section.className = 'debug-menu__section';
    const heading = document.createElement('h3');
    heading.textContent = 'ACTOR COLLISION';
    const description = document.createElement('p');
    description.textContent = '显示由模型尺寸自动生成、同时参与客户端预测与房间权威移动的碰撞盒。';
    this.collisionButton = document.createElement('button');
    this.collisionButton.className = 'paper-button debug-menu__toggle';
    this.collisionButton.type = 'button';
    this.collisionButton.addEventListener('click', () => {
      this.setCollisionVisible(!this.collisionVisible);
      this.collisionToggleHandler?.(this.collisionVisible);
    });
    section.append(heading, description, this.collisionButton);
    this.bodyElement.append(section);
    this.setCollisionVisible(false);
  }

  public onCollisionToggle(handler: (visible: boolean) => void): void {
    this.collisionToggleHandler = handler;
  }

  public setCollisionVisible(visible: boolean): void {
    this.collisionVisible = visible;
    this.collisionButton.setAttribute('aria-pressed', String(visible));
    this.collisionButton.textContent = visible
      ? '隐藏 Actor 简单碰撞'
      : '显示 Actor 简单碰撞';
  }

  public onOpen(): void {
    this.collisionButton.focus();
  }
}
