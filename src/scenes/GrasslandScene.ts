import { FlyController } from '../camera/FlyController';
import { GameInteractionLayer } from '../interaction/GameInteractionLayer';
import { SceneControlRouter } from '../controllers/SceneControlRouter';
import { RoomClient, type JoinedRoom, type RoomSummary } from '../network/RoomClient';
import { SnapshotBuffer } from '../network/SnapshotBuffer';
import type { RoomSnapshot } from '../network/protocol';
import { PlayerEntity } from '../player/PlayerEntity';
import { RemotePlayerGroup } from '../player/RemotePlayerGroup';
import { SceneRenderer } from '../rendering/SceneRenderer';
import { INPUT_SEND_INTERVAL_SECONDS } from '../../shared/networkTuning.mjs';
import { HudController } from '../ui/HudController';
import { CreateRoomPage, type CreateRoomFormValue } from '../ui/pages/CreateRoomPage';
import { RoomLobbyPage } from '../ui/pages/RoomLobbyPage';
import { Scene, type SceneUIContext } from './Scene';

export interface GrasslandSceneOptions extends SceneUIContext {
  canvas: HTMLCanvasElement;
}

export class GrasslandScene extends Scene {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: SceneRenderer;
  private readonly flyController: FlyController;
  private readonly controls: SceneControlRouter;
  private readonly gameInteractions = new GameInteractionLayer();
  private readonly hud = new HudController();
  private readonly roomClient = new RoomClient();
  private readonly lobbyPage = new RoomLobbyPage();
  private readonly snapshots = new SnapshotBuffer();
  private readonly remotePlayers = new RemotePlayerGroup();
  private joinedRoom?: JoinedRoom;
  private player?: PlayerEntity;
  private timeSinceInputSent = 0;

  public constructor(options: GrasslandSceneOptions) {
    super('grassland', options);
    this.canvas = options.canvas;
    this.renderer = new SceneRenderer(options.canvas);
    this.flyController = new FlyController(options.canvas, {
      position: [0, 4.2, 13.5],
      yaw: 0,
      pitch: -0.12,
      enabled: false,
      onLockChange: (locked) => this.hud.setLocked(locked),
    });
    this.controls = new SceneControlRouter(this.flyController);
    this.controls.onModeChange((mode) => this.hud.setControlMode(mode));

    this.commonUI.onStackChange(() => {
      this.controls.setInputEnabled(this.commonUI.allowsGameInteraction);
    });
    this.commonUI.setBaseEventHandler((event) => this.gameInteractions.dispatch(event));
    this.lobbyPage.onRefresh(() => void this.refreshRooms());
    this.lobbyPage.onCreate((temporaryName) => this.openCreateRoom(temporaryName));
    this.lobbyPage.onJoin((room, temporaryName) => void this.joinRoom(room, temporaryName));
    this.roomClient.onRoomUpdate((room) => this.handleRoomUpdate(room));
    this.roomClient.onSnapshot((snapshot) => this.handleSnapshot(snapshot));
    this.roomClient.onDisconnect(() => this.handleDisconnect());
    this.renderer.addWorldObject(this.remotePlayers.root);
  }

  public update(deltaSeconds: number, elapsedSeconds: number): void {
    this.controls.update(deltaSeconds, elapsedSeconds);
    this.player?.update(deltaSeconds, elapsedSeconds);
    this.sendPlayerInput(deltaSeconds);
    this.remotePlayers.sync(this.snapshots.sample(), this.joinedRoom?.player.id);
    this.remotePlayers.update(deltaSeconds, elapsedSeconds);
  }

  public render(): void {
    this.renderer.render(this.controls.frame);
  }

  protected onEnter(): void {
    if (this.joinedRoom) return;
    this.hud.setDisconnected();
    this.commonUI.push(this.lobbyPage);
    void this.refreshRooms();
  }

  protected onLeave(): void {
    this.controls.setInputEnabled(false);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private async refreshRooms(): Promise<void> {
    this.lobbyPage.setLoading(true);
    try {
      this.lobbyPage.setRooms(await this.roomClient.listRooms());
    } catch (error) {
      this.lobbyPage.setError(this.getErrorMessage(error));
    }
  }

  private openCreateRoom(temporaryName: string): void {
    const page = new CreateRoomPage(temporaryName);
    page.onRequestClose(() => this.commonUI.pop(page));
    page.onSubmit((value) => void this.createAndJoinRoom(page, value));
    this.commonUI.push(page);
  }

  private async createAndJoinRoom(page: CreateRoomPage, value: CreateRoomFormValue): Promise<void> {
    page.setBusy(true);
    try {
      const room = await this.roomClient.createRoom(value.roomName);
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
    this.snapshots.clear();
    this.createPlayer(joined.player.spawn);
    this.hud.setRoom(joined.room);
    this.commonUI.clear();
  }

  private handleRoomUpdate(room: RoomSummary): void {
    if (room.id !== this.joinedRoom?.room.id) return;
    this.joinedRoom = { ...this.joinedRoom, room };
    this.hud.setRoom(room);
  }

  private handleSnapshot(snapshot: RoomSnapshot): void {
    if (!this.joinedRoom) return;
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

  private createPlayer(spawn: { x: number; z: number }): void {
    if (this.player) return;
    this.player = new PlayerEntity(this.canvas, spawn);
    this.renderer.addWorldObject(this.player.object3D);
    this.controls.setPlayerController(this.player.controller);
    this.timeSinceInputSent = 0;
  }

  private destroyPlayer(): void {
    this.snapshots.clear();
    this.remotePlayers.clear();
    if (!this.player) return;
    this.controls.setPlayerController(undefined);
    this.renderer.removeWorldObject(this.player.object3D);
    this.player.dispose();
    this.player = undefined;
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
