const express = require('express');
const { z } = require('zod');
const router = express.Router();
const supabase = require('../lib/supabase');
const validate = require('../middleware/validate');
const { waitlistCreateSchema, waitlistStatusPatchSchema } = require('../lib/validators');
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

// GET all active waitlist entries
router.get('/', async (req, res, next) => {
  try {
    const { doctor_id, status } = req.query;
    const { page, limit } = paginationSchema.parse(req.query);
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    await loadAccessContext(req);

    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR)) {
      return sendForbidden(res);
    }

    let query = supabase
      .from('waitlist')
      .select('*, patients(*), doctors(*)', { count: 'exact' })
      .order('added_at', { ascending: true });

    if (hasAnyRole(req, ROLES.DOCTOR)) {
      if (!req.user.doctorId) {
        return sendForbidden(res, 'Doctor profile is not linked to this user');
      }

      query = query.eq('doctor_id', req.user.doctorId);

      if (doctor_id && String(doctor_id) !== String(req.user.doctorId)) {
        return sendForbidden(res);
      }
    } else if (doctor_id) {
      query = query.eq('doctor_id', doctor_id);
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
    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST)) {
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
    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR)) {
      return sendForbidden(res);
    }

    if (hasAnyRole(req, ROLES.DOCTOR)) {
      const { data: currentEntry, error: currentEntryError } = await supabase
        .from('waitlist')
        .select('id, doctor_id')
        .eq('id', req.params.id)
        .maybeSingle();

      if (currentEntryError) throw currentEntryError;
      if (!currentEntry) {
        return res.status(404).json({ error: 'Waitlist entry not found', details: [] });
      }

      const allowed = await canAccessDoctor(req, currentEntry.doctor_id);
      if (!allowed) {
        return sendForbidden(res);
      }
    }

    const { data, error } = await supabase
      .from('waitlist')
      .update({ status: req.body.status })
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
