import { FlyController } from '../camera/FlyController';
import { GameInteractionLayer } from '../interaction/GameInteractionLayer';
import { isDevelopmentRuntime } from '../debug/developmentRuntime';
import { recordReconciliation } from '../debug/mainThreadPacing';
import { PerformanceOverlay } from '../debug/PerformanceOverlay';
import { PlayerTransformLogRecorder } from '../debug/PlayerTransformLogRecorder';
import {
  createPlayerInputScheme,
  GamepadInputDevice,
  InputSubsystem,
  type InputSchemeRuntime,
  KeyboardMouseInputDevice,
  PlayerInputMappingIds,
  VirtualControls,
  VirtualInputDevice,
} from '../input/index';
import { SceneControlRouter } from '../controllers/SceneControlRouter';
import { ActorInteractionController } from '../controllers/ActorInteractionController';
import { BuildController } from '../controllers/BuildController';
import { PointerRayTracker } from '../controllers/PointerRayTracker';
import { InventoryController } from '../controllers/InventoryController';
import { HotbarController } from '../controllers/HotbarController';
import { ContainerController } from '../controllers/ContainerController';
import { ContainerPage } from '../ui/pages/ContainerPage';
import type { TagLike } from '../tags';
import { HoldProgressBadge } from '../ui/HoldProgressBadge';
import { HotbarBar } from '../ui/HotbarBar';
import { buildInventoryView } from '../inventory/index';
import { TerrainEditController } from '../controllers/TerrainEditController';
import { VesselControlController } from '../controllers/VesselControlController';
import { RoomClient, type JoinedRoom, type RoomSummary } from '../network/RoomClient';
import { SnapshotBuffer } from '../network/SnapshotBuffer';
import type { InterpolatedPlayerState, RoomSnapshot } from '../network/protocol';
import {
  HealthPopupEmitter,
  healthPopupAnchorY,
} from '../health/HealthPopupEmitter';
import {
  WEAPON_AIM_SHARPNESS,
  WeaponAimController,
} from '../controllers/WeaponAimController';
import { frameTimeline } from '../platform/index';
import { PlayerEntity } from '../player/PlayerEntity';
import { SlimeSurfaceDragController } from '../controllers/SlimeSurfaceDragController';
import { RemotePlayerGroup } from '../player/RemotePlayerGroup';
import { collectBiters, resolveBiteTips } from '../player/slimeBiteTip';
import { createSlimeBiteParams, type SlimeBiteParams } from '../render/RenderSlimeBite';
import type { SlimeSurfaceDragState } from '../render/RenderScene';
import { SceneRenderer } from '../rendering/SceneRenderer';
import { connectRenderWorldInWorker } from '../render/worker/connectRenderWorldInWorker';
import { SceneCompositionHost } from '../scene/SceneCompositionHost';
import { SceneWorld } from '../scene/SceneWorld';
import type { SceneUpdateContext } from '../scene/SceneVisualSystem';
import { createSceneRuntimeComponent, SceneComponentHost } from '../scene/components';
import {
  INPUT_SEND_INTERVAL_SECONDS,
  SLIME_DRAG_SEND_INTERVAL_SECONDS,
} from '../../shared/networkTuning.mjs';
import {
  INVENTORY_COMPONENT,
  type InventoryComponent,
  PICKUP_DROP_COMPONENT,
  type PickupDropComponent,
  resolveHeldItemAction,
} from '../../shared/actor/index.mjs';
import { createHullBuildGrid, footprintBlocked } from '../../shared/build/index.mjs';
import { PLAYER_COLLISION_RADIUS } from '../../shared/playerMovement.mjs';
import { HudController } from '../ui/HudController';
import { TerrainEditorPanel } from '../ui/TerrainEditorPanel';
import { BuildPanel } from '../ui/BuildPanel';
import { CreateRoomPage, type CreateRoomFormValue } from '../ui/pages/CreateRoomPage';
import { DebugMenuPage } from '../ui/pages/DebugMenuPage';
import { GameMenuPage } from '../ui/pages/GameMenuPage';
import { InventoryPage } from '../ui/pages/InventoryPage';
import { RoomLobbyPage } from '../ui/pages/RoomLobbyPage';
import { Scene, type SceneUIContext } from './Scene';
import type {
  ActorArchetypeDefinition,
  SceneSummary,
} from './data/SceneDefinition';

export interface GrasslandSceneOptions extends SceneUIContext {
  canvas: HTMLCanvasElement;
}

export class GrasslandScene extends Scene {
  private readonly canvas: HTMLCanvasElement;
  private readonly baseLayer: HTMLElement;
  private readonly developmentRuntime = isDevelopmentRuntime();
  private readonly inputScheme: InputSchemeRuntime = createPlayerInputScheme({
    includeDevelopmentMappings: this.developmentRuntime,
  });
  private readonly input: InputSubsystem;
  private readonly virtualControls: VirtualControls;
  private readonly renderer: SceneRenderer;
  private readonly world: SceneWorld;
  private readonly composition: SceneCompositionHost;
  private readonly sceneComponents = new SceneComponentHost(createSceneRuntimeComponent);
  private readonly flyController: FlyController;
  private readonly controls: SceneControlRouter;
  private readonly vesselControls: VesselControlController;
  private readonly actorInteractions: ActorInteractionController;
  private readonly terrainEdits: TerrainEditController;
  private readonly terrainEditorPanel = new TerrainEditorPanel();
  private readonly builds: BuildController;
  /** 手持武器时的瞄准与蓄力抛物线。见 `WeaponAimController`。 */
  private readonly weaponAim: WeaponAimController;
  private readonly buildPanel = new BuildPanel();
  /** 指针在画布上的最后位置；建造幽灵跟着它走，没有指针时退回准星。 */
  private readonly pointerRay: PointerRayTracker;
  private readonly gameInteractions = new GameInteractionLayer();
  private readonly hud = new HudController();
  /**
   * 玩家头上那条飘字。Replica 的那份由 `ClientActorSystem` 自己发——玩家不是
   * Replica，走的是 players 快照，所以这一条在这里。
   */
  private healthPopups?: HealthPopupEmitter;
  /** 上一帧本地玩家死了没有。只在翻面的那一帧切相机，不每帧重设。 */
  private localPlayerDead = false;
  private readonly roomClient = new RoomClient();
  private readonly lobbyPage = new RoomLobbyPage();
  private readonly gameMenuPage = new GameMenuPage();
  private readonly inventoryPage = new InventoryPage();
  private readonly inventory: InventoryController;
  private readonly hotbarBar = new HotbarBar();
  private readonly holdProgress = new HoldProgressBadge();

