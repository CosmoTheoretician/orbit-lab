/**
 * Time scales. Internally an Epoch stores TT seconds since J2000.0
 * (2000-01-01 12:00:00 TT). Double precision gives sub-microsecond
 * resolution over this century.
 */

const TT_MINUS_TAI = 32.184;
/** Calendar reading 2000-01-01T12:00:00, interpreted on the TT clock. */
const J2000_CALENDAR_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

/** [UTC calendar ms at which the offset takes effect, TAI-UTC in seconds] */
const LEAP_SECONDS: ReadonlyArray<readonly [number, number]> = [
  [Date.UTC(1972, 0, 1), 10], [Date.UTC(1972, 6, 1), 11], [Date.UTC(1973, 0, 1), 12],
  [Date.UTC(1974, 0, 1), 13], [Date.UTC(1975, 0, 1), 14], [Date.UTC(1976, 0, 1), 15],
  [Date.UTC(1977, 0, 1), 16], [Date.UTC(1978, 0, 1), 17], [Date.UTC(1979, 0, 1), 18],
  [Date.UTC(1980, 0, 1), 19], [Date.UTC(1981, 6, 1), 20], [Date.UTC(1982, 6, 1), 21],
  [Date.UTC(1983, 6, 1), 22], [Date.UTC(1985, 6, 1), 23], [Date.UTC(1988, 0, 1), 24],
  [Date.UTC(1990, 0, 1), 25], [Date.UTC(1991, 0, 1), 26], [Date.UTC(1992, 6, 1), 27],
  [Date.UTC(1993, 6, 1), 28], [Date.UTC(1994, 6, 1), 29], [Date.UTC(1996, 0, 1), 30],
  [Date.UTC(1997, 6, 1), 31], [Date.UTC(1999, 0, 1), 32], [Date.UTC(2006, 0, 1), 33],
  [Date.UTC(2009, 0, 1), 34], [Date.UTC(2012, 6, 1), 35], [Date.UTC(2015, 6, 1), 36],
  [Date.UTC(2017, 0, 1), 37],
];

/** TAI-UTC in seconds. Pre-1972 UTC used variable-length seconds and is not modeled. */
export function taiMinusUtc(utcCalendarMs: number): number {
  for (let i = LEAP_SECONDS.length - 1; i >= 0; i--) {
    if (utcCalendarMs >= LEAP_SECONDS[i][0]) return LEAP_SECONDS[i][1];
  }
  return LEAP_SECONDS[0][1];
}

export class Epoch {
  /** TT seconds since J2000.0 */
  readonly tt: number;

  private constructor(tt: number) {
    this.tt = tt;
  }

  static fromTT(ttSecondsSinceJ2000: number): Epoch {
    return new Epoch(ttSecondsSinceJ2000);
  }

  /** From a JS timestamp (UTC calendar milliseconds). */
  static fromUnixMs(ms: number): Epoch {
    const calendarSeconds = (ms - J2000_CALENDAR_MS) / 1000;
    return new Epoch(calendarSeconds + taiMinusUtc(ms) + TT_MINUS_TAI);
  }

  static now(): Epoch {
    return Epoch.fromUnixMs(Date.now());
  }

  plus(seconds: number): Epoch {
    return new Epoch(this.tt + seconds);
  }

  /** Back to UTC calendar ms. Ambiguous only inside a leap second itself. */
  toUnixMs(): number {
    const guess = J2000_CALENDAR_MS + (this.tt - TT_MINUS_TAI - 37) * 1000;
    const dAT = taiMinusUtc(guess);
    return J2000_CALENDAR_MS + (this.tt - TT_MINUS_TAI - dAT) * 1000;
  }

  toDate(): Date {
    return new Date(this.toUnixMs());
  }

  daysSinceJ2000(): number {
    return this.tt / 86400;
  }

  julianCenturiesTT(): number {
    return this.tt / (86400 * 36525);
  }

  /** TDB seconds since J2000; periodic terms good to ~30 µs, enough for planetary ephemerides. */
  tdb(): number {
    const g = ((357.53 + 0.98560028 * this.daysSinceJ2000()) * Math.PI) / 180;
    return this.tt + 0.001657 * Math.sin(g) + 0.00001385 * Math.sin(2 * g);
  }
}