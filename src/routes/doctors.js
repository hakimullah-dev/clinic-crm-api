const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

const toNullIfEmptyString = (value) => (value === '' ? null : value);

const normalizeDoctorPayload = (payload = {}) => {
  const normalized = Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, toNullIfEmptyString(value)])
  );

  if (typeof normalized.working_days === 'string') {
    const trimmed = normalized.working_days.trim();
    if (!trimmed) {
      normalized.working_days = [];
    } else {
      try {
        const parsed = JSON.parse(trimmed);
        normalized.working_days = Array.isArray(parsed)
          ? parsed.map((item) => String(item).trim()).filter(Boolean)
          : trimmed.split(',').map((item) => item.trim()).filter(Boolean);
      } catch (_) {
        normalized.working_days = trimmed.split(',').map((item) => item.trim()).filter(Boolean);
      }
    }
  }

  return normalized;
};

// GET all active doctors
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('doctors')
      .select('*')
      .eq('is_active', true)
      .order('full_name', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single doctor
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('doctors')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) return res.status(404).json({ error: 'Doctor not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create doctor (admin only)
router.post('/', async (req, res) => {
  try {
    const normalizedBody = normalizeDoctorPayload(req.body);
    const { password, ...doctorData } = normalizedBody;

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: doctorData.email,
      password: password || 'Doctor1234!',
      email_confirm: true,
      user_metadata: { full_name: doctorData.full_name }
    });

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    const authUser = authData.user;

    const { error: profileError } = await supabase
      .from('user_profiles')
      .insert({
        user_id: authUser.id,
        role: 'doctor'
      });

    if (profileError) {
      await supabase.auth.admin.deleteUser(authUser.id);
      return res.status(400).json({ error: profileError.message });
    }

    const { data, error } = await supabase
      .from('doctors')
      .insert(doctorData)
      .select()
      .single();

    if (error) {
      await supabase.auth.admin.deleteUser(authUser.id);
      throw error;
    }

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update doctor
router.patch('/:id', async (req, res) => {
  try {
    const doctorData = normalizeDoctorPayload(req.body);
    const { data, error } = await supabase
      .from('doctors')
      .update(doctorData)
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
