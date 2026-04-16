-- Add missing patient fields
ALTER TABLE patients
ADD COLUMN IF NOT EXISTS gender VARCHAR(20),
ADD COLUMN IF NOT EXISTS date_of_birth DATE,
ADD COLUMN IF NOT EXISTS allergies TEXT,
ADD COLUMN IF NOT EXISTS medical_notes TEXT;

-- Add comment for clarity
COMMENT ON COLUMN patients.gender IS 'Patient gender: male, female, other, prefer_not_to_say';
COMMENT ON COLUMN patients.date_of_birth IS 'Patient date of birth in YYYY-MM-DD format';
COMMENT ON COLUMN patients.allergies IS 'Known allergies, comma separated';
COMMENT ON COLUMN patients.medical_notes IS 'General medical notes';
