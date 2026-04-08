const { normalizeRole } = require('../lib/access');

const authorizeRoles = (...allowedRoles) => (req, res, next) => {
  const role = normalizeRole(req.user?.role);
  const normalizedAllowedRoles = allowedRoles.map(normalizeRole).filter(Boolean);

  if (!role) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!normalizedAllowedRoles.includes(role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  return next();
};

module.exports = authorizeRoles;
