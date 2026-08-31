import { ModalWindow } from '../common/ModalWindow';

export class DebugMenuPage extends ModalWindow {
  private readonly collisionButton: HTMLButtonElement;
  private readonly temperatureButton: HTMLButtonElement;
  private collisionToggleHandler?: (visible: boolean) => void;
  private temperatureToggleHandler?: (visible: boolean) => void;
  private collisionVisible = false;
  private temperatureVisible = false;

  public constructor() {
    super({
      id: 'development-debug-menu',
      kicker: 'DEVELOPMENT ONLY · F8',
      title: '调试菜单',
      description: '检查运行时 Actor 的碰撞、温度与其他开发状态。',
      size: 'compact',
    });

    const collisionSection = document.createElement('section');
    collisionSection.className = 'debug-menu__section';
    const collisionHeading = document.createElement('h3');
    collisionHeading.textContent = 'ACTOR COLLISION';
    const collisionDescription = document.createElement('p');
    collisionDescription.textContent = '显示由模型尺寸自动生成、同时参与客户端预测与房间权威移动的碰撞盒。';
    this.collisionButton = document.createElement('button');
    this.collisionButton.className = 'paper-button debug-menu__toggle';
    this.collisionButton.type = 'button';
    this.collisionButton.addEventListener('click', () => {
      this.setCollisionVisible(!this.collisionVisible);
      this.collisionToggleHandler?.(this.collisionVisible);
    });
    collisionSection.append(collisionHeading, collisionDescription, this.collisionButton);

    const temperatureSection = document.createElement('section');
    temperatureSection.className = 'debug-menu__section';
    const temperatureHeading = document.createElement('h3');
    temperatureHeading.textContent = 'ACTOR TEMPERATURE';
    const temperatureDescription = document.createElement('p');
    temperatureDescription.textContent = '在所有带 Temperature Component 的已加载 Actor 旁显示服务器同步温度。';
    this.temperatureButton = document.createElement('button');
    this.temperatureButton.className = 'paper-button debug-menu__toggle';
    this.temperatureButton.type = 'button';
    this.temperatureButton.addEventListener('click', () => {
      this.setTemperatureVisible(!this.temperatureVisible);
      this.temperatureToggleHandler?.(this.temperatureVisible);
    });
    temperatureSection.append(temperatureHeading, temperatureDescription, this.temperatureButton);

    this.bodyElement.append(collisionSection, temperatureSection);
    this.setCollisionVisible(false);
    this.setTemperatureVisible(false);
  }

  public onCollisionToggle(handler: (visible: boolean) => void): void {
    this.collisionToggleHandler = handler;
  }

  public onTemperatureToggle(handler: (visible: boolean) => void): void {
    this.temperatureToggleHandler = handler;
  }

  public setCollisionVisible(visible: boolean): void {
    this.collisionVisible = visible;
    this.collisionButton.setAttribute('aria-pressed', String(visible));
    this.collisionButton.textContent = visible
      ? '隐藏 Actor 简单碰撞'
      : '显示 Actor 简单碰撞';
  }

  public setTemperatureVisible(visible: boolean): void {
    this.temperatureVisible = visible;
    this.temperatureButton.setAttribute('aria-pressed', String(visible));
    this.temperatureButton.textContent = visible
      ? '隐藏 Actor 温度'
      : '显示 Actor 温度';
  }

  public onOpen(): void {
    this.collisionButton.focus();
  }
}
