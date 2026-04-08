const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const supabase = require('../lib/supabase');
const authenticate = require('../middleware/auth');
const authorizeRoles = require('../middleware/authorizeRoles');

const router = express.Router();

const authClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

const allowAdminBootstrap = (req, res, next) => {
  const setupKey = req.headers['x-admin-setup-key'] || req.body?.setup_key;
  const expectedSetupKey = process.env.ADMIN_SETUP_KEY;

  if (!setupKey) {
    return authenticate(req, res, () => authorizeRoles('admin')(req, res, next));
  }

  if (!expectedSetupKey) {
    return res.status(503).json({ error: 'ADMIN_SETUP_KEY is not configured' });
  }

  if (setupKey !== expectedSetupKey) {
    return res.status(403).json({ error: 'Invalid admin setup key' });
  }

  return next();
};

const createUserAccount = async (req, res, options = {}) => {
  const {
    email,
    full_name,
    name,
    password,
    temporary_password,
    phone,
    role
  } = req.body || {};
  const resolvedFullName = full_name || name || null;
  const resolvedPassword = password || temporary_password;
  const userRole = options.forceRole || role || 'patient';

  if (!email || !resolvedPassword) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  let createdUserId;

  try {
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
      return res.status(400).json({ error: createError?.message || 'Unable to create user' });
    }

    createdUserId = createdUser.user.id;

    const { error: profileError } = await supabase
      .from('user_profiles')
      .insert({
        user_id: createdUserId,
        role: userRole
      });

    if (profileError) {
      await supabase.auth.admin.deleteUser(createdUserId);
      return res.status(400).json({ error: profileError.message });
    }

    const { data: loginData, error: loginError } = await authClient.auth.signInWithPassword({
      email,
      password: resolvedPassword
    });

    if (loginError || !loginData.session || !loginData.user) {
      return res.status(201).json({
        user: createdUser.user,
        role: userRole,
        message: options.successMessage || 'User created successfully'
      });
    }

    return res.status(201).json({
      token: loginData.session.access_token,
      user: loginData.user,
      role: userRole,
      message: options.successMessage || 'User created successfully'
    });
  } catch (error) {
    if (createdUserId) {
      await supabase.auth.admin.deleteUser(createdUserId);
    }

    return res.status(500).json({ error: options.failureMessage || 'Failed to sign up user' });
  }
};

router.post('/signup', async (req, res) => createUserAccount(req, res));

router.post('/register', async (req, res) => createUserAccount(req, res, {
  forceRole: 'receptionist',
  successMessage: 'Receptionist account created successfully',
  failureMessage: 'Failed to register receptionist'
}));

router.post('/register-admin', allowAdminBootstrap, async (req, res) => createUserAccount(req, res, {
  forceRole: 'admin',
  successMessage: 'Admin account created successfully',
  failureMessage: 'Failed to register admin'
}));

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const { data, error } = await authClient.auth.signInWithPassword({
      email,
      password
    });

    if (error || !data.session || !data.user) {
      return res.status(401).json({ error: error?.message || 'Invalid login credentials' });
    }

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('user_id', data.user.id)
      .single();

    if (profileError && profileError.code !== 'PGRST116') {
      return res.status(400).json({ error: profileError.message });
    }

    return res.json({
      token: data.session.access_token,
      user: data.user,
      role: profile?.role || 'patient'
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to log in user' });
  }
});

router.post('/logout', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.split(' ')[1]
    : req.body?.token;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    const { error } = await supabase.auth.admin.signOut(token);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.json({ message: 'Logged out successfully' });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to log out user' });
  }
});

module.exports = router;
