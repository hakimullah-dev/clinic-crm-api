const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const {
  ROLES,
  hasAnyRole,
  sendForbidden,
  getAppointmentById,
  canAccessAppointment
} = require('../lib/access');

const getScopedAppointment = async (req, appointmentId) => {
  const appointment = await getAppointmentById(appointmentId, 'id, doctor_id, patient_id');

  if (!appointment) {
    return { notFound: true };
  }

  const allowed = await canAccessAppointment(req, appointment);
  if (!allowed) {
    return { forbidden: true };
  }

  return { appointment };
};

// POST submit intake form
router.post('/', async (req, res) => {
  try {
    if (!req.body?.appointment_id) {
      return res.status(400).json({ error: 'appointment_id is required' });
    }

    const scopedAppointment = await getScopedAppointment(req, req.body.appointment_id);
    if (scopedAppointment.notFound) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    if (scopedAppointment.forbidden && !hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST)) {
      return sendForbidden(res);
    }

    const { data, error } = await supabase
      .from('intake_forms')
      .insert(req.body)
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET intake form by appointment ID
router.get('/:appointmentId', async (req, res) => {
  try {
    const scopedAppointment = await getScopedAppointment(req, req.params.appointmentId);
    if (scopedAppointment.notFound) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    if (scopedAppointment.forbidden) {
      return sendForbidden(res);
    }

    const { data, error } = await supabase
      .from('intake_forms')
      .select('*')
      .eq('appointment_id', req.params.appointmentId)
      .single();

    if (error) return res.status(404).json({ error: 'Intake form not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH save AI summary
router.patch('/:id/summary', async (req, res) => {
  try {
    if (!hasAnyRole(req, ROLES.ADMIN, ROLES.DOCTOR)) {
      return sendForbidden(res);
    }

    const { data: intakeForm, error: intakeError } = await supabase
      .from('intake_forms')
      .select('id, appointment_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (intakeError) throw intakeError;
    if (!intakeForm) {
      return res.status(404).json({ error: 'Intake form not found' });
    }

    const scopedAppointment = await getScopedAppointment(req, intakeForm.appointment_id);
    if (scopedAppointment.forbidden) {
      return sendForbidden(res);
    }

    const { data, error } = await supabase
      .from('intake_forms')
      .update({ ai_summary: req.body.ai_summary })
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
