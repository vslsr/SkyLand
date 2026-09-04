export { AbilitySystem } from './AbilitySystem';
export {
  AttributeSet,
  JavascriptAttributeBackend,
} from './AttributeSet';
/**
 * 标签匹配也编进服务端运行时。
 *
 * 服务端要按目标标签改判伤害倍率（`@w` 的 `D.Attack.Tag`），而「`A.B` 匹配
 * `A.B.C`」这条规则已经在 `src/tags/` 里了。让 Node 那一侧另写一份 `startsWith`
 * 判断，两份实现迟早会在边界情形上分叉——那正是这条内核被编译共享的理由。
 */
export { defineTag, isValidTag, tagMatches } from '../tags/index';
