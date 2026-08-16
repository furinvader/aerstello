export type ScenarioStateKey<T> = symbol & { readonly __scenarioState?: T };

export class ScenarioStateStore {
  readonly #values = new Map<symbol, unknown>();

  get<T>(key: ScenarioStateKey<T>, factory: () => T): T {
    if (!this.#values.has(key)) this.#values.set(key, factory());
    return this.#values.get(key) as T;
  }
}

export function createScenarioState<T>(
  label: string,
  factory: () => T,
): (store: ScenarioStateStore) => T {
  const key = Symbol(label) as ScenarioStateKey<T>;
  return (store) => store.get(key, factory);
}
