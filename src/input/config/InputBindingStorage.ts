import type { StoredInputBindingOverrides } from './InputSchemeTypes';

export interface InputBindingStorage {
  load(schemeId: string): StoredInputBindingOverrides | undefined;
  save(value: StoredInputBindingOverrides): void;
  clear(schemeId: string): void;
}

const STORAGE_PREFIX = 'skyland.input.bindings.';

export class LocalStorageInputBindingStorage implements InputBindingStorage {
  public constructor(private readonly storage: Storage) {}

  public load(schemeId: string): StoredInputBindingOverrides | undefined {
    try {
      const serialized = this.storage.getItem(this.key(schemeId));
      if (!serialized) return undefined;
      const value: unknown = JSON.parse(serialized);
      if (typeof value !== 'object' || value === null) return undefined;
      const candidate = value as Partial<StoredInputBindingOverrides>;
      if (candidate.schemaVersion !== 1 || candidate.schemeId !== schemeId) return undefined;
      if (typeof candidate.bindings !== 'object' || candidate.bindings === null) return undefined;
      return {
        schemaVersion: 1,
        schemeId,
        bindings: Object.fromEntries(Object.entries(candidate.bindings).filter((entry): entry is [string, string] => (
          typeof entry[1] === 'string' && entry[1].trim().length > 0
        ))),
      };
    } catch {
      return undefined;
    }
  }

  public save(value: StoredInputBindingOverrides): void {
    try {
      this.storage.setItem(this.key(value.schemeId), JSON.stringify(value));
    } catch {
      // 隐私模式或容量限制不应让输入重绑定本身失败。
    }
  }

  public clear(schemeId: string): void {
    try {
      this.storage.removeItem(this.key(schemeId));
    } catch {
      // 与 save 一致：持久化不可用时仍保留本次会话内的绑定。
    }
  }

  private key(schemeId: string): string {
    return `${STORAGE_PREFIX}${schemeId}`;
  }
}

export function createBrowserInputBindingStorage(): InputBindingStorage | undefined {
  try {
    return typeof localStorage === 'undefined'
      ? undefined
      : new LocalStorageInputBindingStorage(localStorage);
  } catch {
    return undefined;
  }
}
