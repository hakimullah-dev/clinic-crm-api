const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const config = require('../lib/config');
const { error: logError, warn: logWarn, info: logInfo } = require('../lib/logger');
const supabase = require('../lib/supabase');
const authenticate = require('../middleware/auth');
const authorizeRoles = require('../middleware/authorizeRoles');
const validate = require('../middleware/validate');
const { ROLES } = require('../lib/access');
const {
  authSignupSchema,
  authRegisterSchema,
  authRegisterAdminSchema,
  authLoginSchema,
  authLogoutSchema
} = require('../lib/validators');

const router = express.Router();
const globalAuthClient = globalThis;
if (!globalAuthClient.__clinicCrmSupabaseAuthClient) {
  globalAuthClient.__clinicCrmSupabaseAuthClient = createClient(
    config.supabase.url,
    config.supabase.anonKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );
}
const authClient = globalAuthClient.__clinicCrmSupabaseAuthClient;

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

/**
 * Protects the admin bootstrap route by requiring a deployment-scoped setup key
 * before permitting any admin account creation.
 */
const requireAdminSetupKey = (req, res, next) => {
  const setupKey = req.headers['x-admin-setup-key'] || req.body?.setup_key;
  const expectedSetupKey = config.security.adminSetupKey;

  if (!expectedSetupKey) {
    logSecurityEvent('admin_setup_key_missing', req);
    return res.status(403).json({ error: 'Admin registration is disabled. Set ADMIN_SETUP_KEY in Vercel before calling /api/auth/register-admin.', details: [] });
  }

  if (!setupKey || setupKey !== expectedSetupKey) {
    logSecurityEvent('admin_setup_key_invalid', req);
    return res.status(403).json({ error: 'Invalid admin setup key. Pass the exact ADMIN_SETUP_KEY value in the x-admin-setup-key header.', details: [] });
  }

  return next();
};

const createUserAccount = async (req, res, options = {}) => {
  const role = options.forceRole;
  const {
    email,
    full_name,
    name,
    password,
    temporary_password,
    phone
  } = req.body || {};
  const resolvedFullName = full_name || name || null;
  const resolvedPassword = password || temporary_password;

  if (!email || !resolvedPassword) {
    return res.status(400).json({ error: 'Email and password are required to create a user account.', details: [] });
  }

  let createdUserId;

  try {
    if (options.allowExistingUser) {
      const { data: existingUsersData, error: existingUsersError } = await supabase.auth.admin.listUsers();

      if (!existingUsersError) {
        const existingUsers = existingUsersData?.users || [];
        const alreadyExists = existingUsers.find((user) => String(user.email || '').trim().toLowerCase() === email);

        if (alreadyExists) {
          return res.status(200).json({
            success: true,
            message: 'Account already exists',
            existing: true
          });
        }
      }
    }

    const { data: createdUser, error: createError } = await supabase.auth.admin.createUser({
      email,
      password: resolvedPassword,
      email_confirm: true,
      user_metadata: {
        full_name: resolvedFullName,
        phone: phone || null
      }
    });

    if (createError || !createdUser.user) {
      if (
        options.allowExistingUser
        && (createError?.status === 422
          || /already|duplicate/i.test(createError?.message || ''))
      ) {
        return res.status(200).json({
          success: true,
          message: 'Account already exists',
          existing: true
        });
      }

      return res.status(400).json({ error: createError?.message || 'Unable to create user. Verify the Supabase auth configuration and retry.', details: [] });
    }

    createdUserId = createdUser.user.id;

    const { error: profileError } = await supabase
      .from('user_profiles')
      .insert({
        user_id: createdUserId,
        role
      });

    if (profileError) {
      await supabase.auth.admin.deleteUser(createdUserId);
      return res.status(400).json({ error: profileError.message, details: [] });
    }

    const { data: loginData, error: loginError } = await authClient.auth.signInWithPassword({
      email,
      password: resolvedPassword
    });

    logInfo('user_account_created', {
      requestId: req.res?.locals?.requestId,
      userId: createdUserId,
      role,
      path: req.originalUrl,
      method: req.method
    });

    if (loginError || !loginData.session || !loginData.user) {
      return res.status(201).json({
        user: createdUser.user,
        role,
        message: options.successMessage || 'User created successfully'
      });
    }

    return res.status(201).json({
      token: loginData.session.access_token,
      user: loginData.user,
      role,
      message: options.successMessage || 'User created successfully'
    });
  } catch (error) {
    if (createdUserId) {
      await supabase.auth.admin.deleteUser(createdUserId);
    }

    logError('user_creation_failed', {
      requestId: req.res?.locals?.requestId,
      role,
      path: req.originalUrl,
      method: req.method,
      ip: req.ip,
      error: error.message
    });
    return res.status(500).json({ error: options.failureMessage || 'Failed to sign up user. Check Supabase availability and server logs for details.', details: [] });
  }
};

