declare const tagBrand: unique symbol;

/** 经过格式校验的点分层级标签，例如 `Input.Player.Move`。 */
export type Tag = string & { readonly [tagBrand]: true };

export type TagLike = Tag | string;

const TAG_PATTERN = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

/**
 * 校验并创建标签。标签区分大小写，且不会静默修剪或改写配置值。
 */
export function defineTag(value: string): Tag {
  if (!TAG_PATTERN.test(value)) {
    throw new TypeError(
      `无效标签「${value}」：必须使用由字母、数字或下划线组成的点分层级，例如 Input.Player.Move`,
    );
  }
  return value as Tag;
}

/** 判断一个未知值能否作为合法标签使用。 */
export function isValidTag(value: unknown): value is Tag {
  return typeof value === 'string' && TAG_PATTERN.test(value);
}

/** 标签是否完全相同。 */
export function tagsEqual(left: TagLike, right: TagLike): boolean {
  return defineTag(left) === defineTag(right);
}

/**
 * 判断 `tag` 是否匹配 `query`。
 * 精确相同或 `tag` 是 `query` 的后代时返回 true。
 */
export function tagMatches(tag: TagLike, query: TagLike): boolean {
  const candidate = defineTag(tag);
  const expected = defineTag(query);
  return candidate === expected || candidate.startsWith(`${expected}.`);
}

/** 判断 `tag` 是否是 `possibleParent` 的严格后代。 */
export function isTagDescendantOf(tag: TagLike, possibleParent: TagLike): boolean {
  const candidate = defineTag(tag);
  const parent = defineTag(possibleParent);
  return candidate !== parent && candidate.startsWith(`${parent}.`);
}

/** 判断 `tag` 是否是 `possibleChild` 的严格祖先。 */
export function isTagParentOf(tag: TagLike, possibleChild: TagLike): boolean {
  return isTagDescendantOf(possibleChild, tag);
}

/** 返回从直接父级到根级的全部父标签。 */
export function getParentTags(tag: TagLike): readonly Tag[] {
  const segments = defineTag(tag).split('.');
  const parents: Tag[] = [];
  for (let end = segments.length - 1; end > 0; end -= 1) {
    parents.push(defineTag(segments.slice(0, end).join('.')));
  }
  return parents;
}
