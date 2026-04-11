const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
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

const appointmentStatuses = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];
const doctorStatusUpdateRoles = [ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR];

const isValidDateInput = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
};

const buildDayRange = (dateString) => {
  const start = new Date(`${dateString}T00:00:00.000Z`);
  const end = new Date(`${dateString}T23:59:59.999Z`);
  return { start, end };
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

  if (!appointment) {
    return { notFound: true };
  }

  const allowed = await canAccessAppointment(req, appointment);
  if (!allowed) {
    return { forbidden: true };
  }

  return { appointment };
};

const getAppointmentUpdatePayload = (body = {}, role) => {
  const allowedFieldsByRole = {
    [ROLES.ADMIN]: ['doctor_id', 'patient_id', 'scheduled_at', 'status', 'notes', 'reminder_sent_at'],
    [ROLES.RECEPTIONIST]: ['doctor_id', 'patient_id', 'scheduled_at', 'status', 'notes', 'reminder_sent_at'],
    [ROLES.DOCTOR]: ['status', 'notes', 'reminder_sent_at']
  };

  const allowedFields = allowedFieldsByRole[role] || [];
  const payload = Object.fromEntries(
    Object.entries(body).filter(([key]) => allowedFields.includes(key))
  );

  if (payload.status && !appointmentStatuses.includes(payload.status)) {
    return { error: `status must be one of: ${appointmentStatuses.join(', ')}` };
  }

  return { payload };
};

// GET all appointments with filters
router.get('/', async (req, res) => {
  try {
    const { date, doctor_id, status, from, to } = req.query;

    if (date && !isValidDateInput(date)) {
      return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });
    }

    await loadAccessContext(req);

    let query = supabase
      .from('appointments')
      .select('*, patients(*), doctors(*)')
      .order('scheduled_at', { ascending: true });

    if (hasAnyRole(req, ROLES.DOCTOR)) {
      if (!req.user.doctorId) {
        return sendForbidden(res, 'Doctor profile is not linked to this user');
      }

      query = query.eq('doctor_id', req.user.doctorId);
    } else if (hasAnyRole(req, ROLES.PATIENT)) {
      if (!req.user.patientId) {
        return sendForbidden(res, 'Patient profile is not linked to this user');
      }

      query = query.eq('patient_id', req.user.patientId);

      if (doctor_id) {
        query = query.eq('doctor_id', doctor_id);
      }
    } else if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST)) {
      return sendForbidden(res);
    }

    if (date) {
      const { start, end } = buildDayRange(date);
      query = query.gte('scheduled_at', start.toISOString()).lte('scheduled_at', end.toISOString());
    }

    if (from) {
      query = query.gte('scheduled_at', from);
    }

    if (to) {
      query = query.lte('scheduled_at', to);
    }

    if (doctor_id && !hasAnyRole(req, ROLES.DOCTOR, ROLES.PATIENT)) {
      query = query.eq('doctor_id', doctor_id);
    }

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;

    if (date && hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST)) {
      return res.json((data || []).map(formatAppointmentSummary));
    }

    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET available slots for aa doctor on a date
