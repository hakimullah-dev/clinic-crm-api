const express = require('express');
const { z } = require('zod');
const router = express.Router();
const supabase = require('../lib/supabase');
const validate = require('../middleware/validate');
const {
  APPOINTMENT_STATUSES,
  appointmentCreateSchema,
  appointmentPatchSchema,
  appointmentRescheduleSchema,
  appointmentStatusPatchSchema
} = require('../lib/validators');
const {
  ROLES,
  hasAnyRole,
  sendForbidden,
  loadAccessContext,
  canAccessDoctor,
  getScopedDoctorId,
  canAccessPatient,
  getScopedPatientId,
  canAccessAppointment,
  getAppointmentById
} = require('../lib/access');
const { fireWebhook, logAudit } = require('../lib/webhooks');

const appointmentStatuses = APPOINTMENT_STATUSES;
const doctorStatusUpdateRoles = [ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR];
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(DEFAULT_PAGE),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT)
});

const reminderSentSchema = z.object({
  reminder_sent_at: z.string().datetime().optional()
}).strict();

const isValidDateInput = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
};

const buildDayRange = (dateString) => {
  const start = new Date(`${dateString}T00:00:00.000Z`);
  const end = new Date(`${dateString}T23:59:59.999Z`);
  return { start, end };
};

const weekdayKeyByShortName = Object.freeze({
  mon: 'mon', tue: 'tue', wed: 'wed', thu: 'thu',
  fri: 'fri', sat: 'sat', sun: 'sun'
});

const getPagination = (query = {}) => {
  const { page, limit } = paginationSchema.parse(query);
  const from = (page - 1) * limit;
  const to = from + limit - 1;
  return { page, limit, from, to };
};

const buildPaginationMeta = (page, limit, total) => ({
  page, limit, total,
  pages: total === 0 ? 0 : Math.ceil(total / limit)
});

const getLocalDateParts = (dateString) => {
  const [year, month, day] = String(dateString || '').split('-').map(Number);
  if (!year || !month || !day) return null;
  return { year, month, day };
};

const getSydneyDayWindow = (dateString) => {
  const parts = getLocalDateParts(dateString);
  if (!parts) return null;
  const { year, month, day } = parts;
  return {
    start: new Date(year, month - 1, day, 0, 0, 0, 0),
    end: new Date(year, month - 1, day, 23, 59, 59, 999)
  };
};

const parseTimeToMinutes = (value) => {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  return (hours * 60) + minutes;
};

const formatMinutesAsTime = (minutes) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};

const getSydneyOffsetForDate = (dateString) => {
  const probe = new Date(`${dateString}T12:00:00.000Z`);
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    timeZoneName: 'shortOffset'
  }).formatToParts(probe);
  const offset = parts.find((part) => part.type === 'timeZoneName')?.value || 'GMT+10';
  const match = offset.match(/^GMT([+-]\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return '+10:00';
  const hours = String(Math.abs(Number(match[1]))).padStart(2, '0');
  const minutes = match[2] || '00';
  const sign = match[1].startsWith('-') ? '-' : '+';
  return `${sign}${hours}:${minutes}`;
};

const getDoctorWorkingWindow = (workingHours, date) => {
  if (!workingHours || typeof workingHours !== 'object' || Array.isArray(workingHours)) return null;
  const weekdayShort = date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'Australia/Sydney' }).toLowerCase();
  const weekdayLong = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Australia/Sydney' }).toLowerCase();
  const candidates = [weekdayKeyByShortName[weekdayShort], weekdayShort, weekdayLong].filter(Boolean);
  for (const key of candidates) {
    const window = workingHours[key];
    if (window && typeof window === 'object') return window;
  }
  return null;
};

