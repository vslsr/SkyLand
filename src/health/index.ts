/**
 * 生命值子系统的对外入口。
 *
 * 两件事住在这里：把权威血量翻译给界面的那条链（契约 + 控制器），以及头顶那条
 * 伤害飘字。两者共用同一条判据——「计数变了才是刚刚结算过一次」——但互不依赖：
 * 飘字画在世界里，血条画在屏幕上。
 */
export type {
  HealthChange,
  HealthDisplayState,
  HealthReading,
  HealthSource,
  HealthView,
} from './HealthDisplay';
export { HealthDisplayController, type HealthDisplayOptions } from './HealthDisplayController';
export {
  HealthPopupEmitter,
  healthPopupAnchorY,
  type HealthPopupSink,
} from './HealthPopupEmitter';
