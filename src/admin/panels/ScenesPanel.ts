import { adminApi, type AdminScene } from '../adminApi';
import { AdminPanel } from '../AdminPanel';
import { createButton, createElement } from '../dom';

/**
 * 地图目录：`config/scenes/` 里被服务端认可的地图，以及每张图当下的承载情况。
 * 只读——地图是配置文件的真相，后台改不了，免得线上与仓库两套数据打架。
 */
export class ScenesPanel extends AdminPanel {
  private readonly list = createElement('div', { className: 'admin-card-grid' });

  public constructor() {
    super('scenes', '地图目录', '地图目录', '来自 config/scenes/ 的地图配置，只读。');
    const refreshButton = createButton('刷新');
    refreshButton.addEventListener('click', () => void this.refresh());
    this.actionsElement.append(refreshButton);
    this.bodyElement.append(this.list);
  }

  public async refresh(): Promise<void> {
    await this.run(async () => {
      const { scenes } = await adminApi.scenes();
      this.list.replaceChildren(...scenes.map((scene) => this.createCard(scene)));
      this.setStatus(`共 ${scenes.length} 张地图`);
    }, '读取地图失败');
  }

  private createCard(scene: AdminScene): HTMLElement {
    const card = createElement('article', { className: 'admin-card' });
    const head = createElement('div', { className: 'admin-card__head' });
    head.append(
      createElement('h3', { text: scene.displayName }),
      createElement('span', { className: 'admin-card__badge', text: `席位 ${scene.capacity}` }),
    );
    card.append(
      head,
      createElement('p', { className: 'admin-card__players', text: scene.description }),
      createElement('p', {
        className: 'admin-note',
        text: `标识 ${scene.id} · 正在使用 ${scene.roomCount} 个房间 · 房内玩家 ${scene.playerCount}`,
      }),
    );
    return card;
  }
}
