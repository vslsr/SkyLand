import { ModalWindow } from '../common/ModalWindow';
import {
  DEFAULT_WEATHER,
  WEATHER_LABELS,
  WEATHER_TYPES,
  type WeatherType,
} from '../../weather/index';
import { DAY_PHASE_HOURS, DEFAULT_START_HOUR } from '../../../shared/dayNight.mjs';
import { itemCatalog } from '../../../shared/items/index.mjs';
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

interface HealthPresetDefinition {
  label: string;
  target: 'self' | 'nearest';
  amount: number;
}

/**
 * 调试伤害与治疗的几个档。**这是工具武器落地之前的临时入口**：设计稿里
 * `@w` 的 `D` 还没有承接系统，生命值系统需要一个能看得见的触发点。
 */
const HEALTH_PRESETS: readonly HealthPresetDefinition[] = Object.freeze([
  { label: '打最近的 -25', target: 'nearest', amount: -25 },
  { label: '打最近的 -100', target: 'nearest', amount: -100 },
  { label: '打自己 -25', target: 'self', amount: -25 },
  { label: '治自己 +25', target: 'self', amount: 25 },
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
  private readonly giveItemButton: HTMLButtonElement;
  private readonly giveItemMenu: HTMLElement;
  private readonly giveItemStatus: HTMLParagraphElement;
  private itemGrantHandler?: (itemType: string) => void;
  private readonly transformLogButton: HTMLButtonElement;
  private readonly transformLogStatus: HTMLParagraphElement;
  private readonly collisionButton: HTMLButtonElement;
  private readonly temperatureButton: HTMLButtonElement;
  private readonly profilerButton: HTMLButtonElement;
  private readonly weatherButtons = new Map<WeatherType, HTMLButtonElement>();
  private readonly dayNightStatus: HTMLParagraphElement;
  private timeOfDaySelectHandler?: (timeOfDay: number) => void;
  private collisionToggleHandler?: (visible: boolean) => void;
  private temperatureToggleHandler?: (visible: boolean) => void;
  private profilerToggleHandler?: (visible: boolean) => void;
  private weatherSelectHandler?: (weather: WeatherType) => void;
  private healthCommandHandler?: (target: 'self' | 'nearest', amount: number) => void;
  private transformLogToggleHandler?: (recording: boolean) => void;
  private transformLogState: PlayerTransformLogState = 'inactive';
  private transformLogAvailable = false;
  private transformLogMessage?: string;
  private collisionVisible = false;
  private temperatureVisible = false;
  private profilerVisible = false;

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

    const profilerSection = document.createElement('section');
    profilerSection.className = 'debug-menu__section';
    const profilerHeading = document.createElement('h3');
    profilerHeading.textContent = 'FRAME PROFILER';
    const profilerDescription = document.createElement('p');
    profilerDescription.textContent = '在画面左上角显示两条线程各自的帧耗时分位数。'
      + '帧循环在渲染线程上，卡顿要看那一行；主线程只剩发命令。';
    this.profilerButton = document.createElement('button');
    this.profilerButton.className = 'paper-button debug-menu__toggle';
    this.profilerButton.type = 'button';
    this.profilerButton.addEventListener('click', () => {
      this.setProfilerVisible(!this.profilerVisible);
      this.profilerToggleHandler?.(this.profilerVisible);
    });
    profilerSection.append(profilerHeading, profilerDescription, this.profilerButton);

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

    // 物品那一栏：列的是**物品目录本身**，不是一张写死的清单——目录里加一件东西，
    // 这里就多一条，不用有人记得回来补。
    const giveItemSection = document.createElement('section');
    giveItemSection.className = 'debug-menu__section';
    const giveItemHeading = document.createElement('h3');
    giveItemHeading.textContent = 'GIVE ITEM';
    const giveItemDescription = document.createElement('p');
    giveItemDescription.textContent = '点开列表，点一件就给自己一个。'
      + '落点和拾取完全一样：先手上、再物品栏、最后背包——身上满了就给不进去。';
    this.giveItemButton = document.createElement('button');
    this.giveItemButton.className = 'paper-button debug-menu__toggle';
    this.giveItemButton.type = 'button';
    this.giveItemButton.setAttribute('aria-haspopup', 'menu');
    this.giveItemButton.addEventListener('click', () => this.setGiveItemMenuOpen(this.giveItemMenu.hidden));

    // 菜单收在按钮下面而不是浮在窗口外：F8 这个窗口自己会滚动，浮层挂进来会被
    // 裁掉半截，挂到外面又得自己算位置。物品多起来时它自己滚。
    this.giveItemMenu = document.createElement('div');
    this.giveItemMenu.className = 'debug-menu__item-menu';
    this.giveItemMenu.setAttribute('role', 'menu');
    this.giveItemMenu.setAttribute('aria-label', '所有物品');
    this.giveItemMenu.hidden = true;
    for (const definition of itemCatalog.list()) {
      const button = document.createElement('button');
      button.className = 'paper-button debug-menu__item-button';
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.dataset.itemType = definition.id;
      // 名字后面跟一个暗一点的 id：调试时要对着的是目录里那一条，而重名和改名
      // 都只在名字那一侧发生。
      const label = document.createElement('span');
      label.textContent = definition.displayName;
      const id = document.createElement('span');
      id.className = 'debug-menu__item-id';
      id.textContent = definition.id;
      button.append(label, id);
      button.setAttribute('aria-label', `给自己一个${definition.displayName}`);
      button.addEventListener('click', () => {
        this.itemGrantHandler?.(definition.id);
        // 给出去没有由下一帧快照说了算，这里只回执「已经请求了哪一件」——
        // 写「已获得」会在背包满的时候撒谎。
        this.giveItemStatus.textContent = `已请求 ${definition.displayName} ×1；背包里没有就是没收下。`;
        this.setGiveItemMenuOpen(false);
      });
      this.giveItemMenu.append(button);
    }
    this.giveItemStatus = document.createElement('p');
    this.giveItemStatus.className = 'debug-menu__status';
    this.giveItemStatus.setAttribute('role', 'status');
    giveItemSection.append(
      giveItemHeading,
      giveItemDescription,
      this.giveItemButton,
      this.giveItemMenu,
      this.giveItemStatus,
    );

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

    // 生命值：工具武器落地之前，这一组按钮是唯一能产生伤害的入口，
    // 生命值系统的飘字、死亡动画与自由视角都靠它验证。
    const healthSection = document.createElement('section');
    healthSection.className = 'debug-menu__section';
    const healthHeading = document.createElement('h3');
    healthHeading.textContent = 'ENTITY HEALTH';
    const healthDescription = document.createElement('p');
    healthDescription.textContent = '临时验证入口：工具与武器尚未落地，先用它触发权威伤害与治疗。目标由服务端判定，只能是自己或身边最近的生物。';
    const healthGrid = document.createElement('div');
    healthGrid.className = 'debug-menu__weather-grid';
    healthGrid.setAttribute('role', 'group');
    healthGrid.setAttribute('aria-label', '调试伤害与治疗');
    for (const preset of HEALTH_PRESETS) {
      const button = document.createElement('button');
      button.className = 'paper-button debug-menu__weather-button';
      button.type = 'button';
      button.textContent = preset.label;
      button.addEventListener('click', () => this.healthCommandHandler?.(preset.target, preset.amount));
      healthGrid.append(button);
    }
    healthSection.append(healthHeading, healthDescription, healthGrid);

    this.bodyElement.append(
      // 房间环境是最常用的即时调试项，放在首屏，避免被较长的诊断区挤到
      // 滚动区域底部后看起来像是没有昼夜控制。
      dayNightSection,
      weatherSection,
      giveItemSection,
      transformLogSection,
      profilerSection,
      collisionSection,
      temperatureSection,
      healthSection,
    );
    this.setGiveItemMenuOpen(false);
    this.setTransformLogState('inactive');
    this.setTransformLogAvailable(false);
    this.setProfilerVisible(false);
    this.setCollisionVisible(false);
    this.setTemperatureVisible(false);
    this.setWeather(DEFAULT_WEATHER);
    this.setTimeOfDay(DEFAULT_START_HOUR);
  }

  /** 调试伤害 / 治疗。`amount` 为负是伤害、为正是治疗。 */
  public onHealthCommand(
    handler: (target: 'self' | 'nearest', amount: number) => void,
  ): void {
    this.healthCommandHandler = handler;
  }

  public onProfilerToggle(handler: (visible: boolean) => void): void {
    this.profilerToggleHandler = handler;
  }

  public onCollisionToggle(handler: (visible: boolean) => void): void {
    this.collisionToggleHandler = handler;
  }

  public onTemperatureToggle(handler: (visible: boolean) => void): void {
    this.temperatureToggleHandler = handler;
  }

  /** 关掉 F8 就把物品列表收起来：下次打开不该看见上一次翻开的那一半。 */
  public onClose(): void {
    this.setGiveItemMenuOpen(false);
  }

  /** 点了列表里的一件：由场景把它发成一条 `debug:give-item`。 */
  public onItemGrant(handler: (itemType: string) => void): void {
    this.itemGrantHandler = handler;
  }

  private setGiveItemMenuOpen(open: boolean): void {
    this.giveItemMenu.hidden = !open;
    this.giveItemButton.setAttribute('aria-expanded', String(open));
    this.giveItemButton.textContent = open ? '收起物品列表' : '选择物品…';
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

  public setProfilerVisible(visible: boolean): void {
    this.profilerVisible = visible;
    this.profilerButton.setAttribute('aria-pressed', String(visible));
    this.profilerButton.textContent = visible ? '关闭帧耗时面板' : '打开帧耗时面板';
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
