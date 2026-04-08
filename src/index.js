const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const authenticate = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');

const patientsRouter = require('./routes/patients');
const appointmentsRouter = require('./routes/appointments');
const doctorsRouter = require('./routes/doctors');
const intakeFormsRouter = require('./routes/intake-forms');
const waitlistRouter = require('./routes/waitlist');
const feedbackRouter = require('./routes/feedback');
const reportsRouter = require('./routes/reports');
const authRouter = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 3001;
const allowedOrigins = [
  'https://clinic-crm-frontend-seven.vercel.app',
  'http://localhost:5173',
  process.env.FRONTEND_URL
].filter(Boolean);

// Security & parsing
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    // Allow browser requests from known frontends and non-browser requests without an Origin header.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json());

// Rate limiting
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later.' }
}));

// Health check (no auth needed)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Public auth routes
app.use('/api/auth', authRouter);

// All other routes protected by auth middleware
app.use('/api/patients', authenticate, patientsRouter);
app.use('/api/appointments', authenticate, appointmentsRouter);
app.use('/api/doctors', authenticate, doctorsRouter);
app.use('/api/intake-forms', authenticate, intakeFormsRouter);
app.use('/api/waitlist', authenticate, waitlistRouter);
app.use('/api/feedback', authenticate, feedbackRouter);
app.use('/api/reports', authenticate, reportsRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// Global error handler
app.use(errorHandler);

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`Clinic CRM API running on http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
}

module.exports = app;