  /**
   * 当前绑定下这个 Action 的键位显示名。
   *
   * 交互提示那条文字、世界里的按键牌和按住进度环读的是同一份，重绑定之后三处
   * 一起变；分头各写一遍就会出现「提示说 E、圈上写着别的」。
   */
  /** 嘴上那件的 Actor id；空手时是 undefined。吃东西的表现要认得出是哪一件。 */
  private heldActorId(): string | undefined {
    const pickupDrop = this.player?.getComponent(PICKUP_DROP_COMPONENT) as
      PickupDropComponent | undefined;
    return pickupDrop?.heldActorId ?? undefined;
  }

  private readonly resolveInputLabel = (tag: TagLike): string | undefined => {
    const control = this.input.getMappedControls(tag)[0];
    return control ? this.inputScheme.getControlLabel(control) : undefined;
  };
  private readonly hotbar: HotbarController;
  private readonly containerPage = new ContainerPage();
  private readonly container: ContainerController;
  private readonly debugMenuPage?: DebugMenuPage;
  /** 帧耗时面板。只在开发运行时建，F8 里开关。 */
  private readonly performanceOverlay?: PerformanceOverlay;
  private readonly playerTransformLog?: PlayerTransformLogRecorder;
  private disposeDebugMenuShortcut?: () => void;
  private disposeInventoryShortcut?: () => void;
  private readonly snapshots = new SnapshotBuffer();
  private readonly remotePlayers: RemotePlayerGroup;
  /** 当前场景的玩家原型：算被咬住的那个尖要用它的半径、嘴挂点与抓握深度。 */
  private playerArchetype?: ActorArchetypeDefinition;
  /** 每帧复用的突起向量缓冲。 */
  private readonly biteTips: SlimeBiteParams = createSlimeBiteParams();
  /** 「谁被哪几张嘴咬着」：一帧算一次，本地玩家与远端玩家共用。 */
  private readonly biters = new Map<string, InterpolatedPlayerState[]>();
  private joinedRoom?: JoinedRoom;
  private availableScenes: SceneSummary[] = [];
  private player?: PlayerEntity;
  private slimeSurfaceDrag?: SlimeSurfaceDragController;
  private timeSinceInputSent = 0;
  private timeSinceSlimeDragSent = 0;
  /** 上一次成功上报的拖拽是否处于按住状态；决定松手后要不要补发一次结束。 */
  private slimeDragReplicated = false;
  /** 本地玩家正咬着别人；交互键这时说的是「松口」。权威状态来自快照。 */
  private localPlayerBiting = false;
  /** 快照里自己那条的位置。没有本地角色（自由镜头）时，建造靠它判距离。 */
  private localPlayerPosition?: { x: number; z: number };
  /** 复用的上报缓冲：拖拽每帧都可能被读一次，不该每次都分配一个对象。 */
  private readonly slimeDragState: SlimeSurfaceDragState = {
    contactX: 0, contactY: 0, contactZ: 0, pullX: 0, pullY: 0, pullZ: 0,
  };

  /** 暴露当前场景的实时绑定方案，供设置页或调试面板调用 rebind/reset。 */
  public get inputBindings(): InputSchemeRuntime {
    return this.inputScheme;
  }

