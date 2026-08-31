import { ModalWindow } from '../common/ModalWindow';

export class GameMenuPage extends ModalWindow {
  private exitHandler?: () => void;

  public constructor() {
    super({
      id: 'game-menu',
      kicker: 'SESSION',
      title: '游戏菜单',
      description: '退出后将断开当前房间连接，并返回大厅。',
      size: 'compact',
    });

    const exitButton = document.createElement('button');
    exitButton.className = 'paper-button paper-button--danger';
    exitButton.type = 'button';
    exitButton.textContent = '退出房间';
    exitButton.addEventListener('click', () => this.exitHandler?.());
    this.footerElement.append(exitButton);
  }

  public onExit(handler: () => void): void {
    this.exitHandler = handler;
  }
}
