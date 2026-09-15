import { adminApi, type AdminSettingsLimits } from '../adminApi';
import { AdminPanel } from '../AdminPanel';
import { createButton, createElement, createField } from '../dom';
import { describeRoomLimit, formatTimestamp } from '../adminFormat';

/** 服务器设置：运行期可改的两项容量参数，外加后台口令。 */
export class SettingsPanel extends AdminPanel {
  private readonly maxRoomsInput = createElement('input', { className: 'admin-input' });
  private readonly emptyRoomTtlInput = createElement('input', { className: 'admin-input' });
  private readonly settingsNote = createElement('p', { className: 'admin-note' });
  private readonly currentPasswordInput = createElement('input', { className: 'admin-input' });
  private readonly newPasswordInput = createElement('input', { className: 'admin-input' });
  private readonly confirmPasswordInput = createElement('input', { className: 'admin-input' });
  private readonly passwordNote = createElement('p', { className: 'admin-note' });
  private readonly passwordStatus = createElement('p', { className: 'admin-panel__status' });
  private limits?: AdminSettingsLimits;

  public constructor() {
    super('settings', '服务器设置', '服务器设置', '改动立刻生效，并写进设置文件，重启后仍在。');
    this.bodyElement.append(this.createCapacitySection(), this.createPasswordSection());
  }

  public async refresh(): Promise<void> {
    await this.run(async () => {
      const { settings, limits, settingsPath, settingsPersisted, currentRooms } = await adminApi.settings();
      this.limits = limits;
      this.maxRoomsInput.min = String(limits.unlimitedRooms);
      this.maxRoomsInput.max = String(limits.maximumRooms);
      this.emptyRoomTtlInput.min = String(limits.minimumEmptyRoomTtlSeconds);
      this.emptyRoomTtlInput.max = String(limits.maximumEmptyRoomTtlSeconds);
      this.maxRoomsInput.value = String(settings.maxRooms);
      this.emptyRoomTtlInput.value = String(settings.emptyRoomTtlSeconds);
      this.newPasswordInput.minLength = limits.passwordMinimumLength;
      this.confirmPasswordInput.minLength = limits.passwordMinimumLength;
      this.settingsNote.textContent = `当前 ${currentRooms} 个房间，上限 ${describeRoomLimit(settings.maxRooms)}`
        + ` · 设置文件 ${settingsPath}${settingsPersisted ? '' : '（写盘失败，改动只在内存里）'}`;
      this.passwordNote.textContent = `口令以 scrypt 哈希保存，服务端不留明文。`
        + `最近修改：${formatTimestamp(settings.passwordUpdatedAt)}。`
        + `改完其它设备上的后台登录会立刻失效。`;
      this.setStatus('');
    }, '读取设置失败');
  }

  private createCapacitySection(): HTMLElement {
    const section = createElement('div', { className: 'admin-section' });
    section.append(createElement('h3', { text: '容量' }));

    this.maxRoomsInput.type = 'number';
    this.maxRoomsInput.step = '1';
    this.emptyRoomTtlInput.type = 'number';
    this.emptyRoomTtlInput.step = '1';

    const form = createElement('div', { className: 'admin-toolbar' });
    form.append(
      createField('最大房间数', this.maxRoomsInput, '0 = 不限制；达到上限后玩家建房会收到「服务器房间已满」。'),
      createField('空房回收（秒）', this.emptyRoomTtlInput, '房间空置这么久后自动关闭，释放房间进程。'),
    );

    const saveButton = createButton('保存', 'primary');
    saveButton.addEventListener('click', () => void this.save(saveButton));
    section.append(form, saveButton, this.settingsNote);
    return section;
  }

  private createPasswordSection(): HTMLElement {
    const section = createElement('div', { className: 'admin-section' });
    section.append(createElement('h3', { text: '后台口令' }));

    for (const input of [this.currentPasswordInput, this.newPasswordInput, this.confirmPasswordInput]) {
      input.type = 'password';
      input.autocomplete = input === this.currentPasswordInput ? 'current-password' : 'new-password';
    }

    const form = createElement('div', { className: 'admin-toolbar' });
    form.append(
      createField('当前口令', this.currentPasswordInput),
      createField('新口令', this.newPasswordInput),
      createField('确认新口令', this.confirmPasswordInput),
    );

    const submitButton = createButton('修改口令', 'danger');
    submitButton.addEventListener('click', () => void this.changePassword(submitButton));
    section.append(form, submitButton, this.passwordNote, this.passwordStatus);
    return section;
  }

  private async save(trigger: HTMLButtonElement): Promise<void> {
    trigger.disabled = true;
    await this.run(async () => {
      const { settings } = await adminApi.saveSettings(
        Number(this.maxRoomsInput.value),
        Number(this.emptyRoomTtlInput.value),
      );
      this.setStatus(`已保存：上限 ${describeRoomLimit(settings.maxRooms)}，空房 ${settings.emptyRoomTtlSeconds} 秒后回收`);
      await this.refresh();
    }, '保存设置失败');
    trigger.disabled = false;
  }

  private async changePassword(trigger: HTMLButtonElement): Promise<void> {
    const minimum = this.limits?.passwordMinimumLength ?? 8;
    this.passwordStatus.classList.remove('is-error');

    if (this.newPasswordInput.value.length < minimum) {
      this.setPasswordStatus(`新口令至少 ${minimum} 位。`, 'error');
      return;
    }
    if (this.newPasswordInput.value !== this.confirmPasswordInput.value) {
      this.setPasswordStatus('两次输入的新口令不一致。', 'error');
      return;
    }

    trigger.disabled = true;
    try {
      const result = await adminApi.changePassword(this.currentPasswordInput.value, this.newPasswordInput.value);
      this.setPasswordStatus(result.persisted ? result.message : `${result.message}（写盘失败，重启后会回到旧口令）`);
      this.currentPasswordInput.value = '';
      this.newPasswordInput.value = '';
      this.confirmPasswordInput.value = '';
      await this.refresh();
    } catch (error) {
      // 改口令会作废所有会话；服务端已给本次请求补发新票，401 在这里才是真的失效，
      // 交给控制台退回登录页，其余错误留在本区块的状态行里。
      this.setPasswordStatus(error instanceof Error ? error.message : String(error), 'error');
      this.reportUnauthorized(error);
    } finally {
      trigger.disabled = false;
    }
  }

  private setPasswordStatus(message: string, tone: 'info' | 'error' = 'info'): void {
    this.passwordStatus.textContent = message;
    this.passwordStatus.classList.toggle('is-error', tone === 'error');
  }
}