  public constructor(options: GrasslandSceneOptions) {
    super('grassland', options);
    this.canvas = options.canvas;
    this.baseLayer = options.baseLayer;
    const virtualInput = new VirtualInputDevice();
    const keyboardInput = new KeyboardMouseInputDevice({
      pointerTarget: options.canvas,
      preventDefaultControls: this.inputScheme.getPreventDefaultControls(),
    });
    this.input = new InputSubsystem({
      actions: this.inputScheme.actions,
      config: this.inputScheme.config,
      contexts: this.inputScheme.contexts,
      devices: [
        keyboardInput,
        new GamepadInputDevice(),
        virtualInput,
      ],
    });
    if (this.developmentRuntime) {
      this.debugMenuPage = new DebugMenuPage();
      this.performanceOverlay = new PerformanceOverlay(options.baseLayer);
      this.playerTransformLog = new PlayerTransformLogRecorder({
        start: () => this.roomClient.startPlayerTransformLog(),
        append: (sessionId, events) => (
          this.roomClient.appendPlayerTransformLog(sessionId, events)
        ),
        stop: (sessionId, events) => (
          this.roomClient.stopPlayerTransformLog(sessionId, events)
        ),
      }, {
        onStateChange: (state, message) => {
          this.debugMenuPage?.setTransformLogState(state, message);
        },
      });
      this.debugMenuPage.onRequestClose(() => this.commonUI.pop(this.debugMenuPage));
      this.debugMenuPage.onTransformLogToggle((recording) => {
        if (!recording) {
          this.playerTransformLog?.stop();
          return;
        }
        const joinedRoom = this.joinedRoom;
        const player = this.player;
        if (!joinedRoom || !player) {
          this.debugMenuPage?.setTransformLogState('inactive', '请先进入房间并生成玩家角色。');
          return;
        }
        this.playerTransformLog?.begin({
          roomId: joinedRoom.room.id,
          roomName: joinedRoom.room.name,
          sceneId: joinedRoom.scene.id,
          playerId: joinedRoom.player.id,
          playerName: joinedRoom.player.name,
          initialState: player.captureTransformDebugState(),
        });
      });
      this.debugMenuPage.onProfilerToggle((visible) => {
        this.performanceOverlay?.setVisible(visible);
      });
      this.debugMenuPage.onCollisionToggle((visible) => {
        this.renderer.setSimpleCollisionVisible(visible);
      });
      this.debugMenuPage.onTemperatureToggle((visible) => {
        this.renderer.setTemperatureVisible(visible);
      });
      this.debugMenuPage.onWeatherSelect((weather) => {
        if (this.joinedRoom) this.roomClient.setWeather(weather);
      });
      this.debugMenuPage.onTimeOfDaySelect((timeOfDay) => {
        if (this.joinedRoom) this.roomClient.setTimeOfDay(timeOfDay);
      });
      this.debugMenuPage.onHealthCommand((target, amount) => {
        if (this.joinedRoom) this.roomClient.sendHealthDebug(target, amount);
      });
      this.debugMenuPage.onItemGrant((itemType) => {
        if (this.joinedRoom) this.roomClient.giveDebugItem(itemType);
      });
      this.refreshDebugMenuShortcut();
    }
    this.virtualControls = new VirtualControls({
      root: options.baseLayer,
      device: virtualInput,
      config: this.inputScheme.virtualControls,
    });
    this.inputScheme.onBindingsChanged(() => {
      this.input.replaceMappingContexts(this.inputScheme.contexts);
      keyboardInput.setPreventDefaultControls(this.inputScheme.getPreventDefaultControls());
      this.refreshDebugMenuShortcut();
      this.refreshInventoryShortcut();
    });
    // 渲染那一侧只在这一行里被决定。整个渲染循环跑在另一条线程上：
    // 画布经 `transferControlToOffscreen` 转移过去，相机与 transform SoA 是两块
    // `SharedArrayBuffer`，其余全是命令。下面三个类看不出区别。
    const render = connectRenderWorldInWorker(options.canvas);
    // 场景的两半：渲染核心与玩法查询。第 3 步搬 canvas 时只有前者跟着走。
    this.world = new SceneWorld(render.port);
    this.renderer = new SceneRenderer(options.canvas, this.world, render);
    // 一局的装配。它认识的是 `SceneComposition` 这份数据和两个接收方，
    // 既不认识 `THREE.Scene` 也不认识画布——canvas 搬进 worker 时它留在原地。
    this.composition = new SceneCompositionHost(this.world, render.port, this.renderer);
    this.remotePlayers = new RemotePlayerGroup(this.world);
    this.flyController = new FlyController(options.canvas, {
      position: [0, 4.2, 13.5],
      yaw: 0,
      pitch: -0.12,
      enabled: false,
      onLockChange: (locked) => this.hud.setLocked(locked),
    });
    this.controls = new SceneControlRouter(this.flyController);
    this.vesselControls = new VesselControlController(this.input, {
      getPlayerId: () => this.joinedRoom?.player.id,
      findOwnedActorId: (playerId) => this.world.findOwnedActorId(playerId),
      findControllableActorId: () => this.world.findControllableActorId(),
      requestControl: (actorId) => this.roomClient.requestActorControl(actorId),
      releaseControl: (actorId) => this.roomClient.releaseActorControl(actorId),
      sendInput: (actorId, input) => { this.roomClient.sendVesselInput(actorId, input); },
    });
    this.terrainEdits = new TerrainEditController(this.input, {
      pickCell: (frame) => this.world.pickTerrainCell(frame.position, frame.axes.forward),
      highlight: (cell) => this.renderer.setTerrainHighlight(cell),
      sendEdit: (cellX, cellZ, operation) => {
        this.roomClient.editTerrain(cellX, cellZ, operation);
      },
    });
    this.actorInteractions = new ActorInteractionController(this.input, {
      getPlayerId: () => this.joinedRoom?.player.id,
      getPlayerPosition: () => this.player?.controller.position,
      findOwnedActorId: (playerId) => this.world.findOwnedActorId(playerId),
      pick: (frame) => this.world.pickActorInteraction(frame),
      findNearby: (position) => this.world.findNearbyActorInteraction(position),
      findHeld: (playerId) => this.world.findHeldActorInteraction(playerId),
      getInputLabel: (tag) => this.resolveInputLabel(tag),
      setHoveredActorId: (actorId) => this.world.setHoveredActorId(actorId),
      setInteractionMarkerActorId: (actorId, inputLabel, opacity) => {
        this.world.setInteractionMarkerActorId(actorId, inputLabel, opacity);
      },
      sendInteraction: (actorId) => { this.roomClient.interactWithActor(actorId); },
      setPrompt: (text, opacity) => this.hud.setInteractionPrompt(text, opacity),
      isBiting: () => this.localPlayerBiting,
      sendBite: () => { this.roomClient.toggleBite(); },
    });
    // 建造：指针射线打到的点吸附成格位、按共享规则给幽灵判红绿，交互键把**格坐标**
    // 发给服务端。放不放得下由服务端按同一份规则裁决，这里只负责预期。
    this.pointerRay = new PointerRayTracker(options.canvas);
    this.builds = new BuildController(this.input, {
      // 自由镜头的图没有本地角色，但服务端仍按权威角色判距离——用快照里自己
      // 那条兜底，幽灵才不会在够不着的地方也是绿的。
      getPlayerPosition: () => this.player?.controller.position ?? this.localPlayerPosition,
      pointerRay: () => this.pointerRay.resolve(this.renderer.getCameraView()),
      pickPoint: (origin, direction) => this.world.pickBuildPoint(origin, direction),
      listHulls: () => this.world.listBuildHulls(),
      hullGridOf: (hullArchetypeId) => {
        const hull = this.joinedRoom?.scene.actorArchetypes.find(
          (definition) => definition.id === hullArchetypeId,
        );
        return hull?.components.buildGrid ? createHullBuildGrid(hull.components.buildGrid) : undefined;
      },
      getSites: () => this.world.getBuildSites(),
      foundationTop: (surfaceKey, cellX, cellZ) => this.world.buildFoundationTop(surfaceKey, cellX, cellZ),
      hasLand: () => this.world.hasLand(),
      cellStatus: (cellX, cellZ) => this.world.buildCellStatus(cellX, cellZ),
      groundTop: (cellX, cellZ) => this.world.groundTopHeight(cellX, cellZ),
      seaLevel: () => this.world.seaLevel(),
      // 本地玩家不在碰撞世界里（它是预测实体），所以单独按脚下的圆柱判一次。
      isBlocked: (footprint, surfaceKey) => {
        const position = this.player?.controller.position;
        const player = position
          ? [{
            x: position.x,
            y: this.player?.controller.verticalPosition ?? 0,
            z: position.z,
            radius: PLAYER_COLLISION_RADIUS,
            height: PLAYER_COLLISION_RADIUS * 2,
          }]
          : [];
        return footprintBlocked(footprint, { forEachNear: () => undefined, cylinders: player })
          || this.world.buildFootprintBlocked(footprint, surfaceKey);
      },
      getInventory: () => this.player?.getComponent(INVENTORY_COMPONENT) as
        InventoryComponent | undefined,
      findPieceNear: (x, z, radius) => this.world.findBuildPieceNear(x, z, radius),
      getInputLabel: (tag) => {
        const control = this.input.getMappedControls(tag)[0];
        return control ? this.inputScheme.getControlLabel(control) : undefined;
      },
      setHoveredActorId: (actorId) => this.world.setHoveredActorId(actorId),
      setPreview: (state) => this.renderer.setBuildPreview(state),
      setPrompt: (text) => this.hud.setInteractionPrompt(text),
      send: (command) => { this.roomClient.sendBuildCommand(command); },
    });
    this.inventory = new InventoryController(this.inventoryPage, this.input, {
      getInventory: () => this.player?.getComponent(INVENTORY_COMPONENT) as
        InventoryComponent | undefined,
      // 背包里点「使用」授予的是一条能力，激活要按使用键——输入层得知道接下来
      // 那一下说的是哪件东西，两边说的必须是同一件。
      armItem: (itemType) => this.hotbar.armItem(itemType),
      isOpen: () => this.commonUI.top === this.inventoryPage,
      setOpen: (open) => {
        if (open) this.commonUI.push(this.inventoryPage);
        else this.commonUI.pop(this.inventoryPage);
      },
      // 只在没有别的页面盖着时开，背包因此永远是栈顶那一页。
      canOpen: () => Boolean(this.joinedRoom && this.player) && this.commonUI.size === 0,
      send: (command) => { this.roomClient.sendInventoryCommand(command); },
    });
    this.hotbar = new HotbarController(this.input, {
      getInventory: () => this.player?.getComponent(INVENTORY_COMPONENT) as
        InventoryComponent | undefined,
      // 嘴上那个 Actor：叼着的蘑菇和快捷栏拿出来的手持物都在这里，
      // 所以两种手持物走同一条按住计时。
      getHeldActorId: () => this.heldActorId(),
      // 界面盖着时不响应：背包开着按 1 应该翻页而不是换手。
      // 建造模式下主键说的是「放这一件」：手上那件东西这一下不该被吃掉、丢出去。
      isActive: () => Boolean(this.joinedRoom && this.player)
        && this.commonUI.allowsGameInteraction
        && !this.builds.active,
      send: (command) => { this.roomClient.sendInventoryCommand(command); },
      getInputLabel: (tag) => this.resolveInputLabel(tag),
      // 同一次按住只画一处。属于物品栏的那次画在格子上（`onHotbar`），因为那圈
      // 已经同时说清了「哪一格」和「还要多久」；叼着的蘑菇和从背包里点出来的
      // 用法没有格子，才轮到准星下方那块牌子。两处一起亮会让玩家的眼睛在画面
      // 两端来回找同一件事。
      setProgress: (progress) => {
        this.hotbarBar.setProgress(progress);
        this.holdProgress.setProgress(progress?.onHotbar ? undefined : progress);
        // 吃东西那一段跟着这次按住走：圈满那一刻服务端扣账，抖动与食物同时停。
        // 玩家模型和手上那件食物读同一个比例，所以它们嚼在同一拍上。
        // 蓄力那条白线和物品栏那圈读同一个比例：线的长度就是圈的进度。
        this.weaponAim.setChargeRatio(progress?.action === 'shoot' ? progress.ratio : undefined);
        const chewing = progress?.action === 'eat' ? progress.ratio : undefined;
        this.player?.setChewing(chewing);
        this.world.setChewingItem(chewing === undefined ? undefined : this.heldActorId(), chewing ?? 0);
      },
      // 松手那一下才射箭。收圈的路子不止这一条（换手、盖界面、进建造模式都收），
      // 那几下不该有箭飞出去，所以这一条和 setProgress 分开走。
      onUseRelease: (action, ratio) => {
        if (action === 'shoot') this.weaponAim.fire(ratio);
      },
    });
    this.weaponAim = new WeaponAimController({
      // 建造模式独占主键，界面盖着时也不该继续瞄准。
      isActive: () => Boolean(this.joinedRoom && this.player)
        && this.commonUI.allowsGameInteraction
        && !this.builds.active
        && !this.localPlayerDead,
      getHeldWeapon: () => {
        const use = resolveHeldItemAction(
          (this.player?.getComponent(INVENTORY_COMPONENT) as InventoryComponent | undefined)
            ?.heldItemType,
        );
        return use?.weapon ? { weapon: use.weapon } : undefined;
      },
      getPlayer: () => {
        const render = this.player?.renderPosition;
        if (!render) return undefined;
        return { x: render.x, y: render.y, z: render.z, yaw: this.player!.controller.facing.yaw };
      },
      pointerRay: () => this.pointerRay.resolve(this.renderer.getCameraView()),
      sampleGroundHeight: (x, z) => this.world.sampleGroundHeight(x, z),
      setFacingTarget: (target) => {
        this.player?.controller.setFacingRequest(
          target ? { target, sharpness: WEAPON_AIM_SHARPNESS } : undefined,
        );
      },
      setPreview: (state) => this.renderer.setBallisticPreview(state),
      spawnArrow: (state) => this.renderer.spawnArrowShot(state),
    });
    this.container = new ContainerController(this.containerPage, {
      getInventory: () => this.player?.getComponent(INVENTORY_COMPONENT) as
        InventoryComponent | undefined,
      getContainer: (actorId) => this.world.getContainer?.(actorId),
      findOpenContainerActorId: () => this.world.findOpenContainerActorId?.(),
      isOpen: () => this.commonUI.top === this.containerPage,
      setOpen: (open) => {
        if (open) this.commonUI.push(this.containerPage);
        else this.commonUI.pop(this.containerPage);
      },
      send: (command) => { this.roomClient.sendInventoryCommand(command); },
    });
    this.containerPage.onRequestClose(() => this.container.requestClose());
    // 点一下快捷栏那一格 = 切到它；点一下背包里那件东西 = 弹出使用/装备/丢弃菜单。
    // 两条都只发意图，成没成以下一帧快照为准。
    // 快捷栏挂在 HUD 层而不是 CommonUI 栈里：它在游戏进行中一直可见可点，
    // 不参与页面压栈，也不该被背包盖住。
    document.getElementById('hotbar-root')?.append(this.hotbarBar.element);
    // 按住进度环是只读 HUD：贴在准星下方，pointer-events 关掉，不参与命中测试。
    this.baseLayer.append(this.holdProgress.element);
    this.hotbarBar.onSelect((slotIndex) => {
      this.roomClient.sendInventoryCommand({ kind: 'select', slotIndex });
    });
    this.controls.onModeChange((mode) => this.hud.setControlMode(mode));

    this.commonUI.onStackChange(() => {
      const allowsGameInteraction = this.commonUI.allowsGameInteraction;
      if (!allowsGameInteraction) this.virtualControls.reset();
      this.input.setEnabled(allowsGameInteraction);
      this.controls.setInputEnabled(allowsGameInteraction);
    });
    this.commonUI.setBaseEventHandler((event) => this.gameInteractions.dispatch(event));
    this.lobbyPage.onRefresh(() => void this.refreshRooms());
    this.lobbyPage.onCreate((temporaryName) => this.openCreateRoom(temporaryName));
    this.lobbyPage.onJoin((room, temporaryName) => void this.joinRoom(room, temporaryName));
    this.hud.onMenuRequest(() => this.openGameMenu());
    this.gameMenuPage.onRequestClose(() => this.commonUI.pop(this.gameMenuPage));
    this.gameMenuPage.onExit(() => this.exitCurrentRoom());
    this.inventoryPage.onRequestClose(() => this.inventory.close());
    this.refreshInventoryShortcut();
    this.roomClient.onRoomUpdate((room) => this.handleRoomUpdate(room));
    this.terrainEditorPanel.onOperationChange((operation) => {
      this.terrainEdits.setOperation(operation);
      // 两条栏互斥：WorldInteract 同一时刻只能归一边。
      if (operation) this.buildPanel.setExpanded(false);
    });
    this.buildPanel.onSelectionChange((selection) => {
      this.builds.setSelection(selection);
      if (selection) this.terrainEditorPanel.setExpanded(false);
    });
    this.roomClient.onSnapshot((snapshot) => this.handleSnapshot(snapshot));
    this.roomClient.onPlayerTransformLogStatus((status) => {
      this.playerTransformLog?.handleStatus(status);
    });
    // 地形覆盖只从服务端来：客户端不做本地预测，避免脚下的世界两端不一致。
    this.roomClient.onTerrainPatch((cells) => this.world.applyTerrainPatches(cells));
    this.roomClient.onDisconnect(() => {
      this.playerTransformLog?.handleDisconnect();
      this.handleDisconnect();
    });
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    // 排在最前面：它数的是主线程的帧，晚了会把这一帧自己的耗时也算进去。
    this.performanceOverlay?.update(deltaSeconds);
    this.input.update();
    this.vesselControls.update(deltaSeconds);
    this.controls.update(deltaSeconds, elapsedSeconds);
    // 玩家（本地与远端）排在 renderer.update 之前：它们把自己这一帧的 transform
    // 与运动参数写进边界那段 SoA，而翻面发生在 renderer.update 里的 Actor 世界中。
    // 写在翻面之后就会晚一帧——软体读到的速度和它被摆到的位置对不上。
    this.slimeSurfaceDrag?.update();
    // 「sim」= 第 2 步要搬进 Sim Worker 的那一半：本地预测与远端插值。
    frameTimeline.measure('sim-player', () => {
      const localPlayerId = this.joinedRoom?.player.id;
      const states = localPlayerId ? this.snapshots.sample() : [];
      // 自己也可能正被别人咬着。那份形变由服务端按两边位姿推出来，本地不预测，
      // 所以和远端玩家走同一条路：读快照，写参数段，重放在渲染侧。
      const own = states.find((state) => state.id === localPlayerId);
      this.localPlayerBiting = own?.bitingPlayerId !== undefined;
      this.player?.setReplicatedSlimeDrag(own?.slimeDrag);
      // 血量是权威的，本地不预测：死亡计数写进参数段之后由渲染侧踢一次倒下动画。
      this.player?.setHealth(own?.health);
      this.syncLocalPlayerDeath();
      this.emitHealthPopups(states, localPlayerId);
      // 被咬住的尖不过网络：快照里只有「谁咬着谁」，两边的位置又都是权威的，
      // 所以这里按**这一帧插值后的**位置当场算，尖因此始终贴着那张嘴。
      collectBiters(states, this.biters);
      if (own && this.playerArchetype) {
        this.player?.setBiteTips(resolveBiteTips(
          own,
          this.biters.get(own.id),
          this.playerArchetype,
          this.biteTips,
        ));
      }
      // 缰绳要在这一帧的预测步之前落到 characterParams 上，重放才和权威一致。
      this.player?.setLeash(own?.leash);
      this.player?.update(deltaSeconds);
      if (localPlayerId && this.joinedRoom?.scene.camera.mode === 'topdown') {
        this.remotePlayers.sync(states, localPlayerId, this.biters);
        this.remotePlayers.update(deltaSeconds);
      } else {
        this.remotePlayers.clear();
      }
    });
    this.renderer.update(deltaSeconds, elapsedSeconds, this.currentFocus());
    // 相机在这里过边界，**紧跟在** renderer.update 里那次 transform 翻面之后：
    // 机位带着刚翻出去的 transform 帧号一起翻面，渲染线程等的就是机位这一面——
    // 等到时 transform 一定已经翻过，两段字节因此是同一帧的（RenderCameraBuffer）。
    // 顺序不能倒：机位先翻，渲染线程就可能画出「相机是这一帧、世界是上一帧」。
    // 写在 render() 里也能跑，但那时渲染循环已经在另一条线程上了，读不到这个对象。
    this.renderer.publishCamera(this.controls.frame);
    if (this.terrainEdits.active) {
      // 编辑模式独占 WorldInteract：同一次点击不能既改地形又去交互 Actor。
      this.terrainEdits.update(this.controls.frame);
      this.builds.reset();
      this.actorInteractions.reset();
      this.hotbar.reset();
      this.weaponAim.reset();
    } else if (this.builds.active) {
      // 建造模式同样独占：放件那一下不能顺手捡起脚边的东西或换手上的物品。
      // 两个 reset 要排在 builds.update 之前——它们会清掉交互提示与悬停，
      // 排在后面就会把建造刚写上去的那条提示连同拆除的高亮一起擦掉。
      this.actorInteractions.reset();
      this.hotbar.reset();
      this.weaponAim.reset();
      this.terrainEdits.update(this.controls.frame);
      this.builds.update(this.controls.frame);
    } else {
      this.terrainEdits.update(this.controls.frame);
      this.builds.update(this.controls.frame);
      this.actorInteractions.update(this.controls.frame, deltaSeconds);
      this.hotbar.update();
    }
    // 瞄准排在 hotbar 之后：这一帧的蓄力比例刚由它写进来。建造与地形编辑那两条
    // 分支里 hotbar 已经被 reset，所以那时武器也自然收起。
    this.weaponAim.update();
    const playerId = this.joinedRoom?.player.id;
    this.hud.setVesselStatus(playerId ? this.world.getVesselHudState(playerId) : undefined);
    this.sceneComponents.update(deltaSeconds, elapsedSeconds);
    this.sendPlayerInput(deltaSeconds);
    this.sendSlimeDrag(deltaSeconds);
  }