const getDoctorScheduleForDate = (doctor, date) => {
  const configuredWindow = getDoctorWorkingWindow(doctor.working_hours, date);
  if (configuredWindow?.start && configuredWindow?.end) {
    return {
      startTime: configuredWindow.start,
      endTime: configuredWindow.end,
      slotDuration: doctor.slot_duration_mins || 30,
      consultationDuration: doctor.consultation_duration_mins || doctor.slot_duration_mins || 30,
      workingDays: Array.isArray(doctor.working_days) && doctor.working_days.length
        ? doctor.working_days
        : ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    };
  }
  return {
    startTime: doctor.start_time || '09:00',
    endTime: doctor.end_time || '18:00',
    slotDuration: doctor.slot_duration_mins || 30,
    consultationDuration: doctor.consultation_duration_mins || doctor.slot_duration_mins || 30,
    workingDays: Array.isArray(doctor.working_days) && doctor.working_days.length
      ? doctor.working_days
      : ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  };
};

// FIXED: syncPatientBookingSnapshot — never throws, always graceful
const syncPatientBookingSnapshot = async (patientId) => {
  if (!patientId) return;

  try {
    const [{ count: visitCount, error: countError }, { data: latestAppointment, error: latestError }] = await Promise.all([
      supabase
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .eq('patient_id', patientId)
        .eq('status', 'completed'),
      supabase
        .from('appointments')
        .select('doctor_id, scheduled_at, booking_source')
        .eq('patient_id', patientId)
        .in('status', ['completed', 'confirmed', 'pending', 'no_show'])
        .order('scheduled_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    ]);

    if (countError) {
      console.error('syncPatientBookingSnapshot countError:', countError);
      return;
    }

    if (latestError) {
      console.error('syncPatientBookingSnapshot latestError:', latestError);
      return;
    }

    const update = {
      visit_count: visitCount || 0,
      last_doctor_id: latestAppointment?.doctor_id || null,
      last_booking_date: latestAppointment?.scheduled_at || null,
      booking_source: latestAppointment?.booking_source || 'receptionist'
    };

    const { error: patientError } = await supabase
      .from('patients')
      .update(update)
      .eq('id', patientId);

    if (patientError) {
      console.error('syncPatientBookingSnapshot patientError:', patientError);
    }
  } catch (err) {
    console.error('syncPatientBookingSnapshot unexpected error:', err);
  }
};

const ensureSlotAvailable = async ({ appointmentId = null, doctorId, scheduledAt }) => {
  const query = supabase
    .from('appointments')
    .select('id')
    .eq('doctor_id', doctorId)
    .eq('scheduled_at', scheduledAt)
    .in('status', ['pending', 'confirmed', 'completed', 'no_show'])
    .limit(1);
  const scopedQuery = appointmentId ? query.neq('id', appointmentId) : query;
  const { data, error } = await scopedQuery.maybeSingle();
  if (error) throw error;
  return !data;
};

const formatAppointmentSummary = (appointment) => ({
  id: appointment.id,
  patient_id: appointment.patient_id,
  patient_name: appointment.patients?.full_name || null,
  doctor_id: appointment.doctor_id,
  doctor_name: appointment.doctors?.full_name || null,
  scheduled_at: appointment.scheduled_at,
  status: appointment.status,
  notes: appointment.notes || null,
  reminder_sent_at: appointment.reminder_sent_at || null
});

const getScopedAppointment = async (req, appointmentId, select) => {
  const appointment = await getAppointmentById(req.params.id || appointmentId, select);
  if (!appointment) return { notFound: true };
  const allowed = await canAccessAppointment(req, appointment);
  if (!allowed) return { forbidden: true };
  return { appointment };
};

const getAppointmentUpdatePayload = (body = {}, role) => {
  const allowedFieldsByRole = {
    [ROLES.ADMIN]: ['doctor_id', 'patient_id', 'scheduled_at', 'status', 'notes', 'reminder_sent_at', 'reminder_72h_sent', 'reminder_24h_sent', 'reminder_2h_sent', 'intake_form_sent', 'intake_form_sent_at'],
    [ROLES.RECEPTIONIST]: ['doctor_id', 'patient_id', 'scheduled_at', 'status', 'notes', 'reminder_sent_at', 'reminder_72h_sent', 'reminder_24h_sent', 'reminder_2h_sent', 'intake_form_sent', 'intake_form_sent_at'],
    [ROLES.DOCTOR]: ['status', 'notes', 'reminder_sent_at'],
    [ROLES.N8N_AGENT]: ['scheduled_at', 'status', 'notes', 'reminder_sent_at', 'reminder_72h_sent', 'reminder_24h_sent', 'reminder_2h_sent', 'intake_form_sent', 'intake_form_sent_at']
  };
  const allowedFields = allowedFieldsByRole[role] || [];
  const payload = Object.fromEntries(Object.entries(body).filter(([key]) => allowedFields.includes(key)));
  if (payload.status && !appointmentStatuses.includes(payload.status)) {
    return { error: `status must be one of: ${appointmentStatuses.join(', ')}` };
  }
  return { payload };
};

// GET all appointments
router.get('/', async (req, res, next) => {
  try {
    const { date, doctor_id, status, from, to, hours, completedToday } = req.query;
    const { page, limit, from: rangeFrom, to: rangeTo } = getPagination(req.query);
    if (date && !isValidDateInput(date)) return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });
    await loadAccessContext(req);
    let query = supabase.from('appointments').select('*, patients(*), doctors(*)', { count: 'exact' }).order('scheduled_at', { ascending: true });
    if (hasAnyRole(req, ROLES.DOCTOR)) {
      if (!req.user.doctorId) return sendForbidden(res, 'Doctor profile is not linked to this user');
      query = query.eq('doctor_id', req.user.doctorId);
    } else if (hasAnyRole(req, ROLES.PATIENT)) {
      if (!req.user.patientId) return sendForbidden(res, 'Patient profile is not linked to this user');
      query = query.eq('patient_id', req.user.patientId);
      if (doctor_id) query = query.eq('doctor_id', doctor_id);
    } else if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.N8N_AGENT)) {
      return sendForbidden(res);
    }
    if (date) { const { start, end } = buildDayRange(date); query = query.gte('scheduled_at', start.toISOString()).lte('scheduled_at', end.toISOString()); }
    if (from) query = query.gte('scheduled_at', from);
    if (to) query = query.lte('scheduled_at', to);
    if (hours) { const now = new Date(); const until = new Date(now.getTime() + Number(hours) * 60 * 60 * 1000); query = query.gte('scheduled_at', now.toISOString()).lte('scheduled_at', until.toISOString()); }
    if (completedToday === 'true') {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const end = new Date(); end.setHours(23, 59, 59, 999);
      query = query.eq('status', 'completed').gte('scheduled_at', start.toISOString()).lte('scheduled_at', end.toISOString());
    }
    if (doctor_id && !hasAnyRole(req, ROLES.DOCTOR, ROLES.PATIENT)) query = query.eq('doctor_id', doctor_id);
    if (status) query = query.eq('status', status);
    const { data, error, count } = await query.range(rangeFrom, rangeTo);
    if (error) throw error;
    const responseData = date && hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST)
      ? (data || []).map(formatAppointmentSummary)
      : (data || []);
    res.json({ data: responseData, pagination: buildPaginationMeta(page, limit, count || 0) });
  } catch (err) { next(err); }
});

