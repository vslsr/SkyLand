import { ModalWindow } from '../common/ModalWindow';
import type { SceneSummary } from '../../scenes/data/SceneDefinition';

export interface CreateRoomFormValue {
  roomName: string;
  temporaryName: string;
  sceneId: string;
}

export class CreateRoomPage extends ModalWindow {
  private readonly roomNameInput = document.createElement('input');
  private readonly temporaryNameInput = document.createElement('input');
  private readonly sceneSelect = document.createElement('select');
  private readonly submitButton = document.createElement('button');
  private readonly errorElement = document.createElement('p');
  private submitHandler?: (value: CreateRoomFormValue) => void;

  public constructor(temporaryName: string, scenes: readonly SceneSummary[]) {
    super({
      id: 'create-room',
      kicker: 'NEW ROOM PROCESS',
      title: '创建房间',
      description: '创建后，服务器会启动一个独立 Node.js 进程管理这个房间。',
    });

    const form = document.createElement('form');
    form.className = 'room-form';

    this.roomNameInput.type = 'text';
    this.roomNameInput.maxLength = 28;
    this.roomNameInput.placeholder = '例如：风车旁的草地';
    this.roomNameInput.autocomplete = 'off';

    this.temporaryNameInput.type = 'text';
    this.temporaryNameInput.maxLength = 20;
    this.temporaryNameInput.value = temporaryName;
    this.temporaryNameInput.autocomplete = 'off';

    for (const scene of scenes) {
      const option = document.createElement('option');
      option.value = scene.id;
      option.textContent = `${scene.displayName} · ${scene.description}`;
      this.sceneSelect.append(option);
    }

    form.append(
      this.createField('房间名称', this.roomNameInput),
      this.createField('地图', this.sceneSelect),
      this.createField('你的临时名称', this.temporaryNameInput),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const roomName = this.roomNameInput.value.trim();
      const playerName = this.temporaryNameInput.value.trim();
      if (!roomName) {
        this.setError('请输入房间名称。');
        this.roomNameInput.focus();
        return;
      }
      if (!this.sceneSelect.value) {
        this.setError('请选择地图。');
        this.sceneSelect.focus();
        return;
      }
      this.submitHandler?.({ roomName, temporaryName: playerName, sceneId: this.sceneSelect.value });
    });
    this.bodyElement.append(form, this.errorElement);

    this.submitButton.className = 'paper-button paper-button--primary';
    this.submitButton.type = 'submit';
    this.submitButton.textContent = '创建并加入 →';
    this.submitButton.addEventListener('click', () => form.requestSubmit());
    this.footerElement.append(this.submitButton);
  }

  public onSubmit(handler: (value: CreateRoomFormValue) => void): void {
    this.submitHandler = handler;
  }

  public onOpen(): void {
    window.setTimeout(() => this.roomNameInput.focus(), 0);
  }

  public setBusy(busy: boolean): void {
    this.roomNameInput.disabled = busy;
    this.temporaryNameInput.disabled = busy;
    this.sceneSelect.disabled = busy;
    this.submitButton.disabled = busy;
    this.submitButton.textContent = busy ? '正在启动房间进程…' : '创建并加入 →';
  }

  public setError(message: string): void {
    this.errorElement.className = 'form-message is-error';
    this.errorElement.textContent = message;
  }

  private createField(label: string, input: HTMLInputElement | HTMLSelectElement): HTMLLabelElement {
    const field = document.createElement('label');
    field.className = 'field-control';
    const caption = document.createElement('span');
    caption.textContent = label;
    field.append(caption, input);
    return field;
  }
}
