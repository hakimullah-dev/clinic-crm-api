const { z } = require('zod');
const { isClinicHours } = require('./datetime');

const AUSTRALIAN_PHONE_MESSAGE = 'Invalid Australian phone format';
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const VALID_DOCTOR_DAYS = new Set(DAY_NAMES);
const DOCTOR_SLOT_DURATIONS = [10, 15, 20, 30, 45, 60];
const APPOINTMENT_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed', 'no_show'];
const WAITLIST_STATUSES = ['waiting', 'offered', 'booked', 'cancelled'];
const BOOKING_SOURCES = ['aria_voice', 'receptionist', 'patient_portal'];

const stripHtml = (value) => value.replace(/<[^>]*>/g, '');

const sanitizeString = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  return value.trim();
};

const normalizeEmail = (value) => sanitizeString(value).toLowerCase();

const normalizePhone = (value) => {
  const sanitized = sanitizeString(value).replace(/[\s()-]/g, '');

  if (/^04\d{8}$/.test(sanitized)) {
    return `+61${sanitized.slice(1)}`;
  }

  if (/^\+614\d{8}$/.test(sanitized)) {
    return sanitized;
  }

  if (/^614\d{8}$/.test(sanitized)) {
    return `+${sanitized}`;
  }

  return sanitized;
};

const normalizeDayName = (value) => {
  const trimmed = sanitizeString(value);
  const lower = trimmed.toLowerCase();
  const aliases = {
    mon: 'Monday',
    monday: 'Monday',
    tue: 'Tuesday',
    tues: 'Tuesday',
    tuesday: 'Tuesday',
    wed: 'Wednesday',
    wednesday: 'Wednesday',
    thu: 'Thursday',
    thur: 'Thursday',
    thurs: 'Thursday',
    thursday: 'Thursday',
    fri: 'Friday',
    friday: 'Friday',
    sat: 'Saturday',
    saturday: 'Saturday',
    sun: 'Sunday',
    sunday: 'Sunday'
  };

  return aliases[lower] || trimmed;
};

const parseWorkingDays = (value) => {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = sanitizeString(value);
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_) {
    // Fall through to comma-separated parsing.
  }

  return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
};

const isIsoDateString = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const isPastIsoDate = (value) => {
  if (!isIsoDateString(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(value)) {
    return false;
  }

  const today = new Date();
  const todayIso = new Date(Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate()
  )).toISOString().slice(0, 10);

  return value < todayIso;
};

const isIsoDateTimeString = (value) => !Number.isNaN(new Date(value).getTime()) && /T/.test(value);

const isWithinClinicHours = (value) => {
  if (!isIsoDateTimeString(value)) {
    return false;
  }

  const date = new Date(value);
  if (date.getTime() <= Date.now()) {
    return false;
  }

  return isClinicHours(value);
};

const parseTimeToMinutes = (value) => {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
};

const trimmedString = (field, min, max) => z
  .string({ required_error: `${field} is required`, invalid_type_error: `${field} must be a string` })
  .transform(sanitizeString)
  .refine((value) => value.length >= min, { message: `${field} must be at least ${min} characters` })
  .refine((value) => value.length <= max, { message: `${field} must be at most ${max} characters` });

const optionalTrimmedString = (field, min, max) => z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => {
    if (value === undefined || value === null) {
      return undefined;
    }

    const trimmed = sanitizeString(value);
    return trimmed || undefined;
  })
  .pipe(trimmedString(field, min, max).optional());

const emailSchema = z.preprocess(
  (value) => (typeof value === 'string' ? normalizeEmail(value) : value),
  z.string({ required_error: 'Email is required', invalid_type_error: 'Email must be a string' })
    .email('Invalid email address')
);

const optionalEmailSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => {
    if (value === undefined || value === null) {
      return undefined;
    }

    const normalized = normalizeEmail(value);
    return normalized || undefined;
  })
  .pipe(emailSchema.optional());

const australianPhoneSchema = z
  .string({ required_error: 'Phone is required', invalid_type_error: 'Phone must be a string' })
  .transform(normalizePhone)
  .refine((value) => /^\+614\d{8}$/.test(value), { message: AUSTRALIAN_PHONE_MESSAGE });

const optionalAustralianPhoneSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => {
    if (value === undefined || value === null) {
      return undefined;
    }

    const normalized = normalizePhone(value);
    return normalized || undefined;
  })
  .pipe(australianPhoneSchema.optional());

const doctorPasswordSchema = z.preprocess(
  (value) => (typeof value === 'string' ? sanitizeString(value) : value),
  z.string({ required_error: 'Password is required', invalid_type_error: 'Password must be a string' })
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must include at least 1 uppercase letter')
    .regex(/[0-9]/, 'Password must include at least 1 number')
);

const authPasswordSchema = z.preprocess(
  (value) => (typeof value === 'string' ? sanitizeString(value) : value),
  z.string({ required_error: 'Password is required', invalid_type_error: 'Password must be a string' })
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must include at least 1 uppercase letter')
    .regex(/[a-z]/, 'Password must include at least 1 lowercase letter')
    .regex(/[0-9]/, 'Password must include at least 1 number')
    .regex(/[^A-Za-z0-9]/, 'Password must include at least 1 special character')
);

const isoDateOfBirthSchema = z
  .string({ invalid_type_error: 'date_of_birth must be a string' })
  .transform(sanitizeString)
  .refine(isPastIsoDate, { message: 'date_of_birth must be a valid ISO date in the past' });

const optionalDateOfBirthSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => {
    if (value === undefined || value === null) {
      return undefined;
    }

    const trimmed = sanitizeString(value);
    return trimmed || undefined;
  })
  .pipe(isoDateOfBirthSchema.optional());

const dayNameSchema = z
  .string({ invalid_type_error: 'working_days entries must be strings' })
  .transform(normalizeDayName)
  .refine((value) => VALID_DOCTOR_DAYS.has(value), { message: 'working_days must contain valid day names' });

const workingDaysSchema = z
  .preprocess(parseWorkingDays, z.array(dayNameSchema))
  .refine((value) => value.length >= 1, { message: 'working_days must contain at least 1 day' });

const timeSchema = z.preprocess(
  (value) => (typeof value === 'string' ? sanitizeString(value) : value),
  z.string({ invalid_type_error: 'Time must be a string' })
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be in HH:MM format')
    .refine((value) => {
      const minutes = parseTimeToMinutes(value);
      return minutes >= 9 * 60 && minutes <= 18 * 60;
    }, { message: 'Time must be between 09:00 and 18:00' })
);

const notesSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => {
    if (value === undefined || value === null) {
      return undefined;
    }

    const sanitized = sanitizeString(stripHtml(value));
    return sanitized || undefined;
  })
  .pipe(z.string().max(500, 'notes must be at most 500 characters').optional());

const commentSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => {
    if (value === undefined || value === null) {
      return undefined;
    }

    const sanitized = sanitizeString(stripHtml(value));
    return sanitized || undefined;
  })
  .pipe(z.string().max(1000, 'comment must be at most 1000 characters').optional());

const aiSummarySchema = z.preprocess(
  (value) => (typeof value === 'string' ? sanitizeString(stripHtml(value)) : value),
  z.string({ required_error: 'ai_summary is required', invalid_type_error: 'ai_summary must be a string' })
    .min(1, 'ai_summary is required')
    .max(5000, 'ai_summary must be at most 5000 characters')
);

const isoDateTimeSchema = z
  .string({ invalid_type_error: 'scheduled_at must be a string' })
  .transform(sanitizeString)
  .refine(isIsoDateTimeString, { message: 'scheduled_at must be a valid ISO datetime string' })
  .refine((value) => new Date(value).getTime() > Date.now(), { message: 'scheduled_at must be in the future' })
  .refine(isWithinClinicHours, {
    message: 'scheduled_at must be within clinic hours (Mon-Sat 09:00-18:00 AEST)'
  });

const optionalIsoDateTimeSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => {
    if (value === undefined || value === null) {
      return undefined;
    }

    const trimmed = sanitizeString(value);
    return trimmed || undefined;
  })
  .pipe(isoDateTimeSchema.optional());

