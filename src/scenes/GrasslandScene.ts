import { FlyController } from '../camera/FlyController';
import { GameInteractionLayer } from '../interaction/GameInteractionLayer';
import { isDevelopmentRuntime } from '../debug/developmentRuntime';
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
import { InventoryController } from '../controllers/InventoryController';
import { TerrainEditController } from '../controllers/TerrainEditController';
import { VesselControlController } from '../controllers/VesselControlController';
import { RoomClient, type JoinedRoom, type RoomSummary } from '../network/RoomClient';
import { SnapshotBuffer } from '../network/SnapshotBuffer';
import type { RoomSnapshot } from '../network/protocol';
import { frameTimeline } from '../platform/index';
import { PlayerEntity } from '../player/PlayerEntity';
import { SlimeSurfaceDragController } from '../controllers/SlimeSurfaceDragController';
import { RemotePlayerGroup } from '../player/RemotePlayerGroup';
import { SceneRenderer } from '../rendering/SceneRenderer';
import { SceneWorld } from '../scene/SceneWorld';
import type { SceneUpdateContext } from '../scene/SceneVisualSystem';
import { createSceneRuntimeComponent, SceneComponentHost } from '../scene/components';
import { INPUT_SEND_INTERVAL_SECONDS } from '../../shared/networkTuning.mjs';
import {
  INVENTORY_COMPONENT,
  type InventoryComponent,
  PICKUP_DROP_COMPONENT,
  type PickupDropComponent,
} from '../../shared/actor/index.mjs';
import { HudController } from '../ui/HudController';
import { TerrainEditorPanel } from '../ui/TerrainEditorPanel';
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
  private readonly sceneComponents = new SceneComponentHost(createSceneRuntimeComponent);
  private readonly flyController: FlyController;
  private readonly controls: SceneControlRouter;
  private readonly vesselControls: VesselControlController;
  private readonly actorInteractions: ActorInteractionController;
  private readonly terrainEdits: TerrainEditController;
  private readonly terrainEditorPanel = new TerrainEditorPanel();
  private readonly gameInteractions = new GameInteractionLayer();
  private readonly hud = new HudController();
  private readonly roomClient = new RoomClient();
  private readonly lobbyPage = new RoomLobbyPage();
  private readonly gameMenuPage = new GameMenuPage();
  private readonly inventoryPage = new InventoryPage();
  private readonly inventory: InventoryController;
  private readonly debugMenuPage?: DebugMenuPage;
  private readonly playerTransformLog?: PlayerTransformLogRecorder;
  private disposeDebugMenuShortcut?: () => void;
  private disposeInventoryShortcut?: () => void;
  private readonly snapshots = new SnapshotBuffer();
  private readonly remotePlayers: RemotePlayerGroup;
  private joinedRoom?: JoinedRoom;
  private availableScenes: SceneSummary[] = [];
  private player?: PlayerEntity;
  private slimeSurfaceDrag?: SlimeSurfaceDragController;
  private timeSinceInputSent = 0;

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
      this.refreshDebugMenuShortcut();
    }
    this.virtualControls = new VirtualControls({
      root: options.baseLayer,
      device: virtualInput,
      config: this.inputScheme.virtualControls,
    });
    this.hud.setInputPromptResolver((mode, deviceKind, state) => (
      this.inputScheme.getPrompt(mode, deviceKind, state)
    ));
    this.inputScheme.onBindingsChanged(() => {
      this.input.replaceMappingContexts(this.inputScheme.contexts);
      keyboardInput.setPreventDefaultControls(this.inputScheme.getPreventDefaultControls());
      this.refreshDebugMenuShortcut();
      this.refreshInventoryShortcut();
      this.hud.refreshInputPrompt();
    });
    // 场景的两半:渲染核心与玩法查询。第 3 步搬 canvas 时只有前者跟着走。
    this.world = new SceneWorld();
    this.renderer = new SceneRenderer(options.canvas, this.world);
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
      getInputLabel: (tag) => {
        const control = this.input.getMappedControls(tag)[0];
        return control ? this.inputScheme.getControlLabel(control) : undefined;
      },
      setHoveredActorId: (actorId) => this.world.setHoveredActorId(actorId),
      setInteractionMarkerActorId: (actorId, inputLabel) => {
        this.world.setInteractionMarkerActorId(actorId, inputLabel);
      },
      sendInteraction: (actorId) => { this.roomClient.interactWithActor(actorId); },
      setPrompt: (text) => this.hud.setInteractionPrompt(text),
    });
    this.inventory = new InventoryController(this.inventoryPage, this.input, {
      getInventory: () => this.player?.getComponent(INVENTORY_COMPONENT) as
        InventoryComponent | undefined,
      isOpen: () => this.commonUI.top === this.inventoryPage,
      setOpen: (open) => {
        if (open) this.commonUI.push(this.inventoryPage);
        else this.commonUI.pop(this.inventoryPage);
      },
      // 只在没有别的页面盖着时开，背包因此永远是栈顶那一页。
      canOpen: () => Boolean(this.joinedRoom && this.player) && this.commonUI.size === 0,
    });
    this.controls.onModeChange((mode) => this.hud.setControlMode(mode));
    this.input.onActiveDeviceChanged((deviceKind) => this.hud.setInputDevice(deviceKind));

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
    this.input.update();
    this.vesselControls.update(deltaSeconds);
    this.controls.update(deltaSeconds, elapsedSeconds);
    // 玩家（本地与远端）排在 renderer.update 之前：它们把自己这一帧的 transform
    // 与运动参数写进边界那段 SoA，而翻面发生在 renderer.update 里的 Actor 世界中。
    // 写在翻面之后就会晚一帧——软体读到的速度和它被摆到的位置对不上。
    this.slimeSurfaceDrag?.update();
    // 「sim」= 第 2 步要搬进 Sim Worker 的那一半：本地预测与远端插值。
    frameTimeline.measure('sim-player', () => {
      this.player?.update(deltaSeconds);
      if (this.joinedRoom?.scene.camera.mode === 'topdown') {
        this.remotePlayers.sync(this.snapshots.sample(), this.joinedRoom.player.id);
        this.remotePlayers.update(deltaSeconds);
      } else {
        this.remotePlayers.clear();
      }
    });
    // 相机在这里过边界，紧挨着 renderer.update 里的那次 transform 翻面：
    // 两段字节因此是同一个 tick 的，世界不会比机位晚一帧。
    // 写在 render() 里也能跑，但那时渲染循环已经在另一条线程上了，读不到这个对象。
    this.renderer.publishCamera(this.controls.frame);
    this.renderer.update(deltaSeconds, elapsedSeconds, this.currentFocus());
    if (this.terrainEdits.active) {
      // 编辑模式独占 WorldInteract：同一次点击不能既改地形又去交互 Actor。
      this.terrainEdits.update(this.controls.frame);
      this.actorInteractions.reset();
    } else {
      this.terrainEdits.update(this.controls.frame);
      this.actorInteractions.update(this.controls.frame);
    }
    const playerId = this.joinedRoom?.player.id;
    this.hud.setVesselStatus(playerId ? this.world.getVesselHudState(playerId) : undefined);
    this.sceneComponents.update(deltaSeconds, elapsedSeconds);
    this.sendPlayerInput(deltaSeconds);
  }

  public render(): void {
    frameTimeline.measure('draw', () => this.renderer.render());
  }

  /**
   * 世界应该围绕谁展开：有玩家时是玩家，还没有玩家时是相机。
   * 流式加载靠它决定加载哪些 chunk，大厅背后看到的因此也是一片正常的世界。
   */
  private currentFocus(): SceneUpdateContext {
    const player = this.player?.controller.position;
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
    this.sceneComponents.clear();
    this.snapshots.clear();
    this.vesselControls.reset();
    this.actorInteractions.reset();
    this.renderer.loadScene(joined.scene, joined.room.worldSeed);
    this.flyController.configure(joined.scene.camera);
    const playerArchetype = joined.scene.actorArchetypes.find(
      (definition) => definition.id === joined.scene.gameplay.playerActor.archetypeId,
    );
    if (!playerArchetype) {
      throw new Error(`场景缺少玩家 Actor 原型：${joined.scene.gameplay.playerActor.archetypeId}`);
    }
    this.remotePlayers.configure(playerArchetype);
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
    this.terrainEditorPanel.setAvailable(false);
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
    if (inventory?.applySnapshot(own.inventory ?? [], own.inventoryRevision ?? inventory.revision)) {
      this.inventory.sync();
    }
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
    const reconciliation = player.applyAuthoritativeState(
      own.ackTick ?? own.sequence,
      own.x,
      own.z,
      own.y,
      own.verticalVelocity,
      own.velocityX,
      own.velocityZ,
      own.grounded,
    );
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
    this.terrainEditorPanel.setAvailable(false);
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
    // 蒙皮拖拽属于渲染侧：指针、相机和外壳都在这一边，玩家实体只经由
    // setMouseFacingSuppressed 收到「一次手势归谁」那一个布尔。
    this.slimeSurfaceDrag = new SlimeSurfaceDragController(
      this.canvas,
      this.input,
      renderWorld.scene,
      this.player.renderProxyId,
      () => this.controls.frame,
      (active) => this.player?.controller.setMouseFacingSuppressed(active),
    );
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
    this.remotePlayers.setRenderWorld(undefined);
    this.slimeSurfaceDrag?.dispose();
    this.slimeSurfaceDrag = undefined;
    if (this.player) {
      this.controls.setPlayerController(undefined);
      this.player.dispose();
      this.player = undefined;
    }
    this.renderer.showEmptyScene();
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
}
