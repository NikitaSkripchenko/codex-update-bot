type StoredValue = {
  value: string;
  expiresAt: number | null;
};

export class MemoryKV {
  private readonly values = new Map<string, StoredValue>();

  async get(key: string): Promise<string | null> {
    const entry = this.values.get(key);

    if (!entry) {
      return null;
    }

    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }

    return entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.values.set(key, {
      value,
      expiresAt: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export const createMemoryKv = (): KVNamespace => new MemoryKV() as unknown as KVNamespace;
