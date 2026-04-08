const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const {
  ROLES,
  hasAnyRole,
  sendForbidden,
  loadAccessContext,
  getAppointmentById,
  canAccessAppointment
} = require('../lib/access');

// POST submit feedback (triggered by n8n post-visit agent)
router.post('/', async (req, res) => {
  try {
    if (!req.body?.appointment_id) {
      return res.status(400).json({ error: 'appointment_id is required' });
    }

    const appointment = await getAppointmentById(req.body.appointment_id, 'id, doctor_id, patient_id');
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    const allowed = await canAccessAppointment(req, appointment);
    if (!allowed && !hasAnyRole(req, ROLES.N8N_AGENT)) {
      return sendForbidden(res);
    }

    const { data, error } = await supabase
      .from('feedback')
      .insert(req.body)
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all feedback with filters
router.get('/', async (req, res) => {
  try {
    const { doctor_id, min_rating, max_rating } = req.query;
    await loadAccessContext(req);

    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR)) {
      return sendForbidden(res);
    }

    let query = supabase
      .from('feedback')
      .select('*, appointments(*, patients(*), doctors(*))')
      .order('submitted_at', { ascending: false });

    if (hasAnyRole(req, ROLES.DOCTOR)) {
      if (!req.user.doctorId) {
        return sendForbidden(res, 'Doctor profile is not linked to this user');
      }

      query = query.eq('appointments.doctor_id', req.user.doctorId);

      if (doctor_id && String(doctor_id) !== String(req.user.doctorId)) {
        return sendForbidden(res);
      }
    } else if (doctor_id) {
      query = query.eq('appointments.doctor_id', doctor_id);
    }

    if (min_rating) query = query.gte('rating', Number(min_rating));
    if (max_rating) query = query.lte('rating', Number(max_rating));

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET feedback by appointment ID
router.get('/appointment/:appointmentId', async (req, res) => {
  try {
    const appointment = await getAppointmentById(req.params.appointmentId, 'id, doctor_id, patient_id');
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    const allowed = await canAccessAppointment(req, appointment);
    if (!allowed) {
      return sendForbidden(res);
    }

    const { data, error } = await supabase
      .from('feedback')
      .select('*')
      .eq('appointment_id', req.params.appointmentId)
      .single();

    if (error) return res.status(404).json({ error: 'Feedback not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET average rating per doctor (admin dashboard)
router.get('/stats/doctors', async (req, res) => {
  try {
    if (!hasAnyRole(req, ROLES.ADMIN)) {
      return sendForbidden(res);
    }

    const { data, error } = await supabase
      .from('feedback')
      .select('rating, appointments(doctor_id, doctors(full_name))');

    if (error) throw error;

    const stats = {};
    data.forEach(f => {
      const doctor = f.appointments?.doctors;
      if (!doctor) return;
      const name = doctor.full_name;
      if (!stats[name]) stats[name] = { total: 0, count: 0 };
      stats[name].total += f.rating;
      stats[name].count += 1;
    });

    const result = Object.entries(stats).map(([name, s]) => ({
      doctor_name: name,
      average_rating: (s.total / s.count).toFixed(1),
      total_reviews: s.count
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH flag low rating (n8n alert agent)
router.patch('/:id/flag', async (req, res) => {
  try {
    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.N8N_AGENT)) {
      return sendForbidden(res);
    }

    const { data, error } = await supabase
      .from('feedback')
      .update({ flagged_for_review: true })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