const handleAvailableSlots = async (req, res, next) => {
  try {
    const doctorId = req.query.doctor_id || req.params.doctorId;
    const { date, duration_mins: durationMinsParam } = req.query;
    if (!doctorId) return res.status(400).json({ error: 'doctor_id query param required' });
    if (!date) return res.status(400).json({ error: 'date query param required' });
    const dayWindow = getSydneyDayWindow(date);
    if (!dayWindow) return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });
    const { data: doctor, error: docError } = await supabase.from('doctors').select('*').eq('id', doctorId).single();
    if (docError) return res.status(404).json({ error: 'Doctor not found' });
    const schedule = getDoctorScheduleForDate(doctor, dayWindow.start);
    const bookingDay = new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const doctorDays = (schedule.workingDays || []).map((value) => String(value).toLowerCase());
    if (!doctorDays.includes(bookingDay)) return res.json({ date, doctor_id: doctorId, available_slots: [], taken_slots: [] });
    const durationMins = Number(durationMinsParam) || schedule.consultationDuration || schedule.slotDuration || 30;
    const startValue = schedule.startTime || '09:00:00';
    const endValue = schedule.endTime || '18:00:00';
    const startTotal = parseTimeToMinutes(startValue);
    const endTotal = parseTimeToMinutes(endValue);
    if (startTotal === null || endTotal === null || durationMins <= 0 || startTotal >= endTotal) return res.json({ date, doctor_id: doctorId, available_slots: [], taken_slots: [] });
    const slots = [];
    const sydneyOffset = getSydneyOffsetForDate(date);
    for (let current = startTotal; current + durationMins <= endTotal; current += durationMins) {
      const time = formatMinutesAsTime(current);
      slots.push({ time, datetime: `${date}T${time}:00${sydneyOffset}` });
    }
    const { data: existing, error: existingError } = await supabase.from('appointments').select('scheduled_at').eq('doctor_id', doctorId).gte('scheduled_at', dayWindow.start.toISOString()).lte('scheduled_at', dayWindow.end.toISOString()).not('status', 'eq', 'cancelled');
    if (existingError) throw existingError;
    const takenSlots = (existing || []).map((appointment) => {
      const scheduledAt = new Date(appointment.scheduled_at);
      return scheduledAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Australia/Sydney' });
    });
    const takenSlotSet = new Set(takenSlots);
    const availableSlots = slots.filter((slot) => !takenSlotSet.has(slot.time));
    res.json({ date, doctor_id: doctorId, available_slots: availableSlots, taken_slots: takenSlots });
  } catch (err) { next(err); }
};

