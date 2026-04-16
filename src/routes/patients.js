const express = require('express');
const { z } = require('zod');
const router = express.Router();
const supabase = require('../lib/supabase');
const validate = require('../middleware/validate');
const { patientCreateSchema, patientPatchSchema } = require('../lib/validators');
const {
  ROLES,
  hasAnyRole,
  sendForbidden,
  loadAccessContext,
  canAccessPatient
} = require('../lib/access');
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(DEFAULT_PAGE),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT)
});

const getPagination = (query = {}) => {
  const { page, limit } = paginationSchema.parse(query);
  const from = (page - 1) * limit;
  const to = from + limit - 1;
  return { page, limit, from, to };
};

const buildPaginationMeta = (page, limit, total) => ({
  page,
  limit,
  total,
  pages: total === 0 ? 0 : Math.ceil(total / limit)
});

const sanitizePatientPayload = (payload = {}) => {
  const { password, temporary_password, ...patientData } = payload;
  return {
    patientData,
    resolvedPassword: password || temporary_password || null
  };
};

// GET all patients with search
router.get('/', async (req, res, next) => {
  try {
    const { search } = req.query;
    const { page, limit, from, to } = getPagination(req.query);
    await loadAccessContext(req);

    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR)) {
      return sendForbidden(res);
    }

    let query = supabase
      .from('patients')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (hasAnyRole(req, ROLES.DOCTOR)) {
      if (!req.user.doctorId) {
        return sendForbidden(res, 'Doctor profile is not linked to this user');
      }
      const { data: appointments, error: appointmentError } = await supabase
        .from('appointments')
        .select('patient_id')
        .eq('doctor_id', req.user.doctorId);
      if (appointmentError) throw appointmentError;
      const patientIds = [...new Set((appointments || []).map((a) => a.patient_id).filter(Boolean))];
      if (!patientIds.length) return res.json({ data: [], pagination: buildPaginationMeta(page, limit, 0) });
      query = query.in('id', patientIds);
    }

    if (search) {
      query = query.or(`full_name.ilike.%${search}%,phone.ilike.%${search}%`);
    }

    const { data, error, count } = await query.range(from, to);
    if (error) throw error;
    res.json({
      data: data || [],
      pagination: buildPaginationMeta(page, limit, count || 0)
    });
  } catch (err) {
    next(err);
  }
});

// GET patient by phone (Aria uses this)
router.get('/phone/:phone', async (req, res, next) => {
  try {
    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.N8N_AGENT)) {
      return sendForbidden(res);
    }
    const { data, error } = await supabase
      .from('patients')
      .select('*')
      .eq('phone', req.params.phone)
      .single();
    if (error) return res.status(404).json({ error: 'Patient not found' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET single patient by ID
router.get('/:id', async (req, res, next) => {
  try {
    const allowed = await canAccessPatient(req, req.params.id);
    if (!allowed) return sendForbidden(res);
    const { data, error } = await supabase
      .from('patients')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) return res.status(404).json({ error: 'Patient not found' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST create patient
router.post('/', validate(patientCreateSchema), async (req, res, next) => {
  const { patientData, resolvedPassword } = sanitizePatientPayload(req.body);
  let authUserId = null;

  try {
    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.N8N_AGENT)) {
      return sendForbidden(res);
    }

    // If password is provided, create a linked auth user for patient self-service access.
    if (resolvedPassword) {
      if (!patientData.email) {
        return res.status(400).json({ error: 'Email is required when password is provided' });
      }
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: patientData.email,
        password: resolvedPassword,
        email_confirm: true,
        user_metadata: {
          full_name: patientData.full_name || null,
          phone: patientData.phone || null
        }
      });
      if (authError || !authData.user) {
        return res.status(400).json({ error: authError?.message || 'Unable to create patient user' });
      }
      authUserId = authData.user.id;
      const { error: profileError } = await supabase
        .from('user_profiles')
        .insert({ user_id: authUserId, role: 'patient' });
      if (profileError) {
        await supabase.auth.admin.deleteUser(authUserId);
        return res.status(400).json({ error: profileError.message });
      }
    }

    const patientInsert = authUserId
      ? { ...patientData, user_id: authUserId }
      : patientData;

    const { data, error } = await supabase
      .from('patients')
      .insert(patientInsert)
      .select()
      .single();

    if (error) {
      // Rollback auth user if created
      if (authUserId) {
        await supabase.from('user_profiles').delete().eq('user_id', authUserId);
        await supabase.auth.admin.deleteUser(authUserId);
      }
      throw error;
    }

    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

// PATCH update patient
router.patch('/:id', validate(patientPatchSchema), async (req, res, next) => {
  const { patientData } = sanitizePatientPayload(req.body);
  try {
    const allowed = await canAccessPatient(req, req.params.id);
    if (!allowed) return sendForbidden(res);
    if (hasAnyRole(req, ROLES.DOCTOR)) return sendForbidden(res);
    const {
      full_name,
      phone,
      email,
      gender,
      date_of_birth,
      allergies,
      medical_notes
    } = patientData;

    const updateData = {};
    if (full_name !== undefined) updateData.full_name = full_name;
    if (phone !== undefined) updateData.phone = phone;
    if (email !== undefined) updateData.email = email;
    if (gender !== undefined) updateData.gender = gender;
    if (date_of_birth !== undefined) updateData.date_of_birth = date_of_birth;
    if (allergies !== undefined) updateData.allergies = allergies;
    if (medical_notes !== undefined) updateData.medical_notes = medical_notes;

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No valid patient fields provided' });
    }

    updateData.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('patients')
      .update(updateData)
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
