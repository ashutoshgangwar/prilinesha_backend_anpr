/**
 * Calendar arithmetic in a named timezone.
 *
 * Everything in this system is stored in UTC, but "how many vehicles came in
 * today" is a question about a *local* day: a car entering a Pune parking lot at
 * 04:00 IST belongs to that morning, not to the previous UTC day. So the
 * reporting endpoints bucket by a timezone the caller names (defaulting to
 * REPORT_TIMEZONE), and this module is the one place that knows how to turn an
 * instant into a local calendar bucket and back again.
 *
 * The bucket keys produced here are byte-for-byte what MongoDB's `$dateToString`
 * produces for the same instant, format and timezone — that is the contract that
 * lets the aggregation group server-side while this file fills in the empty
 * buckets a graph still needs a point for. Change one side and you must change
 * the other; see BUCKET_FORMATS below, which states both.
 *
 * No third-party date library: `Intl` already carries the IANA database, so the
 * offset (including DST, for the deployments that have it) is read from the
 * platform rather than approximated.
 */

const MS_PER_SECOND = 1000;
const MS_PER_DAY = 86_400_000;

/**
 * The bucket granularities the reports support, each with the two
 * representations that must agree:
 *
 *   mongo — the `$dateToString` format string the aggregation groups by.
 *   label — how this file rebuilds the same key from local calendar parts.
 *
 * `%G-W%V` is the ISO week-numbering year and ISO week number, which is why the
 * JS side computes ISO weeks rather than "the week containing the 1st".
 */
const BUCKET_FORMATS = {
  hour: { mongo: '%Y-%m-%dT%H:00' },
  day: { mongo: '%Y-%m-%d' },
  week: { mongo: '%G-W%V' },
  month: { mongo: '%Y-%m' },
};

/** Intl formatters are expensive to build and immutable — build each once. */
const formatterCache = new Map();

const formatterFor = (timeZone) => {
  let formatter = formatterCache.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23', // so midnight is hour 0, not hour 24
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }

  return formatter;
};

/**
 * Is this a timezone the platform recognises?
 *
 * Used by the validator so a typo comes back as a 400 naming the field, rather
 * than as a RangeError thrown from inside an aggregation.
 *
 * @param {string} timeZone IANA name, e.g. "Asia/Kolkata".
 * @returns {boolean}
 */
const isValidTimeZone = (timeZone) => {
  if (!timeZone || typeof timeZone !== 'string') return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
};

/**
 * The local calendar reading of an instant.
 *
 * @param {Date} date
 * @param {string} timeZone
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, second: number}}
 *          `month` is 1-based, as a person writes it.
 */
const zonedParts = (date, timeZone) => {
  const parts = formatterFor(timeZone).formatToParts(date);
  const read = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
};

/** How far ahead of UTC `timeZone` is at this instant, in milliseconds. */
const zonedOffsetMs = (date, timeZone) => {
  const parts = zonedParts(date, timeZone);

  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  // The formatter has no milliseconds, so compare against the instant truncated
  // to the second — otherwise every offset would come back a few ms out.
  return asIfUtc - Math.floor(date.getTime() / MS_PER_SECOND) * MS_PER_SECOND;
};

/**
 * The instant at which a local wall-clock time occurs.
 *
 * Out-of-range components are normalised the way `Date.UTC` does, which is what
 * makes "the 32nd of August" a usable way to say "the 1st of September" when
 * stepping a cursor forward a bucket at a time.
 *
 * The offset is resolved twice on purpose. The first guess reads the offset at
 * the wrong instant whenever a DST boundary falls between the two, and the
 * second pass — taken at the instant the first produced — corrects it. Zones
 * without DST (India, the deployment this was written for) settle on the first.
 *
 * @param {{year: number, month: number, day?: number, hour?: number, minute?: number, second?: number, ms?: number}} parts
 * @param {string} timeZone
 * @returns {Date}
 */