router.get('/slots', handleAvailableSlots);
router.get('/slots/:doctorId', handleAvailableSlots);

router.get('/doctor/:doctorId', async (req, res, next) => {
  try {
    const scopedDoctorId = await getScopedDoctorId(req, req.params.doctorId);
    if (!scopedDoctorId) return sendForbidden(res, 'Doctor profile is not linked to this user');
    const allowed = await canAccessDoctor(req, scopedDoctorId);
    if (!allowed) return sendForbidden(res);
    const { data, error } = await supabase.from('appointments').select('*, patients(*)').eq('doctor_id', scopedDoctorId).order('scheduled_at', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { next(err); }
});

router.get('/patient/:patientId', async (req, res, next) => {
  try {
    const scopedPatientId = await getScopedPatientId(req, req.params.patientId);
    if (!scopedPatientId) return sendForbidden(res);
    const { data, error } = await supabase.from('appointments').select('*, doctors(*)').eq('patient_id', scopedPatientId).order('scheduled_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { next(err); }
});

// POST create appointment
router.post('/', async (req, res, next) => {
  try {
    await loadAccessContext(req);
    if (hasAnyRole(req, ROLES.PATIENT) && req.user?.patientId) {
      req.body = { ...req.body, patient_id: req.user.patientId };
    }
    next();
  } catch (err) { next(err); }
}, validate(appointmentCreateSchema), async (req, res, next) => {
  try {
    if (hasAnyRole(req, ROLES.PATIENT)) {
      if (!req.user.patientId) return sendForbidden(res, 'Patient profile is not linked to this user');
      if (req.body?.patient_id && String(req.body.patient_id) !== String(req.user.patientId)) return sendForbidden(res);
    } else if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.N8N_AGENT)) {
      return sendForbidden(res);
    }

    const appointmentPayload = {
      patient_id: hasAnyRole(req, ROLES.PATIENT) ? req.user.patientId : req.body?.patient_id,
      doctor_id: req.body.doctor_id,
      scheduled_at: req.body.scheduled_at,
      status: req.body.status,
      booking_source: req.body.booking_source,
      notes: req.body.notes
    };

    const requiredFields = ['patient_id', 'doctor_id', 'scheduled_at', 'status'];
    const missingFields = requiredFields.filter((field) => !appointmentPayload[field]);
    if (missingFields.length) {
      return res.status(400).json({
        error: 'Validation failed',
        details: missingFields.map((field) => ({ field, message: `${field} is required` }))
      });
    }

    const { data: createdAppointment, error: insertError } = await supabase.from('appointments').insert(appointmentPayload).select('id').single();
    if (insertError) throw insertError;

    const { data, error } = await supabase.from('appointments').select('*, patients(*), doctors(*)').eq('id', createdAppointment.id).single();
    if (error) throw error;

    // Background sync — never crashes main request
    syncPatientBookingSnapshot(appointmentPayload.patient_id).catch((err) => console.error('Background sync error:', err));

    void fireWebhook('booking.complete', {
      appointment_id: data.id,
      patient_id: data.patient_id,
      doctor_id: data.doctor_id,
      scheduled_at: data.scheduled_at,
      status: data.status,
      booking_source: data.booking_source || appointmentPayload.booking_source || null
    });

    res.status(201).json(data);
  } catch (err) {
    console.error('Appointment creation failed:', err.message);
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.N8N_AGENT)) return sendForbidden(res);
    const { data: appointment, error: appointmentError } = await supabase.from('appointments').select('id, patient_id, status, scheduled_at').eq('id', req.params.id).maybeSingle();
    if (appointmentError) throw appointmentError;
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
    if (appointment.status === 'cancelled') return res.status(409).json({ error: 'Appointment is already cancelled' });
    const { error: updateError } = await supabase.from('appointments').update({ status: 'cancelled' }).eq('id', req.params.id);
    if (updateError) throw updateError;
    syncPatientBookingSnapshot(appointment.patient_id).catch((err) => console.error('Background sync error:', err));
    try {
      await fireWebhook('appointment.cancelled', { appointment_id: appointment.id, patient_id: appointment.patient_id });
    } catch (webhookErr) {
      console.error('Webhook failed (non-fatal):', webhookErr.message);
    }
    await logAudit({ userId: req.user?.id || null, role: req.user?.role || 'unknown', action: 'appointment_cancelled', resourceType: 'appointment', resourceId: appointment.id, oldValues: appointment, newValues: { status: 'cancelled' }, ipAddress: req.ip });
    return res.json({ success: true, appointment_id: appointment.id });
  } catch (err) { next(err); }
});