  public render(): void {
    frameTimeline.measure('draw', () => this.renderer.render());
  }

  /**
   * 死了就把相机交给自由视角，活着（或者换了角色）再交回去。
   *
   * 自由视角本来就是这个场景的**兜底控制器**（大厅背后飞的那一个），所以这里
   * 不需要另造一套：把玩家控制器摘掉，路由自己会切过去，并且带一段机位过渡。
   * 玩家控制器同时被 `setInputEnabled(false)`，于是不再产生任何预测步——
   * 服务端那一侧也已经把死者的输入丢掉了（见 ServerScene.stepPlayerOnce）。
   */
  private syncLocalPlayerDeath(): void {
    const dead = this.player?.dead === true;
    if (dead === this.localPlayerDead) return;
    this.localPlayerDead = dead;
    this.hud.setDead(dead);
    if (!this.player) return;
    this.controls.setPlayerController(dead ? undefined : this.player.controller);
  }

  /**
   * 玩家（自己和别人）头上的伤害 / 治疗飘字。
   *
   * 位置取的是**这一帧看到的那个身影**：自己用渲染坐标（含嚼东西那点抖动），
   * 别人用插值之后的位置，所以数字始终从头顶飞出来，而不是从上一份快照的位置。
   */
  private emitHealthPopups(
    states: readonly InterpolatedPlayerState[],
    localPlayerId: string | undefined,
  ): void {
    const emitter = this.healthPopups;
    const archetype = this.playerArchetype;
    if (!emitter || !archetype) return;
    const anchorY = healthPopupAnchorY(archetype.components.render);
    for (const state of states) {
      if (state.id === localPlayerId) {
        const render = this.player?.renderPosition;
        if (!render) continue;
        emitter.observe(state.id, state.health, render.x, render.y, render.z, anchorY);
        continue;
      }
      emitter.observe(state.id, state.health, state.x, state.y ?? 0, state.z, anchorY);
    }
  }

