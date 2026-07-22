export type ClockInstant = Date | number | string;

function timestampOf(instant: ClockInstant): number {
  const timestamp = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError("FakeClock requires a valid instant");
  return timestamp;
}

export class FakeClock {
  private timestamp: number;

  constructor(initial: ClockInstant) {
    this.timestamp = timestampOf(initial);
  }

  now(): Date {
    return new Date(this.timestamp);
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  advance(milliseconds: number): Date {
    if (!Number.isFinite(milliseconds)) {
      throw new TypeError("FakeClock advance must be finite");
    }
    if (milliseconds < 0) {
      throw new RangeError("FakeClock advance must be non-negative");
    }
    const nextTimestamp = this.timestamp + milliseconds;
    if (!Number.isFinite(new Date(nextTimestamp).getTime())) {
      throw new RangeError("FakeClock advance exceeds the valid Date range");
    }
    this.timestamp = nextTimestamp;
    return this.now();
  }

  set(instant: ClockInstant): Date {
    const nextTimestamp = timestampOf(instant);
    if (nextTimestamp < this.timestamp) {
      throw new RangeError("FakeClock cannot move backward");
    }
    this.timestamp = nextTimestamp;
    return this.now();
  }
}