router.post('/:id/reschedule', validate(appointmentRescheduleSchema), async (req, res, next) => {
  try {
    const { scheduled_at: scheduledAt, reason, google_event_id: googleEventId } = req.body;
    const scoped = await getScopedAppointment(req, req.params.id, '*, patients(*), doctors(*)');
    if (scoped.notFound) return res.status(404).json({ error: 'Appointment not found', details: [] });
    const appointment = scoped.appointment;
    const doctorAllowed = hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.N8N_AGENT)
      || (hasAnyRole(req, ROLES.DOCTOR) && String(req.user?.doctorId) === String(appointment.doctor_id));
    if (!doctorAllowed) return sendForbidden(res);
    const slotAvailable = await ensureSlotAvailable({ appointmentId: appointment.id, doctorId: appointment.doctor_id, scheduledAt });
    if (!slotAvailable) return res.status(400).json({ error: 'Validation failed', details: [{ field: 'scheduled_at', message: 'Selected slot is no longer available' }] });
    const updatePayload = { scheduled_at: scheduledAt, cancellation_reason: reason || appointment.cancellation_reason || null, cancelled_at: null };
    if (googleEventId) updatePayload.google_event_id = googleEventId;
    const { data: updatedAppointment, error: updateError } = await supabase.from('appointments').update(updatePayload).eq('id', appointment.id).select('*, patients(*), doctors(*)').single();
    if (updateError) throw updateError;
    syncPatientBookingSnapshot(appointment.patient_id).catch((err) => console.error('Background sync error:', err));
    void fireWebhook('appointment.rescheduled', { appointment_id: appointment.id, patient_id: appointment.patient_id, doctor_id: appointment.doctor_id, scheduled_at: scheduledAt, reason: reason || null });
    await logAudit({ userId: req.user?.id || null, role: req.user?.role || 'unknown', action: 'appointment_rescheduled', resourceType: 'appointment', resourceId: appointment.id, oldValues: { scheduled_at: appointment.scheduled_at, google_event_id: appointment.google_event_id || null }, newValues: updatePayload, ipAddress: req.ip });
    return res.json(updatedAppointment);
  } catch (err) { next(err); }
});

