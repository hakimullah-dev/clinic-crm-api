const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const {
  ROLES,
  hasAnyRole,
  sendForbidden,
  loadAccessContext,
  canAccessPatient
} = require('../lib/access');

const toNullIfEmptyString = (value) => (value === '' ? null : value);

const normalizePayload = (payload = {}) =>
  Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, toNullIfEmptyString(value)])
  );

const sanitizePatientPayload = (payload = {}) => {
  const normalizedPayload = normalizePayload(payload);
  const { password, temporary_password, ...patientData } = normalizedPayload;
  return {
    patientData,
    resolvedPassword: password || temporary_password || null
  };
};

// GET all patients with search
router.get('/', async (req, res) => {
  try {
    const { search } = req.query;
    await loadAccessContext(req);

    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST, ROLES.DOCTOR)) {
      return sendForbidden(res);
    }

    let query = supabase.from('patients').select('*').order('created_at', { ascending: false });

    if (hasAnyRole(req, ROLES.DOCTOR)) {
      if (!req.user.doctorId) {
        return sendForbidden(res, 'Doctor profile is not linked to this user');
      }

      const { data: appointments, error: appointmentError } = await supabase
        .from('appointments')
        .select('patient_id')
        .eq('doctor_id', req.user.doctorId);

      if (appointmentError) {
        throw appointmentError;
      }

      const patientIds = [...new Set((appointments || []).map((appointment) => appointment.patient_id).filter(Boolean))];
      if (!patientIds.length) {
        return res.json([]);
      }

      query = query.in('id', patientIds);
    }

    if (search) {
      query = query.or(`full_name.ilike.%${search}%,phone.ilike.%${search}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET patient by phone (Aria voice agent uses this)
router.get('/phone/:phone', async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

// GET single patient by ID
router.get('/:id', async (req, res) => {
  try {
    const allowed = await canAccessPatient(req, req.params.id);
    if (!allowed) {
      return sendForbidden(res);
    }

    const { data, error } = await supabase
      .from('patients')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) return res.status(404).json({ error: 'Patient not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create patient
router.post('/', async (req, res) => {
  const { patientData, resolvedPassword } = sanitizePatientPayload(req.body);
  let authUserId = null;

  try {
    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST)) {
      return sendForbidden(res);
    }

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
        .insert({
          user_id: authUserId,
          role: 'patient'
        });

      if (profileError) {
        await supabase.auth.admin.deleteUser(authUserId);
        return res.status(400).json({ error: profileError.message });
      }
    }

    const { data, error } = await supabase
      .from('patients')
      .insert(patientData)
      .select()
      .single();

    if (error) {
      if (authUserId) {
        await supabase
          .from('user_profiles')
          .delete()
          .eq('user_id', authUserId);
        await supabase.auth.admin.deleteUser(authUserId);
      }
      throw error;
    }

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update patient
router.patch('/:id', async (req, res) => {
  const { patientData } = sanitizePatientPayload(req.body);

  try {
    const allowed = await canAccessPatient(req, req.params.id);
    if (!allowed) {
      return sendForbidden(res);
    }

    if (hasAnyRole(req, ROLES.DOCTOR)) {
      return sendForbidden(res);
    }

    if (Object.keys(patientData).length === 0) {
      return res.status(400).json({ error: 'No valid patient fields provided' });
    }

    const { data, error } = await supabase
      .from('patients')
      .update(patientData)
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