router.post('/signup', validate(authSignupSchema), async (req, res) => {
  if (req.body?.role && String(req.body.role).trim().toLowerCase() !== ROLES.PATIENT) {
    logSecurityEvent('role_escalation_attempt_signup', req);
  }

  return createUserAccount(req, res, {
    forceRole: ROLES.PATIENT,
    allowExistingUser: true,
    successMessage: 'Patient account created successfully',
    failureMessage: 'Failed to sign up user'
  });
});

router.post('/register', authenticate, authorizeRoles(ROLES.ADMIN), validate(authRegisterSchema), async (req, res) => createUserAccount(req, res, {
  forceRole: ROLES.RECEPTIONIST,
  successMessage: 'Receptionist account created successfully',
  failureMessage: 'Failed to register receptionist'
}));

router.post('/register-admin', requireAdminSetupKey, validate(authRegisterAdminSchema), async (req, res) => createUserAccount(req, res, {
  forceRole: ROLES.ADMIN,
  successMessage: 'Admin account created successfully',
  failureMessage: 'Failed to register admin'
}));

router.post('/login', validate(authLoginSchema), async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required to log in.', details: [] });
  }

  try {
    const { data, error } = await authClient.auth.signInWithPassword({
      email,
      password
    });

    if (error || !data.session || !data.user) {
      logSecurityEvent('login_invalid_credentials', req);
      return res.status(401).json({ error: error?.message || 'Invalid login credentials. Verify the email and password and try again.', details: [] });
    }

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('user_id', data.user.id)
      .single();

    if (profileError && profileError.code !== 'PGRST116') {
      return res.status(400).json({ error: profileError.message, details: [] });
    }

    return res.json({
      token: data.session.access_token,
      user: data.user,
      role: profile?.role || 'patient'
    });
  } catch (error) {
    logError('login_failed', {
      requestId: req.res?.locals?.requestId,
      path: req.originalUrl,
      method: req.method,
      ip: req.ip,
      error: error.message
    });
    return res.status(500).json({ error: 'Failed to log in user. Check Supabase auth connectivity and retry.', details: [] });
  }
});

router.post('/logout', validate(authLogoutSchema), async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.split(' ')[1]
    : req.body?.token;

  if (!token) {
    return res.status(400).json({ error: 'Token is required to log out the current session.', details: [] });
  }

  try {
    const { error } = await supabase.auth.admin.signOut(token);

    if (error) {
      return res.status(400).json({ error: error.message, details: [] });
    }

    return res.json({ message: 'Logged out successfully' });
  } catch (error) {
    logError('logout_failed', {
      requestId: req.res?.locals?.requestId,
      path: req.originalUrl,
      method: req.method,
      ip: req.ip,
      error: error.message
    });
    return res.status(500).json({ error: 'Failed to log out user. Check Supabase auth connectivity and retry.', details: [] });
  }
});

module.exports = router;