const instantFromZoned = (
  { year, month, day = 1, hour = 0, minute = 0, second = 0, ms = 0 },
  timeZone
) => {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second, ms);

  const firstGuess = asIfUtc - zonedOffsetMs(new Date(asIfUtc), timeZone);
  const correction = zonedOffsetMs(new Date(firstGuess), timeZone);

  return new Date(asIfUtc - correction);
};

/**
 * ISO-8601 week number and week-numbering year for a local calendar date.
 *
 * Matches MongoDB's `%V` and `%G`: weeks start on Monday, and week 1 is the one
 * containing the first Thursday of the year — which is why the 1st of January
 * can legitimately report week 52 of the previous year.
 *
 * @returns {{isoYear: number, isoWeek: number}}
 */
const isoWeekParts = ({ year, month, day }) => {
  const date = new Date(Date.UTC(year, month - 1, day));

  // Monday = 0 … Sunday = 6, then step to this week's Thursday, which is the
  // day that decides which year (and therefore which week number) the week is in.
  const mondayIndex = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - mondayIndex + 3);

  const isoYear = date.getUTCFullYear();

  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);

  const isoWeek = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));

  return { isoYear, isoWeek };
};

const pad = (value, width = 2) => String(value).padStart(width, '0');

/**
 * The bucket an instant falls into, as a key.
 *
 * Must stay identical to what `$dateToString` returns for BUCKET_FORMATS[…].mongo
 * — the aggregation produces these keys and this function fills the gaps between
 * them.
 *
 * @param {Date} date
 * @param {'hour'|'day'|'week'|'month'} granularity
 * @param {string} timeZone
 * @returns {string} e.g. "2026-08-13T14:00", "2026-08-13", "2026-W33", "2026-08".
 */
