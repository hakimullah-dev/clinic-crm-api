const config = require('./config');

const CLINIC_DAY_FORMATTER = new Intl.DateTimeFormat('en-AU', {
  weekday: 'long',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: config.app.timezone
});

const PATIENT_FORMATTER = new Intl.DateTimeFormat('en-AU', {
  weekday: 'long',
  day: '2-digit',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: config.app.timezone
});

const buildDate = (value) => {
  if (value instanceof Date) return value;
  return new Date(value);
};

const parseIsoDateTimeWithOffset = (value) => {
  if (typeof value !== 'string') return null;

  const match = value.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/
  );

  if (!match) return null;

  const [, year, month, day, hour, minute, second = '00'] = match;
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) return null;

  return {
    dayOfWeek: new Date(Number(year), Number(month) - 1, Number(day)).getDay(),
    totalSeconds: (Number(hour) * 60 * 60) + (Number(minute) * 60) + Number(second)
  };
};

const getClinicDateParts = (value) => {
  const date = buildDate(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = CLINIC_DAY_FORMATTER.formatToParts(date);
  const weekday = parts.find((p) => p.type === 'weekday')?.value || '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);

  return { date, weekday, minutes: hour * 60 + minute };
};

function toAEST(value) {
  const parts = getClinicDateParts(value);
  if (!parts) return '';
  return PATIENT_FORMATTER.format(parts.date);
}

function isClinicDay(value) {
  const parts = getClinicDateParts(value);
  if (!parts) return false;
  return parts.weekday !== 'Sunday';
}

function isClinicHours(value) {
  const parsedWithOffset = parseIsoDateTimeWithOffset(value);
  if (parsedWithOffset) {
    return parsedWithOffset.dayOfWeek >= 1
      && parsedWithOffset.dayOfWeek <= 6
      && parsedWithOffset.totalSeconds >= 9 * 60 * 60
      && parsedWithOffset.totalSeconds <= 18 * 60 * 60;
  }

  const parts = getClinicDateParts(value);
  if (!parts) return false;
  return isClinicDay(parts.date) && parts.minutes >= 9 * 60 && parts.minutes <= 18 * 60;
}

function formatForPatient(value) {
  return toAEST(value);
}

module.exports = {
  toAEST,
  isClinicHours,
  isClinicDay,
  formatForPatient
};