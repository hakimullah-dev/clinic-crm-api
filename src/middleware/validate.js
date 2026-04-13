const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body || {});

  if (!result.success) {
    return res.status(400).json({
      error: 'Validation failed',
      details: result.error.issues.map((issue) => ({
        field: issue.path.length ? issue.path.join('.') : 'body',
        message: issue.message
      }))
    });
  }

  req.body = result.data;
  return next();
};

module.exports = validate;
