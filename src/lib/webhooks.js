const crypto = require('crypto');

const config = require('./config');
const { error: logError, info: logInfo } = require('./logger');
const supabase = require('./supabase');

const CLINIC_ID = config.webhooks.clinicId;
const WEBHOOK_TIMEOUT_MS = config.webhooks.timeoutMs;
const RETRY_DELAY_MS = config.webhooks.retryDelayMs;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createSignature = (secret, payload) => crypto
  .createHmac('sha256', secret || '')
  .update(payload)
  .digest('hex');

const logAudit = async ({
  userId = null,
  role = 'system',
  action,
  resourceType,
  resourceId = null,
  oldValues = null,
  newValues = null,
  ipAddress = null
}) => {
  try {
    await supabase.from('audit_logs').insert({
      user_id: userId,
      role,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      old_values: oldValues,
      new_values: newValues,
      ip_address: ipAddress
    });
  } catch (error) {
    logError('audit_log_insert_failed', {
      error: error.message
    });
  }
};

const deliverWebhook = async (subscription, payload, eventType) => {
  const payloadString = JSON.stringify(payload);
  const signature = createSignature(subscription.secret, payloadString);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

      const response = await fetch(subscription.target_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature
        },
        body: payloadString,
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Webhook delivery failed with status ${response.status}`);
      }

      await logAudit({
        role: 'system',
        action: 'webhook_delivery_succeeded',
        resourceType: 'webhook_subscription',
        resourceId: subscription.id,
        newValues: {
          event_type: eventType,
          attempt,
          target_url: subscription.target_url,
          status: response.status
        }
      });

      logInfo('webhook_delivery_succeeded', {
        resourceId: subscription.id,
        eventType,
        targetUrl: subscription.target_url,
        attempt
      });

      return;
    } catch (error) {
      await logAudit({
        role: 'system',
        action: 'webhook_delivery_failed',
        resourceType: 'webhook_subscription',
        resourceId: subscription.id,
        newValues: {
          event_type: eventType,
          attempt,
          target_url: subscription.target_url,
          error: error.message
        }
      });

      logError('webhook_delivery_failed', {
        subscriptionId: subscription.id,
        eventType,
        attempt,
        targetUrl: subscription.target_url,
        error: error.message
      });

      if (attempt === 1) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
};

const fireWebhook = async (eventType, data) => {
  try {
    const payload = {
      event: eventType,
      data,
      timestamp: new Date().toISOString(),
      clinic_id: CLINIC_ID
    };

    const { data: subscriptions, error } = await supabase
      .from('webhook_subscriptions')
      .select('id, event_type, target_url, secret, is_active')
      .eq('event_type', eventType)
      .eq('is_active', true);

    if (error) {
      throw error;
    }

    await Promise.all((subscriptions || []).map((subscription) => deliverWebhook(subscription, payload, eventType)));
  } catch (error) {
    logError('webhook_dispatch_failed', {
      eventType,
      error: error.message
    });

    await logAudit({
      role: 'system',
      action: 'webhook_dispatch_failed',
      resourceType: 'webhook_subscription',
      newValues: {
        event_type: eventType,
        error: error.message
      }
    });
  }
};

module.exports = {
  fireWebhook,
  logAudit
};