  /**
   * 世界应该围绕谁展开：有玩家时是玩家，还没有玩家时是相机。
   * 流式加载靠它决定加载哪些 chunk，大厅背后看到的因此也是一片正常的世界。
   */
  private currentFocus(): SceneUpdateContext {
    // 死了之后镜头自己飞，世界就该围着镜头转——否则玩家飞出去几百米，
    // 加载的还是尸体脚下那几块 chunk。
    const player = this.localPlayerDead ? undefined : this.player?.controller.position;
    if (player) {
      const render = this.player?.renderPosition;
      return {
        focusX: player.x,
        focusY: render?.y ?? 0,
        focusZ: player.z,
        // 表现侧要的是眼睛看到的那个身影，不是权威位置。
        playerRenderX: render?.x,
        playerRenderY: render?.y,
        playerRenderZ: render?.z,
      };
    }
    const [cameraX, cameraY, cameraZ] = this.controls.frame.position;
    return { focusX: cameraX, focusY: cameraY, focusZ: cameraZ };
  }

  protected onEnter(): void {
    this.sceneComponents.setActive(true);
    // 渲染世界里那批表现组件（落叶）跟着同一个开关。
    this.renderer.setSceneActive(true);
    if (this.joinedRoom) {
      return;
    }
    this.hud.setDisconnected();
    this.commonUI.push(this.lobbyPage);
    void this.refreshRooms();
  }

