/**
 * Small mutable holders for values React must not render: secrets on their way into one request (Vault: taken
 * once, then gone) and the latest value of something for callbacks that outlive a render (Latest). Created once
 * per component (useState initializer) and used only in event handlers and machine actors.
 */
export class Vault<T> {
  private value: T | null = null;

  put(value: T): void {
    this.value = value;
  }

  /** The value without removing it (kept for a follow-up step, e.g. a switch after another person's tap). */
  peek(): T | null {
    return this.value;
  }

  /** The value, removed. */
  take(): T | null {
    const v = this.value;
    this.value = null;
    return v;
  }

  clear(): void {
    this.value = null;
  }
}

export class Latest<T> {
  private value: T;

  constructor(value: T) {
    this.value = value;
  }

  set(value: T): void {
    this.value = value;
  }

  get(): T {
    return this.value;
  }
}
