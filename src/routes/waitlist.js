const express = require('express');
const { z } = require('zod');
const router = express.Router();
const supabase = require('../lib/supabase');
const validate = require('../middleware/validate');
const { waitlistCreateSchema, waitlistStatusPatchSchema, waitlistPatchSchema } = require('../lib/validators');
const {
  ROLES,
  hasAnyRole,
  sendForbidden,
  loadAccessContext,
  canAccessDoctor
} = require('../lib/access');
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(DEFAULT_PAGE),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT)
});

const getWaitlistEntry = async (waitlistId) => {
  const { data, error } = await supabase
    .from('waitlist')
    .select('id, doctor_id, status, offered_at')
    .eq('id', waitlistId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
};

// GET all active waitlist entries
router.get('/', async (req, res, next) => {
  try {
    const { doctor_id, doctorId, status, orderBy, order } = req.query;
    const { page, limit } = paginationSchema.parse(req.query);
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    const requestedDoctorId = doctor_id || doctorId;
    const sortColumn = orderBy === 'created_at' ? 'added_at' : 'added_at';
    const sortAscending = String(order || 'asc').toLowerCase() !== 'desc';
    await loadAccessContext(req);

    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR, ROLES.N8N_AGENT)) {
      return sendForbidden(res);
    }

    let query = supabase
      .from('waitlist')
      .select('*, patients(*), doctors(*)', { count: 'exact' })
      .order(sortColumn, { ascending: sortAscending });

    if (hasAnyRole(req, ROLES.DOCTOR)) {
      if (!req.user.doctorId) {
        return sendForbidden(res, 'Doctor profile is not linked to this user');
      }

      query = query.eq('doctor_id', req.user.doctorId);

      if (requestedDoctorId && String(requestedDoctorId) !== String(req.user.doctorId)) {
        return sendForbidden(res);
      }
    } else if (requestedDoctorId) {
      query = query.eq('doctor_id', requestedDoctorId);
    }

    if (status) query = query.eq('status', status);
    else query = query.eq('status', 'waiting');

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

// POST add to waitlist
router.post('/', validate(waitlistCreateSchema), async (req, res, next) => {
  try {
    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.N8N_AGENT)) {
      return sendForbidden(res);
    }

    const { data, error } = await supabase
      .from('waitlist')
      .insert(req.body)
      .select('*, patients(*), doctors(*)')
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

// PATCH update status
router.patch('/:id/status', validate(waitlistStatusPatchSchema), async (req, res, next) => {
  try {
    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR, ROLES.N8N_AGENT)) {
      return sendForbidden(res);
    }

    if (hasAnyRole(req, ROLES.DOCTOR)) {
      const currentEntry = await getWaitlistEntry(req.params.id);
      if (!currentEntry) {
        return res.status(404).json({ error: 'Waitlist entry not found', details: [] });
      }

      const allowed = await canAccessDoctor(req, currentEntry.doctor_id);
      if (!allowed) {
        return sendForbidden(res);
      }
    }

    const statusPayload = { status: req.body.status };
    if (req.body.status === 'offered') {
      statusPayload.offered_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('waitlist')
      .update(statusPayload)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', validate(waitlistPatchSchema), async (req, res, next) => {
  try {
    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR, ROLES.N8N_AGENT)) {
      return sendForbidden(res);
    }

    const currentEntry = await getWaitlistEntry(req.params.id);
    if (!currentEntry) {
      return res.status(404).json({ error: 'Waitlist entry not found', details: [] });
    }

    if (hasAnyRole(req, ROLES.DOCTOR)) {
      const allowed = await canAccessDoctor(req, currentEntry.doctor_id);
      if (!allowed) {
        return sendForbidden(res);
      }
    }

    const updatePayload = { ...req.body };
    if (updatePayload.status === 'offered' && !updatePayload.offered_at) {
      updatePayload.offered_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('waitlist')
      .update(updatePayload)
      .eq('id', req.params.id)
      .select('*, patients(*), doctors(*)')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