router.patch('/:id/status', validate(appointmentStatusPatchSchema), async (req, res, next) => {
  try {
    const appointmentId = req.params.id;
    const { status } = req.body || {};
    if (!appointmentId) return res.status(400).json({ error: 'Appointment id is required', details: [] });
    if (!status || typeof status !== 'string') return res.status(400).json({ error: 'status is required', details: [] });
    if (!appointmentStatuses.includes(status)) return res.status(400).json({ error: `status must be one of: ${appointmentStatuses.join(', ')}`, details: [] });
    if (!hasAnyRole(req, doctorStatusUpdateRoles)) return sendForbidden(res);
    const scoped = await getScopedAppointment(req, appointmentId, 'id, patient_id, doctor_id');
    if (scoped.notFound) return res.status(404).json({ error: 'Appointment not found', details: [] });
    if (scoped.forbidden) return sendForbidden(res);
    const { data, error } = await supabase.from('appointments').update({ status }).eq('id', appointmentId).select('*, patients(full_name), doctors(full_name)').single();
    if (error) throw error;
    const timestampUpdates = {};
    if (status === 'completed') timestampUpdates.completed_at = new Date().toISOString();
    if (status === 'cancelled') timestampUpdates.cancelled_at = new Date().toISOString();
    if (Object.keys(timestampUpdates).length) {
      const { error: timestampError } = await supabase.from('appointments').update(timestampUpdates).eq('id', appointmentId);
      if (timestampError) throw timestampError;
      Object.assign(data, timestampUpdates);
    }
    res.json({ message: 'Appointment status updated successfully', appointment: formatAppointmentSummary(data) });
    if (status === 'completed' || status === 'cancelled') {
      void syncPatientBookingSnapshot(scoped.appointment.patient_id);
    }
  } catch (err) { next(err); }
});

router.patch('/:id/reminder-sent', validate(reminderSentSchema), async (req, res, next) => {
  try {
    const scoped = await getScopedAppointment(req, req.params.id, 'id, patient_id, doctor_id');
    if (scoped.notFound) return res.status(404).json({ error: 'Appointment not found', details: [] });
    if (scoped.forbidden) return sendForbidden(res);
    const { data, error } = await supabase.from('appointments').update({ reminder_sent_at: req.body.reminder_sent_at || new Date().toISOString() }).eq('id', req.params.id).select('*, patients(*), doctors(*)').single();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

router.patch('/:id', validate(appointmentPatchSchema), async (req, res, next) => {
  try {
    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR, ROLES.N8N_AGENT)) return sendForbidden(res);
    const scoped = await getScopedAppointment(req, req.params.id, 'id, patient_id, doctor_id');
    if (scoped.notFound) return res.status(404).json({ error: 'Appointment not found', details: [] });
    if (scoped.forbidden) return sendForbidden(res);
    const { payload, error: payloadError } = getAppointmentUpdatePayload(req.body, req.user.role);
    if (payloadError) return res.status(400).json({ error: payloadError, details: [] });
    if (!Object.keys(payload).length) return res.status(400).json({ error: 'No valid appointment fields provided', details: [] });
    const { data, error } = await supabase.from('appointments').update(payload).eq('id', req.params.id).select('*, patients(*), doctors(*)').single();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const scoped = await getScopedAppointment(req, req.params.id, '*, patients(*), doctors(*)');
    if (scoped.notFound) return res.status(404).json({ error: 'Appointment not found', details: [] });
    if (scoped.forbidden) return sendForbidden(res);
    res.json(scoped.appointment);
  } catch (err) { next(err); }
});

module.exports = router;