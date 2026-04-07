const authorizeRoles = (...allowedRoles) => (req, res, next) => {
  const role = req.user?.role;

  if (!role) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!allowedRoles.includes(role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  return next();
};

module.exports = authorizeRoles;
