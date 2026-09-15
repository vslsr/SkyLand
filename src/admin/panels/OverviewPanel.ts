import { adminApi, type AdminOverview } from '../adminApi';
import { AdminPanel } from '../AdminPanel';
import { createElement } from '../dom';
import { describeRoomLimit, formatMegabytes, formatUptime } from '../adminFormat';

interface StatDefinition {
  label: string;
  read: (overview: AdminOverview) => string;
  hint?: (overview: AdminOverview) => string;
}

const STATS: StatDefinition[] = [
  { label: '在线玩家', read: (o) => String(o.players), hint: (o) => `席位合计 ${o.capacity}` },
  { label: '连接数', read: (o) => String(o.connections), hint: (o) => `其中 ${Math.max(0, o.connections - o.players)} 条还在大厅` },
  { label: '运行房间', read: (o) => String(o.rooms), hint: (o) => `上限 ${describeRoomLimit(o.maxRooms)}` },
  { label: '空置房间', read: (o) => String(o.idleRooms), hint: () => '无人时按设置自动回收' },
  { label: '可用地图', read: (o) => String(o.scenes) },
  { label: '已运行', read: (o) => formatUptime(o.uptimeSeconds) },
  { label: '常驻内存', read: (o) => formatMegabytes(o.residentMemoryMB), hint: (o) => `堆内 ${formatMegabytes(o.heapUsedMB)}` },
];

/** 总览：一眼看清这台服务器现在扛着多少人、多少房、吃了多少内存。 */
export class OverviewPanel extends AdminPanel {
  private readonly grid = createElement('div', { className: 'admin-stats' });
  private readonly footnote = createElement('p', { className: 'admin-note' });

  public constructor() {
    super('overview', '总览', '总览', '网关进程的实时状态，每 5 秒自动刷新。');
    this.bodyElement.append(this.grid, this.footnote);
  }

  public async refresh(): Promise<void> {
    await this.run(async () => {
      const { overview } = await adminApi.overview();
      this.grid.replaceChildren(...STATS.map((stat) => this.createTile(stat, overview)));
      this.footnote.textContent = `Node ${overview.nodeVersion} · 设置文件 ${overview.settingsPath}`
        + `${overview.settingsPersisted ? '' : '（当前写盘失败，设置仅在内存中生效）'}`;
      this.setStatus(`更新于 ${new Date().toLocaleTimeString()}`);
    }, '读取总览失败');
  }

  private createTile(stat: StatDefinition, overview: AdminOverview): HTMLElement {
    const tile = createElement('div', { className: 'admin-stat' });
    tile.append(
      createElement('span', { className: 'admin-stat__label', text: stat.label }),
      createElement('strong', { className: 'admin-stat__value', text: stat.read(overview) }),
    );
    const hint = stat.hint?.(overview);
    if (hint) tile.append(createElement('span', { className: 'admin-stat__hint', text: hint }));
    return tile;
  }
}
