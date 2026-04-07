const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// POST submit intake form
router.post('/', async (req, res) => {
  try {
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