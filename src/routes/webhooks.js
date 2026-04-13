const express = require('express');
const { z } = require('zod');

const supabase = require('../lib/supabase');
const validate = require('../middleware/validate');
const { fireWebhook, logAudit } = require('../lib/webhooks');
const { ROLES, hasAnyRole, sendForbidden } = require('../lib/access');

const router = express.Router();

const triggerSchema = z.object({
  event_type: z.string().trim().min(1, 'event_type is required'),
  data: z.any().default({})
}).strip();

router.post('/trigger', validate(triggerSchema), async (req, res) => {
  if (!hasAnyRole(req, ROLES.ADMIN, ROLES.N8N_AGENT)) {
    return sendForbidden(res);
  }

  fireWebhook(req.body.event_type, req.body.data);

  await logAudit({
    userId: req.user?.id || null,
    role: req.user?.role || 'unknown',
    action: 'webhook_triggered',
    resourceType: 'webhook_subscription',
    newValues: {
      event_type: req.body.event_type
    },
    ipAddress: req.ip
  });

  return res.json({
    success: true,
    event_type: req.body.event_type,
    queued_at: new Date().toISOString()
  });
});

module.exports = router;
