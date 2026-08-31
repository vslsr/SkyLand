import {
  defineTag,
  tagMatches,
  type Tag,
  type TagLike,
} from './Tag';

export type TagCollection = TagContainer | TagLike | Iterable<TagLike>;

/**
 * 保存显式标签，并提供精确与层级匹配。
 *
 * 父标签不会被自动写入容器。例如容器保存 `Input.Player.Move` 时，
 * `hasTag('Input.Player')` 为 true，但 `hasExact('Input.Player')` 为 false。
 */
export class TagContainer implements Iterable<Tag> {
  private readonly tags = new Set<Tag>();

  public constructor(initialTags?: TagCollection) {
    if (initialTags !== undefined) this.addAll(initialTags);
  }

  public static from(...tags: readonly TagLike[]): TagContainer {
    return new TagContainer(tags);
  }

  public get size(): number {
    return this.tags.size;
  }

  /** 添加显式标签。重复添加不会改变容器。 */
  public add(tag: TagLike): this {
    this.tags.add(defineTag(tag));
    return this;
  }

  public addAll(tags: TagCollection): this {
    for (const tag of this.iterateCollection(tags)) this.add(tag);
    return this;
  }

  /** 只删除显式保存的同名标签。 */
  public delete(tag: TagLike): boolean {
    return this.tags.delete(defineTag(tag));
  }

  public clear(): void {
    this.tags.clear();
  }

  /** 是否显式保存了完全相同的标签。 */
  public hasExact(tag: TagLike): boolean {
    return this.tags.has(defineTag(tag));
  }

  /**
   * 是否包含能够匹配查询的标签。
   * 容器中的子标签可以匹配其父级查询，父标签不能匹配更具体的子级查询。
   */
  public hasTag(tag: TagLike): boolean {
    for (const ownedTag of this.tags) {
      if (tagMatches(ownedTag, tag)) return true;
    }
    return false;
  }

  public hasAny(tags: TagCollection): boolean {
    for (const tag of this.iterateCollection(tags)) {
      if (this.hasTag(tag)) return true;
    }
    return false;
  }

  public hasAll(tags: TagCollection): boolean {
    for (const tag of this.iterateCollection(tags)) {
      if (!this.hasTag(tag)) return false;
    }
    return true;
  }

  public hasAnyExact(tags: TagCollection): boolean {
    for (const tag of this.iterateCollection(tags)) {
      if (this.hasExact(tag)) return true;
    }
    return false;
  }

  public hasAllExact(tags: TagCollection): boolean {
    for (const tag of this.iterateCollection(tags)) {
      if (!this.hasExact(tag)) return false;
    }
    return true;
  }

  public clone(): TagContainer {
    return new TagContainer(this);
  }

  /** 返回显式标签的插入顺序快照。 */
  public toArray(): readonly Tag[] {
    return [...this.tags];
  }

  public [Symbol.iterator](): IterableIterator<Tag> {
    return this.tags.values();
  }

  private *iterateCollection(collection: TagCollection): IterableIterator<TagLike> {
    if (typeof collection === 'string') {
      yield collection;
      return;
    }
    yield* collection;
  }
}
