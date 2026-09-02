import { ModalWindow } from '../common/ModalWindow';
import {
  DEFAULT_WEATHER,
  WEATHER_LABELS,
  WEATHER_TYPES,
  type WeatherType,
} from '../../weather/index';
import { DAY_PHASE_HOURS, DEFAULT_START_HOUR } from '../../../shared/dayNight.mjs';
import type { PlayerTransformLogState } from '../../debug/PlayerTransformLogRecorder';

interface TimePresetDefinition {
  label: string;
  hour: number;
}

/** 调试用的四个整点时段；请求仍由服务端按场景配置决定接不接受。 */
const TIME_PRESETS: readonly TimePresetDefinition[] = Object.freeze([
  { label: '午夜', hour: DAY_PHASE_HOURS.midnight },
  { label: '拂晓', hour: DAY_PHASE_HOURS.dawn },
  { label: '正午', hour: DAY_PHASE_HOURS.noon },
  { label: '黄昏', hour: DAY_PHASE_HOURS.dusk },
]);

function formatClock(timeOfDay: number): string {
  const totalMinutes = Math.round(timeOfDay * 60) % (24 * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function describePhase(timeOfDay: number): string {
  if (timeOfDay < 5 || timeOfDay >= 22) return '深夜';
  if (timeOfDay < 7) return '拂晓';
  if (timeOfDay < 9) return '清晨';
  if (timeOfDay < 16) return '白昼';
  if (timeOfDay < 19) return '黄昏';
  return '入夜';
}

export class DebugMenuPage extends ModalWindow {
  private readonly transformLogButton: HTMLButtonElement;
  private readonly transformLogStatus: HTMLParagraphElement;
  private readonly collisionButton: HTMLButtonElement;
  private readonly temperatureButton: HTMLButtonElement;
  private readonly weatherButtons = new Map<WeatherType, HTMLButtonElement>();
  private readonly dayNightStatus: HTMLParagraphElement;
  private readonly cppSmokeStatus: HTMLParagraphElement;
  private timeOfDaySelectHandler?: (timeOfDay: number) => void;
  private collisionToggleHandler?: (visible: boolean) => void;
  private temperatureToggleHandler?: (visible: boolean) => void;
  private weatherSelectHandler?: (weather: WeatherType) => void;
  private transformLogToggleHandler?: (recording: boolean) => void;
  private transformLogState: PlayerTransformLogState = 'inactive';
  private transformLogAvailable = false;
  private transformLogMessage?: string;
  private collisionVisible = false;
  private temperatureVisible = false;

  public constructor() {
    super({
      id: 'development-debug-menu',
      kicker: 'DEVELOPMENT ONLY · F8',
      title: '调试菜单',
      description: '检查玩家同步与运行时 Actor 状态，并向房间服务端请求调试操作。',
      size: 'compact',
    });

    const transformLogSection = document.createElement('section');
    transformLogSection.className = 'debug-menu__section';
    const transformLogHeading = document.createElement('h3');
    transformLogHeading.textContent = 'PLAYER TRANSFORM SYNC';
    const transformLogDescription = document.createElement('p');
    transformLogDescription.textContent = '同时记录本地预测/和解与房间服务端权威移动，停止后在 logs 目录生成 client、server 两段日志。';
    this.transformLogButton = document.createElement('button');
    this.transformLogButton.className = 'paper-button debug-menu__toggle';
    this.transformLogButton.type = 'button';
    this.transformLogButton.addEventListener('click', () => {
      if (this.transformLogState === 'inactive') {
        this.setTransformLogState('starting');
        this.transformLogToggleHandler?.(true);
      } else if (this.transformLogState === 'recording') {
        this.setTransformLogState('stopping');
        this.transformLogToggleHandler?.(false);
      }
    });
    this.transformLogStatus = document.createElement('p');
    this.transformLogStatus.className = 'debug-menu__status';
    this.transformLogStatus.setAttribute('role', 'status');
    transformLogSection.append(
      transformLogHeading,
      transformLogDescription,
      this.transformLogButton,
      this.transformLogStatus,
    );

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

    const dayNightSection = document.createElement('section');
    dayNightSection.className = 'debug-menu__section';
    const dayNightHeading = document.createElement('h3');
    dayNightHeading.textContent = 'ROOM DAY / NIGHT';
    const dayNightDescription = document.createElement('p');
    dayNightDescription.textContent = '服务端只同步时刻与一天的真实秒数；天空渐变、日月轨迹、环境光与星空由客户端本地推导。';
    this.dayNightStatus = document.createElement('p');
    this.dayNightStatus.className = 'debug-menu__status debug-menu__clock';
    this.dayNightStatus.setAttribute('role', 'status');
    const timeGrid = document.createElement('div');
    timeGrid.className = 'debug-menu__weather-grid';
    timeGrid.setAttribute('role', 'group');
    timeGrid.setAttribute('aria-label', '请求房间时刻');
    for (const preset of TIME_PRESETS) {
      const button = document.createElement('button');
      button.className = 'paper-button debug-menu__weather-button';
      button.type = 'button';
      button.dataset.timeOfDay = String(preset.hour);
      button.textContent = preset.label;
      button.addEventListener('click', () => this.timeOfDaySelectHandler?.(preset.hour));
      timeGrid.append(button);
    }
    dayNightSection.append(
      dayNightHeading,
      dayNightDescription,
      timeGrid,
      this.dayNightStatus,
    );

    const cppSmokeSection = document.createElement('section');
    cppSmokeSection.className = 'debug-menu__section';
    const cppSmokeHeading = document.createElement('h3');
    cppSmokeHeading.textContent = 'NATIVE C++ (WASM)';
    const cppSmokeDescription = document.createElement('p');
    cppSmokeDescription.textContent = '自检 native/cppsmoke 这条 C++ → WebAssembly 链路：产物能实例化、跨语言传参与返回值正确。它没有玩法作用，失败也不影响进游戏。';
    this.cppSmokeStatus = document.createElement('p');
    this.cppSmokeStatus.className = 'debug-menu__status';
    this.cppSmokeStatus.setAttribute('role', 'status');
    cppSmokeSection.append(cppSmokeHeading, cppSmokeDescription, this.cppSmokeStatus);

    this.bodyElement.append(
      // 房间环境是最常用的即时调试项，放在首屏，避免被较长的诊断区挤到
      // 滚动区域底部后看起来像是没有昼夜控制。
      dayNightSection,
      weatherSection,
      transformLogSection,
      collisionSection,
      temperatureSection,
      cppSmokeSection,
    );
    this.setTransformLogState('inactive');
    this.setTransformLogAvailable(false);
    this.setCollisionVisible(false);
    this.setTemperatureVisible(false);
    this.setWeather(DEFAULT_WEATHER);
    this.setTimeOfDay(DEFAULT_START_HOUR);
    this.setCppSmokeStatus('正在加载 C++ 冒烟模块…');
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

  public onTimeOfDaySelect(handler: (timeOfDay: number) => void): void {
    this.timeOfDaySelectHandler = handler;
  }

  public onTransformLogToggle(handler: (recording: boolean) => void): void {
    this.transformLogToggleHandler = handler;
  }

  public setTransformLogAvailable(available: boolean): void {
    this.transformLogAvailable = available;
    if (this.transformLogState === 'inactive' && this.transformLogMessage === undefined) {
      this.transformLogStatus.textContent = available
        ? '可以开始记录；关闭 F8 菜单后正常复现移动问题。'
        : '进入房间并生成玩家角色后可以开始记录。';
    }
    this.updateTransformLogButton();
  }

  public setTransformLogState(state: PlayerTransformLogState, message?: string): void {
    this.transformLogState = state;
    this.transformLogMessage = message;
    this.transformLogStatus.textContent = message ?? (
      state === 'recording'
        ? '正在记录当前玩家的 Transform 同步链路。'
        : state === 'starting'
          ? '正在等待服务端开启录制…'
          : state === 'stopping'
            ? '正在关闭录制并写入日志…'
            : this.transformLogAvailable
              ? '可以开始记录；关闭 F8 菜单后正常复现移动问题。'
              : '进入房间并生成玩家角色后可以开始记录。'
    );
    this.updateTransformLogButton();
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

  /** 显示房间同步过来的时刻；dayLengthSeconds 为 0 表示时钟被冻结。 */
  public setTimeOfDay(timeOfDay: number, dayLengthSeconds = 0): void {
    const pace = dayLengthSeconds > 0
      ? `一天 ${Math.round(dayLengthSeconds)} 秒`
      : '时钟已冻结';
    this.dayNightStatus.textContent =
      `${formatClock(timeOfDay)} · ${describePhase(timeOfDay)} · ${pace}`;
  }

  public setWeather(weather: WeatherType): void {
    for (const [candidate, button] of this.weatherButtons) {
      button.setAttribute('aria-pressed', String(candidate === weather));
    }
  }

  /** 显示 C++ → WASM 冒烟自检的结论，由 runCppSmoke() 产出。 */
  public setCppSmokeStatus(message: string): void {
    this.cppSmokeStatus.textContent = message;
  }

  public onOpen(): void {
    (this.transformLogAvailable ? this.transformLogButton : this.collisionButton).focus();
  }

  private updateTransformLogButton(): void {
    const recording = this.transformLogState === 'recording';
    this.transformLogButton.setAttribute('aria-pressed', String(recording));
    this.transformLogButton.disabled = (
      this.transformLogState === 'starting'
      || this.transformLogState === 'stopping'
      || (!this.transformLogAvailable && this.transformLogState === 'inactive')
    );
    this.transformLogButton.textContent = this.transformLogState === 'starting'
      ? '正在开启…'
      : this.transformLogState === 'stopping'
        ? '正在保存…'
        : recording
          ? '停止并保存 Transform 日志'
          : '开始记录玩家 Transform';
  }
}