const bucketKey = (date, granularity, timeZone) => {
  const parts = zonedParts(date, timeZone);

  switch (granularity) {
    case 'hour':
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:00`;
    case 'week': {
      const { isoYear, isoWeek } = isoWeekParts(parts);
      return `${isoYear}-W${pad(isoWeek)}`;
    }
    case 'month':
      return `${parts.year}-${pad(parts.month)}`;
    case 'day':
    default:
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  }
};

/**
 * The instant a bucket opens — local midnight, the top of the local hour, the
 * local Monday, or the local 1st of the month.
 *
 * @param {Date} date Any instant inside the bucket.
 * @param {'hour'|'day'|'week'|'month'} granularity
 * @param {string} timeZone
 * @returns {Date}
 */
const bucketStart = (date, granularity, timeZone) => {
  const parts = zonedParts(date, timeZone);

  switch (granularity) {
    case 'hour':
      return instantFromZoned({ ...parts, minute: 0, second: 0 }, timeZone);
    case 'week': {
      // Back up to Monday. Day 0 and negatives roll into the previous month,
      // which Date.UTC normalises for us.
      const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
      const mondayIndex = (weekday + 6) % 7;
      return instantFromZoned({ ...parts, day: parts.day - mondayIndex, hour: 0, minute: 0, second: 0 }, timeZone);
    }
    case 'month':
      return instantFromZoned({ ...parts, day: 1, hour: 0, minute: 0, second: 0 }, timeZone);
    case 'day':
    default:
      return instantFromZoned({ ...parts, hour: 0, minute: 0, second: 0 }, timeZone);
  }
};

/**
 * The instant the next bucket opens. Stepping through local calendar parts
 * rather than adding a fixed number of milliseconds, so a DST change shortens or
 * lengthens the day instead of shifting every later bucket by an hour.
 */
const nextBucketStart = (start, granularity, timeZone) => {
  const parts = zonedParts(start, timeZone);
  const midnight = { ...parts, hour: 0, minute: 0, second: 0 };

  switch (granularity) {
    case 'hour':
      return instantFromZoned({ ...parts, hour: parts.hour + 1, minute: 0, second: 0 }, timeZone);
    case 'week':
      return instantFromZoned({ ...midnight, day: parts.day + 7 }, timeZone);
    case 'month':
      return instantFromZoned({ ...midnight, day: 1, month: parts.month + 1 }, timeZone);
    case 'day':
    default:
      return instantFromZoned({ ...midnight, day: parts.day + 1 }, timeZone);
  }
};

/**
 * Every bucket covering a window, in order and with no gaps.
 *
 * A chart needs a point for a quiet Sunday, and the aggregation cannot supply
 * one — `$group` only ever emits buckets that have documents in them. So the
 * axis is generated here and the counts are merged onto it.
 *
 * @param {Date} from Start of the window (its own bucket is included, even if partial).
 * @param {Date} to   End of the window, inclusive.
 * @param {'hour'|'day'|'week'|'month'} granularity
 * @param {string} timeZone
 * @param {number} [limit] Stop after this many buckets — a backstop, not a policy;
 *                 callers reject over-wide windows before getting here.
 * @returns {Array<{key: string, starts_at: Date}>}
 */
const enumerateBuckets = (from, to, granularity, timeZone, limit = 10_000) => {
  const buckets = [];

  let cursor = bucketStart(from, granularity, timeZone);

  while (cursor.getTime() <= to.getTime() && buckets.length < limit) {
    buckets.push({ key: bucketKey(cursor, granularity, timeZone), starts_at: cursor });
    cursor = nextBucketStart(cursor, granularity, timeZone);
  }

  return buckets;
};

/**
 * Reads one end of a `from`/`to` window the way an operator means it.
 *
 * Three input shapes, and the difference between them is the point:
 *
 *   2026-08-07              — a whole local day. As `from` it starts at local
 *                             00:00:00.000, as `to` it ends at local 23:59:59.999,
 *                             so "up to the 7th" includes the 7th.
 *   2026-08-07T09:30:00     — that wall-clock time *in the report's timezone*,
 *                             which is the clock the operator is reading.
 *   2026-08-07T09:30:00Z    — an explicit instant, taken as given. An offset
 *                             (+05:30) works the same way.
 *
 * @param {string} value
 * @param {'start'|'end'} edge
 * @param {string} timeZone
 * @returns {Date|null} Null when the value is absent or unparsable.
 */
const parseZonedBoundary = (value, edge, timeZone) => {
  if (!value) return null;

  const raw = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number);

    return instantFromZoned(
      edge === 'end'
        ? { year, month, day, hour: 23, minute: 59, second: 59, ms: 999 }
        : { year, month, day },
      timeZone
    );
  }

  // Anything carrying its own offset is already an instant.
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/
  );

  if (!match) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const [, year, month, day, hour, minute, second, ms] = match;

  return instantFromZoned(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second ?? 0),
      ms: Number((ms ?? '0').padEnd(3, '0')),
    },
    timeZone
  );
};

/** Local midnight of the day an instant falls in. */
const startOfZonedDay = (date, timeZone) => bucketStart(date, 'day', timeZone);

/** The last millisecond of the local day an instant falls in. */
const endOfZonedDay = (date, timeZone) =>
  new Date(nextBucketStart(startOfZonedDay(date, timeZone), 'day', timeZone).getTime() - 1);

/** Local midnight `days` days before the given instant's local midnight. */
const shiftZonedDays = (date, days, timeZone) => {
  const parts = zonedParts(date, timeZone);
  return instantFromZoned({ ...parts, day: parts.day + days, hour: 0, minute: 0, second: 0 }, timeZone);
};

module.exports = {
  BUCKET_FORMATS,
  MS_PER_DAY,
  isValidTimeZone,
  zonedParts,
  zonedOffsetMs,
  instantFromZoned,
  isoWeekParts,
  bucketKey,
  bucketStart,
  nextBucketStart,
  enumerateBuckets,
  parseZonedBoundary,
  startOfZonedDay,
  endOfZonedDay,
  shiftZonedDays,
};