  protected onLeave(): void {
    this.sceneComponents.setActive(false);
    this.renderer.setSceneActive(false);
    this.virtualControls.reset();
    this.input.setEnabled(false);
    this.controls.setInputEnabled(false);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private async refreshRooms(): Promise<void> {
    this.lobbyPage.setLoading(true);
    try {
      const [rooms, scenes] = await Promise.all([
        this.roomClient.listRooms(),
        this.roomClient.listScenes(),
      ]);
      this.availableScenes = scenes;
      this.lobbyPage.setRooms(rooms);
    } catch (error) {
      this.lobbyPage.setError(this.getErrorMessage(error));
    }
  }

  private openCreateRoom(temporaryName: string): void {
    if (this.availableScenes.length === 0) {
      this.lobbyPage.setError('没有可用地图，请检查 config/scenes 配置。');
      return;
    }
    const page = new CreateRoomPage(temporaryName, this.availableScenes);
    page.onRequestClose(() => this.commonUI.pop(page));
    page.onSubmit((value) => void this.createAndJoinRoom(page, value));
    this.commonUI.push(page);
  }

  private async createAndJoinRoom(page: CreateRoomPage, value: CreateRoomFormValue): Promise<void> {
    page.setBusy(true);
    try {
      const room = await this.roomClient.createRoom(value.roomName, value.sceneId);
      const joined = await this.roomClient.joinRoom(room.id, value.temporaryName);
      this.completeJoin(joined);
    } catch (error) {
      page.setBusy(false);
      page.setError(this.getErrorMessage(error));
    }
  }

  private async joinRoom(room: RoomSummary, temporaryName: string): Promise<void> {
    this.lobbyPage.setBusy(true, `正在加入「${room.name}」…`);
    try {
      this.completeJoin(await this.roomClient.joinRoom(room.id, temporaryName));
    } catch (error) {
      this.lobbyPage.setBusy(false);
      this.lobbyPage.setError(this.getErrorMessage(error));
    }
  }

  private completeJoin(joined: JoinedRoom): void {
    if (!this.isActive) {
      this.roomClient.leaveRoom();
      return;
    }
    this.joinedRoom = joined;
    // 只有带 renderer.world 的流式地图才有可编辑地形。
    this.terrainEditorPanel.setAvailable(Boolean(joined.scene.renderer.world));
    // 建造栏只列这张地图声明的建造件；一件都没有的图连标签都不出现。
    this.buildPanel.setPieces(joined.scene.actorArchetypes.filter(
      (definition) => definition.components.buildPiece !== undefined,
    ));
    this.sceneComponents.clear();
    this.snapshots.clear();
    this.vesselControls.reset();
    this.actorInteractions.reset();
    this.builds.reset();
    this.hotbar.reset();
    // 装配归 SceneCompositionHost；渲染器只接住渲染那一半。
    this.renderer.resetEnvironment(joined.scene);
    this.composition.load(joined.scene, joined.room.worldSeed);
    this.flyController.configure(joined.scene.camera);
    const playerArchetype = joined.scene.actorArchetypes.find(
      (definition) => definition.id === joined.scene.gameplay.playerActor.archetypeId,
    );
    if (!playerArchetype) {
      throw new Error(`场景缺少玩家 Actor 原型：${joined.scene.gameplay.playerActor.archetypeId}`);
    }
    this.remotePlayers.configure(playerArchetype);
    this.playerArchetype = playerArchetype;
    if (joined.scene.camera.mode === 'topdown') {
      this.createPlayer(
        joined.player.id,
        joined.player.spawn,
        joined.scene.gameplay.bounds,
        playerArchetype,
        joined.scene.camera.position,
      );
    } else {
      this.controls.setPlayerController(undefined);
      this.remotePlayers.clear();
    }
    this.sceneComponents.load(joined.scene.sceneComponents, {
      definition: joined.scene,
      canvas: this.canvas,
      uiRoot: this.baseLayer,
      input: this.input,
      renderer: this.renderer,
      world: this.world,
      player: this.player,
      worldSeed: joined.room.worldSeed,
      getFocus: () => this.currentFocus(),
    });
    this.hud.setRoom(joined.room);
    this.debugMenuPage?.setTransformLogAvailable(Boolean(this.player));
    this.commonUI.clear();
  }

  private openGameMenu(): void {
    if (!this.joinedRoom || this.commonUI.size > 0) return;
    this.commonUI.push(this.gameMenuPage);
  }

  private toggleDebugMenu(): void {
    const page = this.debugMenuPage;
    if (!page) return;
    if (this.commonUI.top === page) {
      this.commonUI.pop(page);
      return;
    }
    page.setProfilerVisible(this.performanceOverlay?.visible ?? false);
    page.setCollisionVisible(this.renderer.isSimpleCollisionVisible);
    page.setTemperatureVisible(this.renderer.isTemperatureVisible);
    page.setWeather(this.renderer.weather);
    page.setTimeOfDay(this.renderer.timeOfDay);
    page.setTransformLogAvailable(Boolean(this.joinedRoom && this.player));
    this.commonUI.push(page);
  }

  /**
   * 背包的键盘开合走 CommonUI 全局入口。
   *
   * 背包一开，Gameplay Input 就被 CommonUI 关掉了，`Input.Player.Inventory`
   * 标签再也收不到按键——关背包的那一下只能从这里来。控制路径仍然取自
   * InputMapping，玩家改键之后这里跟着换。
   */
  private refreshInventoryShortcut(): void {
    this.disposeInventoryShortcut?.();
    const { control } = this.inputScheme.getMapping(PlayerInputMappingIds.InventoryKeyboard);
    this.inventory.setControlLabel(this.inputScheme.getControlLabel(control));
    this.disposeInventoryShortcut = this.commonUI.bindGlobalKeyboardControl(
      control,
      () => this.inventory.toggle(),
    );
  }

  private refreshDebugMenuShortcut(): void {
    if (!this.debugMenuPage) return;
    this.disposeDebugMenuShortcut?.();
    const control = this.inputScheme.getMapping(PlayerInputMappingIds.DebugMenuKeyboard).control;
    this.disposeDebugMenuShortcut = this.commonUI.bindGlobalKeyboardControl(
      control,
      () => this.toggleDebugMenu(),
    );
  }

  private exitCurrentRoom(): void {
    if (!this.joinedRoom) return;
    this.playerTransformLog?.stop();
    this.roomClient.leaveRoom();
    this.joinedRoom = undefined;
    this.localPlayerPosition = undefined;
    this.terrainEditorPanel.setAvailable(false);
    this.buildPanel.setPieces([]);
    this.destroyPlayer();
    this.hud.setDisconnected();
    this.commonUI.clear();
    if (this.isActive) {
      this.commonUI.push(this.lobbyPage);
      void this.refreshRooms();
    }
  }

  private handleRoomUpdate(room: RoomSummary): void {
    if (room.id !== this.joinedRoom?.room.id) return;
    this.joinedRoom = { ...this.joinedRoom, room };
    this.hud.setRoom(room);
  }

  private handleSnapshot(snapshot: RoomSnapshot): void {
    if (!this.joinedRoom) return;
    this.renderer.setWeather(snapshot.weather);
    this.renderer.setTimeOfDay(snapshot.timeOfDay, snapshot.dayLength);
    this.debugMenuPage?.setWeather(snapshot.weather);
    this.debugMenuPage?.setTimeOfDay(snapshot.timeOfDay, snapshot.dayLength);
    this.world.syncActors(snapshot.actors, snapshot.players, snapshot.serverTime);
    this.snapshots.push(snapshot);

    // 自己的那条不走插值：直接交给和解，把预测拉回服务器的结论。
    const own = snapshot.players.find((player) => player.id === this.joinedRoom?.player.id);
    this.localPlayerPosition = own ? { x: own.x, z: own.z } : undefined;
    const player = this.player;
    if (!own || !player) {
      this.playerTransformLog?.record('client.snapshot_missing_local_player', {
        snapshotTick: snapshot.tick,
        serverTime: snapshot.serverTime,
        snapshotPlayerIds: snapshot.players.map((entry) => entry.id),
      });
      return;
    }
    // 背包是纯权威状态：本地这份只跟随快照，拾取成功与否由服务端说了算。
    const inventory = player.getComponent(INVENTORY_COMPONENT) as InventoryComponent | undefined;
    if (inventory?.applySnapshot(
      own.inventory ?? [],
      own.inventoryRevision ?? inventory.revision,
      own.hotbar,
    )) {
      this.inventory.sync();
      this.hotbarBar.setSlots(buildInventoryView(inventory).hotbar);
      this.buildPanel.setInventory((itemType) => inventory.quantityOf(itemType));
    }
    // 容器界面跟随服务端的开合：走远、箱子被拆、掉线都由服务端把人移出，客户端
    // 不各自判一遍距离，也就不会出现「服务端已经关了但界面还开着」。
    this.container.sync();
    const pickupDrop = player.getComponent(PICKUP_DROP_COMPONENT) as PickupDropComponent | undefined;
    if (pickupDrop) {
      pickupDrop.heldActorId = own.heldActorId ?? null;
      pickupDrop.revision = own.pickupDropRevision ?? pickupDrop.revision;
    }
    const before = player.captureTransformDebugState();
    const authority = {
      id: own.id,
      x: own.x,
      y: own.y,
      z: own.z,
      yaw: own.yaw,
      speed: own.speed,
      ackTick: own.ackTick ?? own.sequence,
      velocityX: own.velocityX,
      verticalVelocity: own.verticalVelocity,
      velocityZ: own.velocityZ,
      grounded: own.grounded,
    };
    this.playerTransformLog?.record('client.snapshot_received', {
      snapshotTick: snapshot.tick,
      serverTime: snapshot.serverTime,
      receivedAt: Date.now(),
      authority,
      clientBefore: before,
      authorityDeltaBefore: {
        x: before.logic.x - own.x,
        y: own.y === undefined ? undefined : before.logic.y - own.y,
        z: before.logic.z - own.z,
      },
    });
    // 打点在这里，而不是在 `sim-player` 里：和解跑在 WebSocket 的回调上，
    // 落在两帧**之间**，rAF 的 `beginFrame`/`endFrame` 根本罩不住它。之前面板上
    // 那个「`sim-player` 只有 0.06ms」因此是假象——重放那一串固定步一次都没被数过。
    // `frameTimeline` 会把这段自耗时攒到下一次 `endFrame`，也就是被它拖慢的那一帧上。
    // 代价是这个阶段不计入整帧耗时，「整帧 − 各阶段之和」在有和解的帧上会偏小。
    const reconciliation = frameTimeline.measure('net-reconcile', () => (
      player.applyAuthoritativeState(
        own.ackTick ?? own.sequence,
        own.x,
        own.z,
        own.y,
        own.verticalVelocity,
        own.velocityX,
        own.velocityZ,
        own.grounded,
      )
    ));
    // 拉回了几次、拉回多远，面板上「和解」那一行读它。
    recordReconciliation(reconciliation);
    const after = player.captureTransformDebugState();
    this.playerTransformLog?.record('client.reconciliation_completed', {
      snapshotTick: snapshot.tick,
      serverTime: snapshot.serverTime,
      reconciliation,
      clientAfter: after,
      authorityDeltaAfter: {
        x: after.logic.x - own.x,
        y: own.y === undefined ? undefined : after.logic.y - own.y,
        z: after.logic.z - own.z,
      },
    });
  }

  private handleDisconnect(): void {
    if (!this.joinedRoom) return;
    this.joinedRoom = undefined;
    this.localPlayerPosition = undefined;
    this.terrainEditorPanel.setAvailable(false);
    this.buildPanel.setPieces([]);
    this.destroyPlayer();
    this.hud.setDisconnected();
    if (this.isActive && this.commonUI.size === 0) {
      this.commonUI.push(this.lobbyPage);
      void this.refreshRooms();
    }
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : '发生了未知错误';
  }

  private createPlayer(
    playerId: string,
    spawn: { x: number; z: number },
    bounds: JoinedRoom['scene']['gameplay']['bounds'],
    archetype: ActorArchetypeDefinition,
    topDownCameraOffset: JoinedRoom['scene']['camera']['position'],
  ): void {
    if (this.player) return;
    const renderWorld = this.renderer.renderWorld;
    if (!renderWorld) throw new Error('当前场景没有渲染世界，无法建立玩家 proxy');
    this.remotePlayers.setRenderWorld(renderWorld);
    this.player = new PlayerEntity(
      playerId,
      this.canvas,
      spawn,
      this.input,
      bounds,
      this.world,
      archetype,
      renderWorld,
      topDownCameraOffset,
    );
    // 蒙皮拖拽是两侧之间的适配器：指针与相机在这一边，外壳在渲染世界，
    // 玩家实体只经由 setCameraDragSuppressed 收到「一次手势归谁」那一个布尔。
    // 四个拖拽方法现在都在 `RenderScene` 上，所以它收的就是边界接口本身。
    this.slimeSurfaceDrag = new SlimeSurfaceDragController(
      this.canvas,
      this.input,
      renderWorld.scene,
      this.player.renderProxyId,
      () => this.controls.frame,
      (active) => this.player?.controller.setCameraDragSuppressed(active),
    );
    this.healthPopups = new HealthPopupEmitter(renderWorld.scene);
    this.localPlayerDead = false;
    this.hud.setDead(false);
    this.controls.setPlayerController(this.player.controller);
    this.timeSinceInputSent = 0;
  }

  private destroyPlayer(): void {
    // 角色没了，背包里那份镜像也就没有权威来源了；开着的话先收起来，
    // 免得断线后停在一屏读不到更新的旧货位上。
    this.inventory.close();
    this.debugMenuPage?.setTransformLogAvailable(false);
    this.sceneComponents.clear();
    this.snapshots.clear();
    this.vesselControls.reset();
    this.actorInteractions.reset();
    this.builds.reset();
    this.buildPanel.setInventory(undefined);
    this.hotbar.reset();
    this.remotePlayers.setRenderWorld(undefined);
    this.healthPopups?.clear();
    this.healthPopups = undefined;
    this.localPlayerDead = false;
    this.hud.setDead(false);
    this.slimeSurfaceDrag?.dispose();
    this.performanceOverlay?.dispose();
    this.hotbar.dispose();
    this.hotbarBar.dispose();
    this.holdProgress.dispose();
    this.slimeSurfaceDrag = undefined;
    if (this.player) {
      this.controls.setPlayerController(undefined);
      this.player.dispose();
      this.player = undefined;
    }
    this.renderer.resetEnvironment();
    this.composition.clear();
  }

  /**
   * 上行固定在 INPUT_SEND_INTERVAL_SECONDS，和渲染帧率解耦：
   * 高刷屏不会把房间进程刷爆，低帧率也不会漏掉这段时间的位移。
   */
  private sendPlayerInput(deltaSeconds: number): void {
    if (!this.player || !this.joinedRoom) return;
    this.timeSinceInputSent += deltaSeconds;
    if (this.timeSinceInputSent < INPUT_SEND_INTERVAL_SECONDS) return;

    this.timeSinceInputSent = 0;
    const inputs = this.player.unacknowledgedInputSteps;
    const lastInput = inputs.at(-1);
    const sentTick = this.roomClient.sendPlayerInput(inputs);
    this.playerTransformLog?.record('client.input_packet_sent', {
      sent: sentTick !== undefined,
      inputCount: inputs.length,
      firstTick: inputs[0]?.tick,
      lastTick: lastInput?.tick,
      lastInput,
      transform: this.player.captureTransformDebugState(),
    });
  }

  /**
   * 拖拽形变按快照频率上行：服务端只转发不重放，报得比快照还密只会白占输入
   * 令牌桶，把真正需要重放的移动输入挤掉。拖拽期间必须持续续期，服务端才不会
   * 按超时清掉它；松手那一刻不等节流，立刻补发一次 null，其他玩家不用等超时
   * 就能看到史莱姆弹回去。
   */
  private sendSlimeDrag(deltaSeconds: number): void {
    if (!this.slimeSurfaceDrag || !this.joinedRoom) return;
    this.timeSinceSlimeDragSent += deltaSeconds;
    const dragging = this.slimeSurfaceDrag.captureReplicationState(this.slimeDragState);
    if (!dragging && !this.slimeDragReplicated) return;
    if (dragging && this.timeSinceSlimeDragSent < SLIME_DRAG_SEND_INTERVAL_SECONDS) return;
    if (!this.roomClient.sendSlimeDrag(dragging ? this.slimeDragState : null)) return;
    this.timeSinceSlimeDragSent = 0;
    this.slimeDragReplicated = dragging;
  }
}
