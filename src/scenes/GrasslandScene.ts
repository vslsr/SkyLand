import { FlyController } from '../camera/FlyController';
import { GameInteractionLayer } from '../interaction/GameInteractionLayer';
import { isDevelopmentRuntime } from '../debug/developmentRuntime';
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
import { VesselControlController } from '../controllers/VesselControlController';
import { RoomClient, type JoinedRoom, type RoomSummary } from '../network/RoomClient';
import { SnapshotBuffer } from '../network/SnapshotBuffer';
import type { RoomSnapshot } from '../network/protocol';
import { PlayerEntity } from '../player/PlayerEntity';
import { RemotePlayerGroup } from '../player/RemotePlayerGroup';
import { SceneRenderer } from '../rendering/SceneRenderer';
import { createSceneRuntimeComponent, SceneComponentHost } from '../scene/components';
import { INPUT_SEND_INTERVAL_SECONDS } from '../../shared/networkTuning.mjs';
import { HudController } from '../ui/HudController';
import { CreateRoomPage, type CreateRoomFormValue } from '../ui/pages/CreateRoomPage';
import { DebugMenuPage } from '../ui/pages/DebugMenuPage';
import { GameMenuPage } from '../ui/pages/GameMenuPage';
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
  private readonly sceneComponents = new SceneComponentHost(createSceneRuntimeComponent);
  private readonly flyController: FlyController;
  private readonly controls: SceneControlRouter;
  private readonly vesselControls: VesselControlController;
  private readonly actorInteractions: ActorInteractionController;
  private readonly gameInteractions = new GameInteractionLayer();
  private readonly hud = new HudController();
  private readonly roomClient = new RoomClient();
  private readonly lobbyPage = new RoomLobbyPage();
  private readonly gameMenuPage = new GameMenuPage();
  private readonly debugMenuPage?: DebugMenuPage;
  private disposeDebugMenuShortcut?: () => void;
  private readonly snapshots = new SnapshotBuffer();
  private readonly remotePlayers: RemotePlayerGroup;
  private joinedRoom?: JoinedRoom;
  private availableScenes: SceneSummary[] = [];
  private player?: PlayerEntity;
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
      this.debugMenuPage.onRequestClose(() => this.commonUI.pop(this.debugMenuPage));
      this.debugMenuPage.onCollisionToggle((visible) => {
        this.renderer.setSimpleCollisionVisible(visible);
      });
      this.debugMenuPage.onTemperatureToggle((visible) => {
        this.renderer.setTemperatureVisible(visible);
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
      this.hud.refreshInputPrompt();
    });
    this.renderer = new SceneRenderer(options.canvas);
    this.remotePlayers = new RemotePlayerGroup(this.renderer);
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
      findOwnedActorId: (playerId) => this.renderer.findOwnedActorId(playerId),
      findControllableActorId: () => this.renderer.findControllableActorId(),
      requestControl: (actorId) => this.roomClient.requestActorControl(actorId),
      releaseControl: (actorId) => this.roomClient.releaseActorControl(actorId),
      sendInput: (actorId, input) => { this.roomClient.sendVesselInput(actorId, input); },
    });
    this.actorInteractions = new ActorInteractionController(this.input, {
      getPlayerId: () => this.joinedRoom?.player.id,
      getPlayerPosition: () => this.player?.controller.position,
      findOwnedActorId: (playerId) => this.renderer.findOwnedActorId(playerId),
      pick: (frame) => this.renderer.pickActorInteraction(frame),
      findNearby: (position) => this.renderer.findNearbyActorInteraction(position),
      getInputLabel: (tag) => {
        const control = this.input.getMappedControls(tag)[0];
        return control ? this.inputScheme.getControlLabel(control) : undefined;
      },
      setHoveredActorId: (actorId) => this.renderer.setHoveredActorId(actorId),
      setInteractionMarkerActorId: (actorId, inputLabel) => {
        this.renderer.setInteractionMarkerActorId(actorId, inputLabel);
      },
      sendInteraction: (actorId) => { this.roomClient.interactWithActor(actorId); },
      setPrompt: (text) => this.hud.setInteractionPrompt(text),
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
    this.roomClient.onRoomUpdate((room) => this.handleRoomUpdate(room));
    this.roomClient.onSnapshot((snapshot) => this.handleSnapshot(snapshot));
    this.roomClient.onDisconnect(() => this.handleDisconnect());
    this.renderer.addWorldObject(this.remotePlayers.root);
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.input.update();
    this.vesselControls.update(deltaSeconds);
    this.controls.update(deltaSeconds, elapsedSeconds);
    this.renderer.update(deltaSeconds, elapsedSeconds, this.currentFocus());
    this.actorInteractions.update(this.controls.frame);
    const playerId = this.joinedRoom?.player.id;
    this.hud.setVesselStatus(playerId ? this.renderer.getVesselHudState(playerId) : undefined);
    this.player?.update(deltaSeconds, elapsedSeconds);
    this.sceneComponents.update(deltaSeconds, elapsedSeconds);
    this.sendPlayerInput(deltaSeconds);
    if (this.joinedRoom?.scene.camera.mode === 'topdown') {
      this.remotePlayers.sync(this.snapshots.sample(), this.joinedRoom.player.id);
      this.remotePlayers.update(deltaSeconds, elapsedSeconds);
    } else {
      this.remotePlayers.clear();
    }
  }

  public render(): void {
    this.renderer.render(this.controls.frame);
  }

  /**
   * 世界应该围绕谁展开：有玩家时是玩家，还没有玩家时是相机。
   * 流式加载靠它决定加载哪些 chunk，大厅背后看到的因此也是一片正常的世界。
   */
  private currentFocus(): { focusX: number; focusZ: number } {
    const player = this.player?.controller.position;
    if (player) return { focusX: player.x, focusZ: player.z };
    const [cameraX, , cameraZ] = this.controls.frame.position;
    return { focusX: cameraX, focusZ: cameraZ };
  }

  protected onEnter(): void {
    this.sceneComponents.setActive(true);
    if (this.joinedRoom) {
      return;
    }
    this.hud.setDisconnected();
    this.commonUI.push(this.lobbyPage);
    void this.refreshRooms();
  }

  protected onLeave(): void {
    this.sceneComponents.setActive(false);
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
      player: this.player,
    });
    this.hud.setRoom(joined.room);
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
    this.commonUI.push(page);
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
    this.roomClient.leaveRoom();
    this.joinedRoom = undefined;
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
    this.renderer.syncActors(snapshot.actors, snapshot.serverTime);
    this.snapshots.push(snapshot);

    // 自己的那条不走插值：直接交给和解，把预测拉回服务器的结论。
    const own = snapshot.players.find((player) => player.id === this.joinedRoom?.player.id);
    if (own) this.player?.applyAuthoritativeState(own.sequence, own.x, own.z);
  }

  private handleDisconnect(): void {
    if (!this.joinedRoom) return;
    this.joinedRoom = undefined;
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
  ): void {
    if (this.player) return;
    this.player = new PlayerEntity(
      playerId,
      this.canvas,
      spawn,
      this.input,
      bounds,
      this.renderer,
      archetype,
    );
    this.renderer.addWorldObject(this.player.object3D);
    this.controls.setPlayerController(this.player.controller);
    this.timeSinceInputSent = 0;
  }

  private destroyPlayer(): void {
    this.sceneComponents.clear();
    this.snapshots.clear();
    this.vesselControls.reset();
    this.actorInteractions.reset();
    this.remotePlayers.clear();
    if (this.player) {
      this.controls.setPlayerController(undefined);
      this.renderer.removeWorldObject(this.player.object3D);
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

    const elapsed = this.timeSinceInputSent;
    this.timeSinceInputSent = 0;
    const sequence = this.roomClient.sendPlayerInput(this.player.controller.inputFrame, elapsed);
    if (sequence !== undefined) this.player.recordPrediction(sequence);
  }
}
