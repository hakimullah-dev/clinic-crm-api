const errorHandler = (err, req, res, next) => {
  console.error(`[ERROR] ${new Date().toISOString()} - ${err.message}`);
  
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    code: err.status || 500
  });
};

module.exports = errorHandler;