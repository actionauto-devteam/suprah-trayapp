export const COMPANY_TZ = 'America/Denver';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: COMPANY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: COMPANY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function companyDateStr(date: Date = new Date()): string {
  return dateFormatter.format(date);
}

function companyOffsetMsAt(ms: number): number {
  const values: Record<string, string> = {};
  for (const part of partsFormatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  const wallClockAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour) % 24,
    Number(values.minute),
    Number(values.second),
  );
  return wallClockAsUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

export function companyDayStartUtcMs(date: Date = new Date()): number {
  const [year, month, day] = companyDateStr(date).split('-').map(Number);
  const wallMidnight = Date.UTC(year, month - 1, day);
  let guess = wallMidnight;
  for (let i = 0; i < 3; i++) guess = wallMidnight - companyOffsetMsAt(guess);
  return guess;
}
