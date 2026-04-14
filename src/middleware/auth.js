const crypto = require('crypto');

const { warn: logWarn, error: logError } = require('../lib/logger');
const supabase = require('../lib/supabase');
const { ROLES, normalizeRole } = require('../lib/access');

const logSecurityEvent = (event, req, details = {}) => {
  logWarn(event, {
    requestId: req?.res?.locals?.requestId,
    userId: req?.user?.id || null,
    role: req?.user?.role || null,
    path: req?.originalUrl,
    method: req?.method,
    ip: req?.ip,
    ...details
  });
};

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Protects all authenticated API routes by accepting either a Supabase JWT
 * or a hashed n8n agent API key and attaching a normalized security context to the request.
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logSecurityEvent('auth_missing_bearer', req);
      return res.status(401).json({ error: 'No bearer token provided. Send Authorization: Bearer <token> or a valid API key.', details: [] });
    }

    const token = authHeader.split(' ')[1];
     // 🔽 DEBUGGING LINES – paste these two lines
    console.log('🔍 Token received:', token);
    console.log('🔍 Starts with sk_?', token.startsWith('sk_'));


    if (token.startsWith('sk_')) {
      const tokenHash = sha256(token);
      const { data, error } = await supabase
        .from('api_keys')
        .select('id, role')
        .eq('key_hash', tokenHash)
        .single();

      if (error || !data) {
        logSecurityEvent('auth_invalid_api_key', req);
        return res.status(401).json({ error: 'Invalid API key. Generate a new n8n agent key and retry the request.', details: [] });
      }

      req.user = {
        role: normalizeRole(data.role) || ROLES.N8N_AGENT,
        id: data.id,
        accessContextLoaded: true
      };
      return next();
    }

    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      logSecurityEvent('auth_invalid_jwt', req);
      return res.status(401).json({ error: 'Invalid token. Refresh the session in the frontend and try again.', details: [] });
    }

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('user_id', user.id)
      .single();

    if (profileError && profileError.code !== 'PGRST116') {
      throw profileError;
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: normalizeRole(profile?.role) || ROLES.PATIENT,
      metadata: user.user_metadata || {},
      accessContextLoaded: false
    };

    next();
  } catch (err) {
    logError('auth_middleware_error', {
      requestId: req.res?.locals?.requestId,
      path: req.originalUrl,
      method: req.method,
      ip: req.ip,
      error: err.message
    });
    res.status(500).json({ error: 'Authentication failed due to a server-side issue. Check auth middleware logs and Supabase connectivity.', details: [] });
  }
};

module.exports = authenticate;