router.get('/slots/:doctorId', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date query param required' });

    const { data: doctor, error: docError } = await supabase
      .from('doctors')
      .select('*')
      .eq('id', req.params.doctorId)
      .single();

    if (docError) return res.status(404).json({ error: 'Doctor not found' });

    const dayName = new Date(date).toLocaleDateString('en-US', { weekday: 'short' });
    if (!doctor.working_days.includes(dayName)) {
      return res.json({ date, doctor_id: req.params.doctorId, available_slots: [], taken_slots: [] });
    }

    const slots = [];
    const [startH, startM] = doctor.start_time.split(':').map(Number);
    const [endH, endM] = doctor.end_time.split(':').map(Number);
    let current = startH * 60 + startM;
    const endTotal = endH * 60 + endM;

    while (current < endTotal) {
      const h = Math.floor(current / 60).toString().padStart(2, '0');
      const m = (current % 60).toString().padStart(2, '0');
      slots.push(`${h}:${m}`);
      current += doctor.slot_duration_mins;
    }

    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    const { data: existing, error: existingError } = await supabase
      .from('appointments')
      .select('scheduled_at')
      .eq('doctor_id', req.params.doctorId)
      .gte('scheduled_at', start.toISOString())
      .lte('scheduled_at', end.toISOString())
      .not('status', 'eq', 'cancelled');

    if (existingError) {
      throw existingError;
    }

    const takenSlots = (existing || []).map((appointment) => {
      const scheduledDate = new Date(appointment.scheduled_at);
      return `${scheduledDate.getHours().toString().padStart(2, '0')}:${scheduledDate.getMinutes().toString().padStart(2, '0')}`;
    });

    const availableSlots = slots.filter((slot) => !takenSlots.includes(slot));
    res.json({ date, doctor_id: req.params.doctorId, available_slots: availableSlots, taken_slots: takenSlots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET doctor's schedule
router.get('/doctor/:doctorId', async (req, res) => {
  try {
    const scopedDoctorId = await getScopedDoctorId(req, req.params.doctorId);
    if (!scopedDoctorId) {
      return sendForbidden(res, 'Doctor profile is not linked to this user');
    }

    const allowed = await canAccessDoctor(req, scopedDoctorId);
    if (!allowed) {
      return sendForbidden(res);
    }

    const { data, error } = await supabase
      .from('appointments')
      .select('*, patients(*)')
      .eq('doctor_id', scopedDoctorId)
      .order('scheduled_at', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET patient's appointments
router.get('/patient/:patientId', async (req, res) => {
  try {
    const scopedPatientId = await getScopedPatientId(req, req.params.patientId);
    if (!scopedPatientId) {
      return sendForbidden(res);
    }

    const { data, error } = await supabase
      .from('appointments')
      .select('*, doctors(*)')
      .eq('patient_id', scopedPatientId)
      .order('scheduled_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create appointment
router.post('/', async (req, res) => {
  try {
    await loadAccessContext(req);

    if (hasAnyRole(req, ROLES.PATIENT)) {
      if (!req.user.patientId) {
        return sendForbidden(res, 'Patient profile is not linked to this user');
      }

      if (req.body?.patient_id && String(req.body.patient_id) !== String(req.user.patientId)) {
        return sendForbidden(res);
      }
    } else if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST)) {
      return sendForbidden(res);
    }

    const payload = {
      ...req.body,
      patient_id: hasAnyRole(req, ROLES.PATIENT) ? req.user.patientId : req.body?.patient_id
    };

    const { data, error } = await supabase
      .from('appointments')
      .insert(payload)
      .select('*, patients(*), doctors(*)')
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update status
router.patch('/:id/status', async (req, res) => {
  try {
    const appointmentId = req.params.id;
    const { status } = req.body || {};

    if (!appointmentId) {
      return res.status(400).json({ error: 'Appointment id is required' });
    }

    if (!status || typeof status !== 'string') {
      return res.status(400).json({ error: 'status is required' });
    }

    if (!appointmentStatuses.includes(status)) {
      return res.status(400).json({
        error: `status must be one of: ${appointmentStatuses.join(', ')}`
      });
    }

    if (!hasAnyRole(req, doctorStatusUpdateRoles)) {
      return sendForbidden(res);
    }

    const scoped = await getScopedAppointment(req, appointmentId, 'id, patient_id, doctor_id');
    if (scoped.notFound) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    if (scoped.forbidden) {
      return sendForbidden(res);
    }

    const { data, error } = await supabase
      .from('appointments')
      .update({ status })
      .eq('id', appointmentId)
      .select('*, patients(full_name), doctors(full_name)')
      .single();

    if (error) throw error;

    res.json({
      message: 'Appointment status updated successfully',
      appointment: formatAppointmentSummary(data)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH mark reminder as sent
router.patch('/:id/reminder-sent', async (req, res) => {
  try {
    const scoped = await getScopedAppointment(req, req.params.id, 'id, patient_id, doctor_id');
    if (scoped.notFound) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    if (scoped.forbidden) {
      return sendForbidden(res);
    }

    const { data, error } = await supabase
      .from('appointments')
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('*, patients(*), doctors(*)')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update appointment
router.patch('/:id', async (req, res) => {
  try {
    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR)) {
      return sendForbidden(res);
    }

    const scoped = await getScopedAppointment(req, req.params.id, 'id, patient_id, doctor_id');
    if (scoped.notFound) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    if (scoped.forbidden) {
      return sendForbidden(res);
    }

    const { payload, error: payloadError } = getAppointmentUpdatePayload(req.body, req.user.role);
    if (payloadError) {
      return res.status(400).json({ error: payloadError });
    }

    if (!Object.keys(payload).length) {
      return res.status(400).json({ error: 'No valid appointment fields provided' });
    }

    const { data, error } = await supabase
      .from('appointments')
      .update(payload)
      .eq('id', req.params.id)
      .select('*, patients(*), doctors(*)')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single appointment
router.get('/:id', async (req, res) => {
  try {
    const scoped = await getScopedAppointment(req, req.params.id, '*, patients(*), doctors(*)');
    if (scoped.notFound) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    if (scoped.forbidden) {
      return sendForbidden(res);
    }

    res.json(scoped.appointment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
