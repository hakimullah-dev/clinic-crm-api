const express = require('express');
const { z } = require('zod');
const router = express.Router();
const supabase = require('../lib/supabase');
const {
  ROLES,
  hasAnyRole,
  sendForbidden
} = require('../lib/access');

const summaryCache = new Map();
const SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000;
const summaryQuerySchema = z.object({
  date: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional()
});

const getRangeBounds = (query = {}) => {
  const parsed = summaryQuerySchema.parse(query);

  if (parsed.date && (parsed.from || parsed.to)) {
    throw Object.assign(new Error('Use either date or from/to range, not both'), { status: 400 });
  }

  if (parsed.date) {
    const target = parsed.date === 'TODAY' ? new Date() : new Date(parsed.date);
    if (Number.isNaN(target.getTime())) {
      throw Object.assign(new Error('date must be a valid ISO date or TODAY'), { status: 400 });
    }

    const start = new Date(target);
    start.setHours(0, 0, 0, 0);
    const end = new Date(target);
    end.setHours(23, 59, 59, 999);

    return {
      cacheKey: `date:${start.toISOString()}`,
      start,
      end
    };
  }

  const start = parsed.from ? new Date(parsed.from) : new Date();
  const end = parsed.to ? new Date(parsed.to) : new Date(start);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw Object.assign(new Error('from and to must be valid ISO dates'), { status: 400 });
  }

  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);

  if (start > end) {
    throw Object.assign(new Error('from must be before or equal to to'), { status: 400 });
  }

  return {
    cacheKey: `range:${start.toISOString()}:${end.toISOString()}`,
    start,
    end
  };
};

const getCachedSummary = (cacheKey) => {
  const cached = summaryCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt < Date.now()) {
    summaryCache.delete(cacheKey);
    return null;
  }

  return cached.payload;
};

const setCachedSummary = (cacheKey, payload) => {
  summaryCache.set(cacheKey, {
    payload,
    expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS
  });
};

const buildSummaryPayload = (appointmentsData, feedbackData, patientData, start, end) => {
  const appointments = appointmentsData || [];
  const feedback = feedbackData || [];
  const patients = patientData || [];

  const statusCounts = appointments.reduce((accumulator, appointment) => {
    accumulator[appointment.status] = (accumulator[appointment.status] || 0) + 1;
    return accumulator;
  }, {});

  const completedAppointments = appointments.filter((appointment) => appointment.status === 'completed');
  const uniquePatientIds = new Set(completedAppointments.map((appointment) => appointment.patient_id).filter(Boolean));

  const patientVisitMap = new Map((patients || []).map((patient) => [patient.id, patient.visit_count || 0]));
  let newPatients = 0;
  let returningPatients = 0;

  uniquePatientIds.forEach((patientId) => {
    const visits = patientVisitMap.get(patientId) || 0;
    if (visits <= 1) {
      newPatients += 1;
    } else {
      returningPatients += 1;
    }
  });

  const avgRating = feedback.length
    ? Number((feedback.reduce((sum, item) => sum + item.rating, 0) / feedback.length).toFixed(1))
    : null;

  const noShowRate = appointments.length
    ? Number((((statusCounts.no_show || 0) / appointments.length) * 100).toFixed(1))
    : 0;

  return {
    from: start.toISOString(),
    to: end.toISOString(),
    total_bookings: appointments.length,
    confirmed: statusCounts.confirmed || 0,
    cancelled: statusCounts.cancelled || 0,
    completed: statusCounts.completed || 0,
    no_shows: statusCounts.no_show || 0,
    no_show_rate: noShowRate,
    new_patients: newPatients,
    returning_patients: returningPatients,
    avg_rating: avgRating,
    revenue_estimate: appointments.length * 200
  };
};

const handleSummary = async (req, res, next) => {
  try {
    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.N8N_AGENT)) {
      return sendForbidden(res);
    }

    const { cacheKey, start, end } = getRangeBounds(req.query);
    const cached = getCachedSummary(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const [appointments, feedback, patients] = await Promise.all([
      supabase
        .from('appointments')
        .select('status, patient_id')
        .gte('scheduled_at', start.toISOString())
        .lte('scheduled_at', end.toISOString()),

      supabase
        .from('feedback')
        .select('rating')
        .gte('submitted_at', start.toISOString())
        .lte('submitted_at', end.toISOString()),

      supabase
        .from('patients')
        .select('id, visit_count')
    ]);

    if (appointments.error) throw appointments.error;
    if (feedback.error) throw feedback.error;
    if (patients.error) throw patients.error;

    const payload = buildSummaryPayload(
      appointments.data,
      feedback.data,
      patients.data,
      start,
      end
    );

    setCachedSummary(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    next(err);
  }
};

router.get('/summary', handleSummary);
router.get('/daily', handleSummary);

// GET appointments per doctor (admin view)
router.get('/doctors', async (req, res, next) => {
  try {
    if (!hasAnyRole(req, ROLES.ADMIN)) {
      return sendForbidden(res);
    }

    const { from, to } = req.query;

    let query = supabase
      .from('appointments')
      .select('doctor_id, status, doctors(full_name, specialty)');

    if (from) query = query.gte('scheduled_at', new Date(from).toISOString());
    if (to) query = query.lte('scheduled_at', new Date(to).toISOString());

    const { data, error } = await query;
    if (error) throw error;

    const stats = {};
    (data || []).forEach(a => {
      const name = a.doctors?.full_name || a.doctor_id;
      if (!stats[name]) {
        stats[name] = {
          doctor_name: name,
          specialty: a.doctors?.specialty || '',
          total: 0, completed: 0, cancelled: 0, no_show: 0
        };
      }
      stats[name].total += 1;
      if (a.status === 'completed') stats[name].completed += 1;
      if (a.status === 'cancelled') stats[name].cancelled += 1;
      if (a.status === 'no_show') stats[name].no_show += 1;
    });

    res.json(Object.values(stats));
  } catch (err) {
    next(err);
  }
});

// GET no-show rate (n8n reminder agent uses this)
router.get('/no-show-rate', async (req, res, next) => {
  try {
    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.N8N_AGENT)) {
      return sendForbidden(res);
    }

    const { days = 30 } = req.query;
    const from = new Date();
    from.setDate(from.getDate() - Number(days));

    const { data, error } = await supabase
      .from('appointments')
      .select('status')
      .gte('scheduled_at', from.toISOString())
      .in('status', ['completed', 'no_show']);

    if (error) throw error;

    const total = data.length;
    const noShows = data.filter(a => a.status === 'no_show').length;
    const rate = total ? ((noShows / total) * 100).toFixed(1) : '0.0';

    res.json({
      period_days: Number(days),
      total_appointments: total,
      no_shows: noShows,
      no_show_rate_percent: rate
    });
  } catch (err) {
    next(err);
  }
});

// GET upcoming appointments for next N hours (n8n reminder trigger)
router.get('/upcoming', async (req, res, next) => {
  try {
    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.N8N_AGENT)) {
      return sendForbidden(res);
    }

    const { hours = 24 } = req.query;
    const now = new Date();
    const until = new Date(now.getTime() + Number(hours) * 60 * 60 * 1000);

    const { data, error } = await supabase
      .from('appointments')
      .select('*, patients(full_name, phone, email), doctors(full_name)')
      .eq('status', 'confirmed')
      .is('reminder_sent_at', null)
      .gte('scheduled_at', now.toISOString())
      .lte('scheduled_at', until.toISOString())
      .order('scheduled_at', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
