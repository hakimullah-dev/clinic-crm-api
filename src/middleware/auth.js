const supabase = require('../lib/supabase');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];

    // n8n API key check (starts with sk_)
    if (token.startsWith('sk_')) {
      const { data, error } = await supabase
        .from('api_keys')
        .select('*')
        .eq('key_hash', token)
        .single();

      if (error || !data) {
        return res.status(401).json({ error: 'Invalid API key' });
      }

      req.user = { role: 'n8n_agent', id: data.id };
      return next();
    }

    // Supabase JWT check
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get user role from user_profiles
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('user_id', user.id)
      .single();

    req.user = {
      id: user.id,
      email: user.email,
      role: profile?.role || 'patient'
    };

    next();
  } catch (err) {
    res.status(500).json({ error: 'Auth error' });
  }
};

module.exports = authenticate;