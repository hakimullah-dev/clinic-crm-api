const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const {
  ROLES,
  hasAnyRole,
  sendForbidden
} = require('../lib/access');

// GET daily summary (n8n daily ops agent + admin dashboard)
router.get('/daily', async (req, res) => {
  try {
    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.N8N_AGENT)) {
      return sendForbidden(res);
    }

    const { date } = req.query;
    const target = date ? new Date(date) : new Date();

    const start = new Date(target);
    start.setHours(0, 0, 0, 0);
    const end = new Date(target);
    end.setHours(23, 59, 59, 999);

    const [appointments, feedback, waitlist] = await Promise.all([
      supabase
        .from('appointments')
        .select('status, doctor_id, doctors(full_name)')
        .gte('scheduled_at', start.toISOString())
        .lte('scheduled_at', end.toISOString()),

      supabase
        .from('feedback')
        .select('rating')
        .gte('submitted_at', start.toISOString())
        .lte('submitted_at', end.toISOString()),

      supabase
        .from('waitlist')
        .select('id')
        .eq('status', 'waiting')
    ]);

    const appts = appointments.data || [];
    const fb = feedback.data || [];
    const wl = waitlist.data || [];

    const statusCounts = appts.reduce((acc, a) => {
      acc[a.status] = (acc[a.status] || 0) + 1;
      return acc;
    }, {});

    const avgRating = fb.length
      ? (fb.reduce((sum, f) => sum + f.rating, 0) / fb.length).toFixed(1)
      : null;

    res.json({
      date: target.toISOString().split('T')[0],
      appointments: {
        total: appts.length,
        confirmed: statusCounts.confirmed || 0,
        completed: statusCounts.completed || 0,
        cancelled: statusCounts.cancelled || 0,
        no_show: statusCounts.no_show || 0
      },
      feedback: {
        total_reviews: fb.length,
        average_rating: avgRating
      },
      waitlist: {
        active: wl.length
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET appointments per doctor (admin view)
router.get('/doctors', async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

// GET no-show rate (n8n reminder agent uses this)
router.get('/no-show-rate', async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

// GET upcoming appointments for next N hours (n8n reminder trigger)
router.get('/upcoming', async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
