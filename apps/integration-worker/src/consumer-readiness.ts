export class ConsumerReadiness {
  private readonly observations = new Map<string, { at: number; successful: boolean }>();

  constructor(
    private readonly now = Date.now,
    private readonly maximumAgeMs = 180_000
  ) {}

  track<T>(name: string, task: () => Promise<T>): () => Promise<T> {
    this.observations.set(name, { at: this.now(), successful: false });
    return async () => {
      try {
        const result = await task();
        this.observations.set(name, { at: this.now(), successful: true });
        return result;
      } catch (error) {
        this.observations.set(name, { at: this.now(), successful: false });
        throw error;
      }
    };
  }

  isReady(): boolean {
    return (
      this.observations.size > 0 &&
      [...this.observations.values()].every(
        ({ at, successful }) => successful && this.now() - at < this.maximumAgeMs
      )
    );
  }
}
