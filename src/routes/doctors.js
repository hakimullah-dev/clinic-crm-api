const express = require('express');
const { z } = require('zod');
const router = express.Router();
const publicRouter = express.Router();
const supabase = require('../lib/supabase');
const validate = require('../middleware/validate');
const { doctorCreateSchema, doctorPatchSchema } = require('../lib/validators');
const {
  ROLES,
  hasAnyRole,
  sendForbidden,
  canAccessDoctor,
  getScopedDoctorId
} = require('../lib/access');
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(DEFAULT_PAGE),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT)
});

const toDoctorPublicSummary = (doctor) => ({
  id: doctor.id,
  name: doctor.name || doctor.full_name || null,
  specialization: doctor.specialization || doctor.specialty || null,
  bio: doctor.bio || null,
  photo_url: doctor.photo_url || null,
  consultation_duration_mins: doctor.consultation_duration_mins || doctor.slot_duration_mins || 30,
  accepting_patients: typeof doctor.accepting_patients === 'boolean' ? doctor.accepting_patients : true
});

const toDoctorPublicDetail = (doctor) => ({
  ...toDoctorPublicSummary(doctor),
  working_hours: doctor.working_hours || null
});

publicRouter.get('/public', async (req, res, next) => {
  try {
    const { specialization, accepting_patients } = req.query;

    let query = supabase
      .from('doctors')
      .select('*')
      .eq('is_active', true)
      .order('full_name', { ascending: true });

    if (specialization) {
      query = query.or(`specialization.ilike.%${specialization}%,specialty.ilike.%${specialization}%`);
    }

    if (accepting_patients === 'true') {
      query = query.eq('accepting_patients', true);
    } else if (accepting_patients === 'false') {
      query = query.eq('accepting_patients', false);
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.json({
      success: true,
      data: (data || []).map(toDoctorPublicSummary)
    });
  } catch (err) {
    next(err);
  }
});

publicRouter.get('/public/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('doctors')
      .select('*')
      .eq('id', req.params.id)
      .eq('is_active', true)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: 'Doctor not found' });
    }

    return res.json({
      success: true,
      data: toDoctorPublicDetail(data)
    });
  } catch (err) {
    next(err);
  }
});

// GET all active doctors
router.get('/', async (req, res, next) => {
  try {
    const { page, limit } = paginationSchema.parse(req.query);
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data, error, count } = await supabase
      .from('doctors')
      .select('*', { count: 'exact' })
      .eq('is_active', true)
      .order('full_name', { ascending: true })
      .range(from, to);

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

// GET single doctor
router.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('doctors')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) return res.status(404).json({ error: 'Doctor not found' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST create doctor (admin only)
router.post('/', validate(doctorCreateSchema), async (req, res, next) => {
  let authUserId = null;
  let profileCreated = false;

  try {
    if (!hasAnyRole(req, ROLES.ADMIN)) {
      return sendForbidden(res);
    }

    const { password, ...doctorData } = req.body;
    const resolvedPassword = password;

    if (!doctorData.email) {
      return res.status(400).json({ error: 'Email is required for doctor accounts' });
    }

    if (!resolvedPassword) {
      return res.status(400).json({ error: 'Password is required for doctor accounts' });
    }

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: doctorData.email,
      password: resolvedPassword,
      email_confirm: true,
      user_metadata: { full_name: doctorData.full_name }
    });

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    const authUser = authData.user;
    if (!authUser) {
      return res.status(400).json({ error: 'Unable to create doctor user' });
    }

    authUserId = authUser.id;

    const { error: profileError } = await supabase
      .from('user_profiles')
      .insert({
        user_id: authUser.id,
        role: 'doctor'
      });

    if (profileError) {
      await supabase.auth.admin.deleteUser(authUser.id);
      authUserId = null;
      return res.status(400).json({ error: profileError.message });
    }
    profileCreated = true;

    const { data, error } = await supabase
      .from('doctors')
      .insert({
        ...doctorData,
        user_id: authUser.id
      })
      .select()
      .single();

    if (error) {
      if (profileCreated) {
        await supabase.from('user_profiles').delete().eq('user_id', authUser.id);
        profileCreated = false;
      }
      await supabase.auth.admin.deleteUser(authUser.id);
      authUserId = null;
      throw error;
    }

    res.status(201).json(data);
  } catch (err) {
    if (authUserId) {
      if (profileCreated) {
        await supabase.from('user_profiles').delete().eq('user_id', authUserId);
      }
      await supabase.auth.admin.deleteUser(authUserId);
    }
    next(err);
  }
});

// PATCH update doctor
router.patch('/:id', validate(doctorPatchSchema), async (req, res, next) => {
  try {
    const allowed = await canAccessDoctor(req, req.params.id);
    if (!allowed && !hasAnyRole(req, ROLES.ADMIN)) {
      return sendForbidden(res);
    }

    const scopedDoctorId = await getScopedDoctorId(req, req.params.id);
    if (!scopedDoctorId) {
      return sendForbidden(res, 'Doctor profile is not linked to this user');
    }

    const {
      full_name,
      email,
      specialty,
      specialization,
      working_days,
      start_time,
      end_time,
      slot_duration_mins,
      consultation_duration_mins,
      accepting_patients
    } = req.body;

    const doctorData = {};
    if (full_name !== undefined) doctorData.full_name = full_name;
    if (email !== undefined) doctorData.email = email;
    if (specialty !== undefined) doctorData.specialty = specialty;
    if (specialization !== undefined) doctorData.specialization = specialization;
    if (working_days !== undefined) {
      doctorData.working_days = Array.isArray(working_days)
        ? working_days.map((day) => String(day).toLowerCase())
        : working_days;
    }
    if (start_time !== undefined) doctorData.start_time = start_time;
    if (end_time !== undefined) doctorData.end_time = end_time;
    if (slot_duration_mins !== undefined) doctorData.slot_duration_mins = slot_duration_mins;
    if (consultation_duration_mins !== undefined) doctorData.consultation_duration_mins = consultation_duration_mins;
    if (accepting_patients !== undefined) doctorData.accepting_patients = accepting_patients;

    if (Object.keys(doctorData).length === 0) {
      return res.status(400).json({ error: 'No valid doctor fields provided' });
    }

    doctorData.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('doctors')
      .update(doctorData)
      .eq('id', scopedDoctorId)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = {
  router,
  publicRouter
};
