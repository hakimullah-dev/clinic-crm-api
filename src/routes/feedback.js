const express = require('express');
const { z } = require('zod');
const router = express.Router();
const supabase = require('../lib/supabase');
const validate = require('../middleware/validate');
const { feedbackCreateSchema } = require('../lib/validators');
const {
  ROLES,
  hasAnyRole,
  sendForbidden,
  loadAccessContext,
  getAppointmentById,
  canAccessAppointment
} = require('../lib/access');
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(DEFAULT_PAGE),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT)
});

const emptyBodySchema = z.object({}).strict();

// POST submit feedback (triggered by n8n post-visit agent)
router.post('/', validate(feedbackCreateSchema), async (req, res, next) => {
  try {
    const appointment = await getAppointmentById(req.body.appointment_id, 'id, doctor_id, patient_id');
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found', details: [] });
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
    next(err);
  }
});

// GET all feedback with filters
router.get('/', async (req, res, next) => {
  try {
    const { doctor_id, min_rating, max_rating } = req.query;
    const { page, limit } = paginationSchema.parse(req.query);
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    await loadAccessContext(req);

    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR)) {
      return sendForbidden(res);
    }

    let query = supabase
      .from('feedback')
      .select('*, appointments(*, patients(*), doctors(*))', { count: 'exact' })
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

    const { data, error, count } = await query.range(from, to);
    if (error) throw error;
    res.json({
      data: data || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        pages: count ? Math.ceil(count / limit) : 0
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET feedback by appointment ID
router.get('/appointment/:appointmentId', async (req, res, next) => {
  try {
    const appointment = await getAppointmentById(req.params.appointmentId, 'id, doctor_id, patient_id');
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found', details: [] });
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

    if (error) return res.status(404).json({ error: 'Feedback not found', details: [] });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET average rating per doctor (admin dashboard)
router.get('/stats/doctors', async (req, res, next) => {
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
    next(err);
  }
});

// PATCH flag low rating (n8n alert agent)
router.patch('/:id/flag', validate(emptyBodySchema), async (req, res, next) => {
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
    next(err);
  }
});

module.exports = router;
