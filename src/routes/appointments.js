const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const authorizeRoles = require('../middleware/authorizeRoles');

const receptionistAccess = authorizeRoles('receptionist', 'admin');
const appointmentStatuses = ['pending', 'confirmed', 'completed', 'cancelled', 'no_show'];

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

const formatReceptionistAppointment = (appointment) => ({
  id: appointment.id,
  patient_id: appointment.patient_id,
  patient_name: appointment.patients?.full_name || null,
  doctor_id: appointment.doctor_id,
  doctor_name: appointment.doctors?.full_name || null,
  scheduled_at: appointment.scheduled_at,
  status: appointment.status,
  notes: appointment.notes || null
});

const hasReceptionistAccess = (req) => ['receptionist', 'admin'].includes(req.user?.role);

// GET all appointments with filters
router.get('/', async (req, res) => {
  try {
    const { date, doctor_id, status } = req.query;

    if (date) {
      if (!hasReceptionistAccess(req)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      if (!isValidDateInput(date)) {
        return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });
      }
    }

    let query = supabase
      .from('appointments')
      .select('*, patients(*), doctors(*)')
      .order('scheduled_at', { ascending: true });

    if (date) {
      const { start, end } = buildDayRange(date);
      query = query.gte('scheduled_at', start.toISOString()).lte('scheduled_at', end.toISOString());
    }
    if (doctor_id) query = query.eq('doctor_id', doctor_id);
    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    if (date) {
      return res.json((data || []).map(formatReceptionistAppointment));
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET available slots for a doctor on a date
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

    // Generate all slots
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

    // Get taken slots
    const start = new Date(date); start.setHours(0, 0, 0, 0);
    const end = new Date(date); end.setHours(23, 59, 59, 999);

    const { data: existing } = await supabase
      .from('appointments')
      .select('scheduled_at')
      .eq('doctor_id', req.params.doctorId)
      .gte('scheduled_at', start.toISOString())
      .lte('scheduled_at', end.toISOString())
      .not('status', 'eq', 'cancelled');

    const takenSlots = existing.map(a => {
      const d = new Date(a.scheduled_at);
      return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
    });

    const availableSlots = slots.filter(s => !takenSlots.includes(s));
    res.json({ date, doctor_id: req.params.doctorId, available_slots: availableSlots, taken_slots: takenSlots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET doctor's schedule
router.get('/doctor/:doctorId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select('*, patients(*)')
      .eq('doctor_id', req.params.doctorId)
      .order('scheduled_at', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET patient's appointments
router.get('/patient/:patientId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select('*, doctors(*)')
      .eq('patient_id', req.params.patientId)
      .order('scheduled_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single appointment
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select('*, patients(*), doctors(*)')
      .eq('id', req.params.id)
      .single();

    if (error) return res.status(404).json({ error: 'Appointment not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create appointment
router.post('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .insert(req.body)
      .select('*, patients(*), doctors(*)')
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update status
router.patch('/:id/status', receptionistAccess, async (req, res) => {
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

    const { data, error } = await supabase
      .from('appointments')
      .update({ status })
      .eq('id', appointmentId)
      .select('*, patients(full_name), doctors(full_name)')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Appointment not found' });
      }

      throw error;
    }

    res.json({
      message: 'Appointment status updated successfully',
      appointment: formatReceptionistAppointment(data)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