const patientShape = {
  full_name: trimmedString('full_name', 2, 100),
  phone: australianPhoneSchema,
  email: optionalEmailSchema,
  date_of_birth: optionalDateOfBirthSchema
};

const doctorShape = {
  full_name: trimmedString('full_name', 2, 100),
  email: emailSchema,
  specialty: trimmedString('specialty', 2, 100),
  working_days: workingDaysSchema,
  start_time: timeSchema,
  end_time: timeSchema,
  slot_duration_mins: z.coerce.number({ invalid_type_error: 'slot_duration_mins must be a number' })
    .int('slot_duration_mins must be an integer')
    .refine((value) => DOCTOR_SLOT_DURATIONS.includes(value), {
      message: `slot_duration_mins must be one of: ${DOCTOR_SLOT_DURATIONS.join(', ')}`
    }),
  password: doctorPasswordSchema
};

const appointmentShape = {
  patient_id: z.string({ required_error: 'patient_id is required' }).uuid('patient_id must be a valid UUID'),
  doctor_id: z.string({ required_error: 'doctor_id is required' }).uuid('doctor_id must be a valid UUID'),
  scheduled_at: isoDateTimeSchema,
  status: z.enum(APPOINTMENT_STATUSES, { errorMap: () => ({ message: `status must be one of: ${APPOINTMENT_STATUSES.join(', ')}` }) }),
  booking_source: z.enum(BOOKING_SOURCES).default('receptionist'),
  notes: notesSchema
};

const feedbackShape = {
  appointment_id: z.string({ required_error: 'appointment_id is required' }).uuid('appointment_id must be a valid UUID'),
  rating: z.coerce.number({ invalid_type_error: 'rating must be a number' })
    .int('rating must be an integer')
    .min(1, 'rating must be at least 1')
    .max(5, 'rating must be at most 5'),
  comment: commentSchema
};

const waitlistShape = {
  doctor_id: z.string({ required_error: 'doctor_id is required' }).uuid('doctor_id must be a valid UUID'),
  patient_id: z.string({ required_error: 'patient_id is required' }).uuid('patient_id must be a valid UUID'),
  status: z.enum(WAITLIST_STATUSES, { errorMap: () => ({ message: `status must be one of: ${WAITLIST_STATUSES.join(', ')}` }) })
};

const signupShape = {
  email: emailSchema,
  password: authPasswordSchema,
  full_name: optionalTrimmedString('full_name', 2, 100),
  name: optionalTrimmedString('name', 2, 100),
  phone: optionalAustralianPhoneSchema,
  temporary_password: authPasswordSchema.optional(),
  setup_key: z.string().transform(sanitizeString).optional()
};

const buildCreateSchema = (shape) => z.object(shape).strip();

const buildPatchSchema = (shape, forbiddenFields = []) => z.object(shape).partial().passthrough().superRefine((data, ctx) => {
  const allowedFields = new Set(Object.keys(shape));

  for (const key of Object.keys(data)) {
    if (forbiddenFields.includes(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} cannot be updated`
      });
      continue;
    }

    if (!allowedFields.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is not allowed`
      });
    }
  }
});

const patientCreateSchema = buildCreateSchema({
  ...patientShape,
  password: authPasswordSchema.optional(),
  temporary_password: authPasswordSchema.optional()
});

const patientPatchSchema = buildPatchSchema(patientShape, ['id', 'created_at', 'user_id']);

const doctorCreateSchema = buildCreateSchema(doctorShape).superRefine((data, ctx) => {
  if (parseTimeToMinutes(data.end_time) <= parseTimeToMinutes(data.start_time)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['end_time'],
      message: 'end_time must be after start_time'
    });
  }
});

const doctorPatchSchema = buildPatchSchema({
  full_name: doctorShape.full_name,
  email: doctorShape.email,
  specialty: doctorShape.specialty,
  working_days: doctorShape.working_days,
  start_time: doctorShape.start_time,
  end_time: doctorShape.end_time,
  slot_duration_mins: doctorShape.slot_duration_mins
}, ['id', 'created_at', 'user_id']).superRefine((data, ctx) => {
  if (data.start_time && data.end_time && parseTimeToMinutes(data.end_time) <= parseTimeToMinutes(data.start_time)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['end_time'],
      message: 'end_time must be after start_time'
    });
  }
});

