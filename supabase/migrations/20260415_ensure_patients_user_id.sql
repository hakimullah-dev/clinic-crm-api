ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS idx_patients_user_id
  ON public.patients(user_id);
