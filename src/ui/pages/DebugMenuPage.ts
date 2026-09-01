import { ModalWindow } from '../common/ModalWindow';
import {
  DEFAULT_WEATHER,
  WEATHER_LABELS,
  WEATHER_TYPES,
  type WeatherType,
} from '../../weather/index';

export class DebugMenuPage extends ModalWindow {
  private readonly collisionButton: HTMLButtonElement;
  private readonly temperatureButton: HTMLButtonElement;
  private readonly weatherButtons = new Map<WeatherType, HTMLButtonElement>();
  private collisionToggleHandler?: (visible: boolean) => void;
  private temperatureToggleHandler?: (visible: boolean) => void;
  private weatherSelectHandler?: (weather: WeatherType) => void;
  private collisionVisible = false;
  private temperatureVisible = false;

  public constructor() {
    super({
      id: 'development-debug-menu',
      kicker: 'DEVELOPMENT ONLY · F8',
      title: '调试菜单',
      description: '检查运行时 Actor 状态，并向房间服务端请求切换权威天气。',
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

    const weatherSection = document.createElement('section');
    weatherSection.className = 'debug-menu__section';
    const weatherHeading = document.createElement('h3');
    weatherHeading.textContent = 'ROOM WEATHER';
    const weatherDescription = document.createElement('p');
    weatherDescription.textContent = '服务端只同步当前天气；每个客户端按本地玩家周围的 chunk 激活固定容量天气粒子。';
    const weatherGrid = document.createElement('div');
    weatherGrid.className = 'debug-menu__weather-grid';
    weatherGrid.setAttribute('role', 'group');
    weatherGrid.setAttribute('aria-label', '切换房间天气');
    for (const weather of WEATHER_TYPES) {
      const button = document.createElement('button');
      button.className = 'paper-button debug-menu__weather-button';
      button.type = 'button';
      button.dataset.weather = weather;
      button.textContent = WEATHER_LABELS[weather];
      button.addEventListener('click', () => this.weatherSelectHandler?.(weather));
      this.weatherButtons.set(weather, button);
      weatherGrid.append(button);
    }
    weatherSection.append(weatherHeading, weatherDescription, weatherGrid);

    this.bodyElement.append(collisionSection, temperatureSection, weatherSection);
    this.setCollisionVisible(false);
    this.setTemperatureVisible(false);
    this.setWeather(DEFAULT_WEATHER);
  }

  public onCollisionToggle(handler: (visible: boolean) => void): void {
    this.collisionToggleHandler = handler;
  }

  public onTemperatureToggle(handler: (visible: boolean) => void): void {
    this.temperatureToggleHandler = handler;
  }

  public onWeatherSelect(handler: (weather: WeatherType) => void): void {
    this.weatherSelectHandler = handler;
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

  public setWeather(weather: WeatherType): void {
    for (const [candidate, button] of this.weatherButtons) {
      button.setAttribute('aria-pressed', String(candidate === weather));
    }
  }

  public onOpen(): void {
    this.collisionButton.focus();
  }
}