const appointmentCreateSchema = buildCreateSchema(appointmentShape);

const appointmentPatchSchema = buildPatchSchema({
  patient_id: appointmentShape.patient_id,
  doctor_id: appointmentShape.doctor_id,
  scheduled_at: appointmentShape.scheduled_at,
  status: appointmentShape.status,
  booking_source: z.enum(BOOKING_SOURCES).optional(),
  notes: appointmentShape.notes,
  reminder_sent_at: optionalIsoDateTimeSchema,
  reminder_72h_sent: z.boolean().optional(),
  reminder_24h_sent: z.boolean().optional(),
  reminder_2h_sent: z.boolean().optional(),
  intake_form_sent: z.boolean().optional(),
  intake_form_sent_at: optionalIsoDateTimeSchema
}, ['id', 'created_at', 'user_id']);

const appointmentStatusPatchSchema = buildCreateSchema({
  status: appointmentShape.status
});

const appointmentRescheduleSchema = buildCreateSchema({
  scheduled_at: z.string()
    .datetime('scheduled_at must be a valid ISO datetime string')
    .refine((value) => new Date(value).getTime() > Date.now(), {
      message: 'scheduled_at must be in the future'
    })
    .refine(isWithinClinicHours, {
      message: 'scheduled_at must be within clinic hours (Mon-Sat 09:00-18:00 AEST)'
    }),
  reason: z.string().trim().max(500, 'reason must be at most 500 characters').optional(),
  google_event_id: z.string().trim().max(255, 'google_event_id must be at most 255 characters').optional()
});

const feedbackCreateSchema = buildCreateSchema(feedbackShape);

const waitlistCreateSchema = buildCreateSchema(waitlistShape);

const waitlistStatusPatchSchema = buildCreateSchema({
  status: waitlistShape.status
});

const waitlistPatchSchema = z.object({
  status: waitlistShape.status.optional(),
  offered_at: z.string().datetime('offered_at must be a valid ISO datetime string').optional()
}).strict().refine((data) => Object.keys(data).length > 0, {
  message: 'At least one waitlist field is required'
});

const intakeFormCreateSchema = z.object({
  appointment_id: z.string({ required_error: 'appointment_id is required' }).uuid('appointment_id must be a valid UUID')
}).passthrough();

const intakeSummaryPatchSchema = buildCreateSchema({
  ai_summary: aiSummarySchema
});

const authSignupSchema = buildCreateSchema(signupShape);
const authRegisterSchema = buildCreateSchema(signupShape);
const authRegisterAdminSchema = buildCreateSchema(signupShape);

const authLoginSchema = buildCreateSchema({
  email: emailSchema,
  password: z.preprocess(
    (value) => (typeof value === 'string' ? sanitizeString(value) : value),
    z.string({ required_error: 'Password is required', invalid_type_error: 'Password must be a string' })
      .min(1, 'Password is required')
  )
});

const authLogoutSchema = z.object({
  token: z.union([z.string(), z.undefined(), z.null()]).transform((value) => {
    if (value === undefined || value === null) {
      return undefined;
    }

    const trimmed = sanitizeString(value);
    return trimmed || undefined;
  })
}).strip();

module.exports = {
  APPOINTMENT_STATUSES,
  WAITLIST_STATUSES,
  BOOKING_SOURCES,
  patientCreateSchema,
  patientPatchSchema,
  doctorCreateSchema,
  doctorPatchSchema,
  appointmentCreateSchema,
  appointmentPatchSchema,
  appointmentStatusPatchSchema,
  appointmentRescheduleSchema,
  feedbackCreateSchema,
  waitlistCreateSchema,
  waitlistStatusPatchSchema,
  waitlistPatchSchema,
  intakeFormCreateSchema,
  intakeSummaryPatchSchema,
  authSignupSchema,
  authRegisterSchema,
  authRegisterAdminSchema,
  authLoginSchema,
  authLogoutSchema,
  isWithinClinicHours
};
