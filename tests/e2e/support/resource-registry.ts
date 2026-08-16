export type ResourceDisposer<T> = (value: T) => void | Promise<void>;

export interface ResourceRegistration<T> {
  readonly value: T;
  readonly disposed: boolean;
  dispose(): Promise<void>;
  release(): void;
}

type EntryState = 'pending' | 'disposing' | 'disposed' | 'released';

interface RegistryEntry<T> {
  readonly label: string;
  readonly value: T;
  readonly disposer: ResourceDisposer<T>;
  state: EntryState;
  disposal?: Promise<void>;
}

function labeledDisposalError(label: string, cause: unknown): Error {
  return new Error(`Resource "${label}" failed to dispose`, { cause });
}

export class ResourceRegistry {
  readonly #entries: RegistryEntry<unknown>[] = [];
  #disposal: Promise<void> | undefined;

  defer(label: string, disposer: () => void | Promise<void>): ResourceRegistration<void> {
    return this.own(label, undefined, disposer);
  }

  own<T>(label: string, value: T, disposer: ResourceDisposer<T>): ResourceRegistration<T> {
    if (this.#disposal) {
      throw new Error(`Cannot register resource "${label}" after disposal has started`);
    }
    if (label.trim() === '') throw new TypeError('Resource label must not be empty');

    const entry: RegistryEntry<T> = { label, value, disposer, state: 'pending' };
    this.#entries.push(entry as RegistryEntry<unknown>);

    const dispose = (): Promise<void> => {
      if (entry.disposal) return entry.disposal;
      if (entry.state !== 'pending') return Promise.resolve();

      entry.state = 'disposing';
      entry.disposal = Promise.resolve()
        .then(() => entry.disposer(entry.value))
        .finally(() => {
          entry.state = 'disposed';
        });
      return entry.disposal;
    };

    return {
      value,
      get disposed() {
        return entry.state !== 'pending';
      },
      dispose,
      release() {
        if (entry.state === 'pending') entry.state = 'released';
      },
    };
  }

  disposeAll(): Promise<void> {
    this.#disposal ??= this.#disposeEntries();
    return this.#disposal;
  }

  async #disposeEntries(): Promise<void> {
    const failures: Error[] = [];

    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      const entry = this.#entries[index];
      if (!entry || entry.state === 'released' || entry.state === 'disposed') continue;

      if (!entry.disposal) {
        entry.state = 'disposing';
        entry.disposal = Promise.resolve()
          .then(() => entry.disposer(entry.value))
          .finally(() => {
            entry.state = 'disposed';
          });
      }
      try {
        await entry.disposal;
      } catch (error) {
        failures.push(labeledDisposalError(entry.label, error));
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to dispose ${failures.length} scenario resource(s)`);
    }
  }
}
