import { defineTag, tagMatches, type Tag, type TagLike } from '../../tags/index';
import type { EvaluatedActionEvent } from './InputActionRuntime';
import type {
  InputActionEvent,
  InputActionHandler,
  InputBindingOptions,
  InputConfigDefinition,
  InputPhase,
} from './types';

interface TagBinding {
  readonly tag: Tag;
  readonly handler: InputActionHandler;
  readonly phases?: ReadonlySet<InputPhase>;
  readonly includeDescendants: boolean;
}

/** 负责编译 InputConfig，并将 Action 事件按标签广播给业务层。 */
export class InputTagRouter {
  private readonly actionTags = new Map<string, Tag>();
  private readonly tagActions = new Map<Tag, string>();
  private readonly bindings = new Set<TagBinding>();

  public constructor(config: InputConfigDefinition, validActionIds: ReadonlySet<string>) {
    for (const binding of config.bindings) {
      const tag = defineTag(binding.tag);
      if (!validActionIds.has(binding.actionId)) {
        throw new Error(`标签 ${tag} 引用了不存在的 InputAction：${binding.actionId}`);
      }
      if (this.tagActions.has(tag)) throw new Error(`InputConfig 中存在重复标签：${tag}`);
      if (this.actionTags.has(binding.actionId)) {
        throw new Error(`InputAction ${binding.actionId} 只能配置一个主标签`);
      }
      this.tagActions.set(tag, binding.actionId);
      this.actionTags.set(binding.actionId, tag);
    }
  }

  public bind(
    tag: TagLike,
    handler: InputActionHandler,
    options: InputBindingOptions = {},
  ): () => void {
    const binding: TagBinding = {
      tag: defineTag(tag),
      handler,
      phases: options.phases ? new Set(options.phases) : undefined,
      includeDescendants: options.includeDescendants ?? false,
    };
    this.bindings.add(binding);
    return () => this.bindings.delete(binding);
  }

  public getActionId(tagLike: TagLike): string {
    const tag = defineTag(tagLike);
    const actionId = this.tagActions.get(tag);
    if (!actionId) throw new Error(`InputConfig 中没有配置标签：${tag}`);
    return actionId;
  }

  public dispatch(actionId: string, evaluated: EvaluatedActionEvent): void {
    const tag = this.actionTags.get(actionId);
    if (!tag) return;
    const event: InputActionEvent = { tag, actionId, ...evaluated };

    for (const binding of [...this.bindings]) {
      const matches = binding.tag === tag
        || (binding.includeDescendants && tagMatches(tag, binding.tag));
      if (!matches || (binding.phases && !binding.phases.has(event.phase))) continue;
      binding.handler(event);
    }
  }

  public clear(): void {
    this.bindings.clear();
  }
}
