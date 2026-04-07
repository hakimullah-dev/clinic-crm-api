const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');

// GET all active waitlist entries
router.get('/', async (req, res) => {
  try {
    const { doctor_id, status } = req.query;
    let query = supabase
      .from('waitlist')
      .select('*, patients(*), doctors(*)')
      .order('added_at', { ascending: true });

    if (doctor_id) query = query.eq('doctor_id', doctor_id);
    if (status) query = query.eq('status', status);
    else query = query.eq('status', 'waiting');

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST add to waitlist
router.post('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('waitlist')
      .insert(req.body)
      .select('*, patients(*), doctors(*)')
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update status
router.patch('/:id/status', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('waitlist')
      .update({ status: req.body.status })
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