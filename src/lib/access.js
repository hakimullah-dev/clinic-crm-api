const supabase = require('./supabase');

const ROLES = Object.freeze({
  ADMIN: 'admin',
  DOCTOR: 'doctor',
  RECEPTIONIST: 'receptionist',
  PATIENT: 'patient',
  N8N_AGENT: 'n8n_agent'
});

const STORED_ROLES = [
  ROLES.ADMIN,
  ROLES.DOCTOR,
  ROLES.RECEPTIONIST,
  ROLES.PATIENT
];

const normalizeRole = (role) => (
  typeof role === 'string'
    ? role.trim().toLowerCase()
    : ''
);

const getRequestRole = (req) => normalizeRole(req.user?.role);

const hasAnyRole = (req, ...roles) => {
  const normalizedRoles = roles.flat().map(normalizeRole).filter(Boolean);
  return normalizedRoles.includes(getRequestRole(req));
};

const sendForbidden = (res, message = 'Forbidden') => res.status(403).json({ error: message });

const sendUnauthorized = (res, message = 'Unauthorized') => res.status(401).json({ error: message });

const loadAccessContext = async (req) => {
  if (req.user?.accessContextLoaded) {
    return req.user;
  }

  req.user = req.user || {};
  req.user.doctorId = req.user.doctorId || null;
  req.user.patientId = req.user.patientId || null;

  if (!req.user.email) {
    req.user.accessContextLoaded = true;
    return req.user;
  }

  if (getRequestRole(req) === ROLES.DOCTOR) {
    const { data, error } = await supabase
      .from('doctors')
      .select('id')
      .ilike('email', req.user.email)
      .maybeSingle();

    if (error) {
      throw error;
    }

    req.user.doctorId = data?.id || null;
  }

  if (getRequestRole(req) === ROLES.PATIENT) {
    const { data, error } = await supabase
      .from('patients')
      .select('id')
      .ilike('email', req.user.email)
      .maybeSingle();

    if (error) {
      throw error;
    }

    req.user.patientId = data?.id || null;
  }

  req.user.accessContextLoaded = true;
  return req.user;
};

const getAppointmentById = async (appointmentId, select = '*') => {
  const { data, error } = await supabase
    .from('appointments')
    .select(select)
    .eq('id', appointmentId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
};

const doctorHasPatientAccess = async (doctorId, patientId) => {
  if (!doctorId || !patientId) {
    return false;
  }

  const { data, error } = await supabase
    .from('appointments')
    .select('id')
    .eq('doctor_id', doctorId)
    .eq('patient_id', patientId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Boolean(data);
};

const canAccessDoctor = async (req, doctorId) => {
  if (hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST)) {
    return Boolean(doctorId);
  }

  await loadAccessContext(req);

  if (!hasAnyRole(req, ROLES.DOCTOR)) {
    return false;
  }

  if (!req.user.doctorId) {
    return false;
  }

  if (!doctorId) {
    return true;
  }

  return String(req.user.doctorId) === String(doctorId);
};

const getScopedDoctorId = async (req, requestedDoctorId) => {
  if (hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST)) {
    return requestedDoctorId || null;
  }

  await loadAccessContext(req);

  if (hasAnyRole(req, ROLES.DOCTOR)) {
    return req.user.doctorId || null;
  }

  return null;
};

const canAccessPatient = async (req, patientId) => {
  if (!patientId) {
    return false;
  }

  if (hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST)) {
    return true;
  }

  await loadAccessContext(req);

  if (hasAnyRole(req, ROLES.PATIENT)) {
    return String(req.user.patientId) === String(patientId);
  }

  if (hasAnyRole(req, ROLES.DOCTOR)) {
    return doctorHasPatientAccess(req.user.doctorId, patientId);
  }

  return false;
};

const canAccessAppointment = async (req, appointment) => {
  if (!appointment) {
    return false;
  }

  if (hasAnyRole(req, ROLES.ADMIN, ROLES.RECEPTIONIST)) {
    return true;
  }

  await loadAccessContext(req);

  if (hasAnyRole(req, ROLES.DOCTOR)) {
    return String(req.user.doctorId) === String(appointment.doctor_id);
  }

  if (hasAnyRole(req, ROLES.PATIENT)) {
    return String(req.user.patientId) === String(appointment.patient_id);
  }

  return false;
};

module.exports = {
  ROLES,
  STORED_ROLES,
  normalizeRole,
  getRequestRole,
  hasAnyRole,
  sendForbidden,
  sendUnauthorized,
  loadAccessContext,
  getAppointmentById,
  doctorHasPatientAccess,
  canAccessDoctor,
  getScopedDoctorId,
  canAccessPatient,
  canAccessAppointment
};
