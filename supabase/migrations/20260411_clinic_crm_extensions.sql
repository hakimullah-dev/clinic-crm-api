create extension if not exists pgcrypto;

comment on extension pgcrypto is 'Provides gen_random_uuid() for audit and webhook subscription identifiers.';

alter table public.patients
  add column if not exists last_doctor_id uuid references public.doctors (id),
  add column if not exists last_booking_date timestamptz,
  add column if not exists visit_count integer not null default 0,
  add column if not exists booking_source text default 'receptionist';

comment on column public.patients.last_doctor_id is 'Tracks the doctor seen most recently so agents can personalize future workflows.';
comment on column public.patients.last_booking_date is 'Stores the patient''s latest booking/completed appointment timestamp for fast CRM lookups.';
comment on column public.patients.visit_count is 'Denormalized visit counter used by reporting and returning-patient segmentation.';
comment on column public.patients.booking_source is 'Stores the source of the patient''s last booking creation for agent attribution.';

alter table public.appointments
  add column if not exists booking_source text default 'receptionist',
  add column if not exists google_event_id text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists cancellation_reason text;

comment on column public.appointments.booking_source is 'Captures whether the booking originated from Aria voice, receptionist, or patient portal.';
comment on column public.appointments.google_event_id is 'Stores the external Google Calendar event id for sync and reschedule workflows.';
comment on column public.appointments.cancelled_at is 'Soft-delete timestamp for machine-readable cancellation workflows.';
comment on column public.appointments.completed_at is 'Completion timestamp used for visit-count and reporting calculations.';
comment on column public.appointments.cancellation_reason is 'Human or AI-provided cancellation reason for auditability.';

alter table public.doctors
  add column if not exists user_id uuid references auth.users (id);

comment on column public.doctors.user_id is 'Direct auth.users link for secure doctor identity resolution.';

alter table public.patients
  add column if not exists user_id uuid references auth.users (id);

comment on column public.patients.user_id is 'Direct auth.users link for secure patient identity resolution.';

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id),
  role text not null,
  action text not null,
  resource_type text not null,
  resource_id uuid,
  old_values jsonb,
  new_values jsonb,
  ip_address text,
  created_at timestamptz not null default now()
);

comment on table public.audit_logs is 'Immutable machine-readable activity log for API, agent, and webhook side effects.';
comment on column public.audit_logs.user_id is 'Authenticated user responsible for the action when available.';
comment on column public.audit_logs.role is 'Role or system actor that performed the action.';
comment on column public.audit_logs.action is 'Verb describing what happened, such as updated, cancelled, or webhook_delivery_failed.';
comment on column public.audit_logs.resource_type is 'Logical entity type affected by the action.';
comment on column public.audit_logs.resource_id is 'Optional identifier of the affected entity.';
comment on column public.audit_logs.old_values is 'Previous persisted values for diffing and forensic review.';
comment on column public.audit_logs.new_values is 'New values or outbound payload metadata captured after the action.';
comment on column public.audit_logs.ip_address is 'Originating IP address when the action comes from an HTTP request.';

create table if not exists public.webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  target_url text not null,
  secret text,
  is_active boolean default true,
  created_at timestamptz default now()
);

comment on table public.webhook_subscriptions is 'Outbound webhook destinations subscribed by automation platforms such as n8n.';
comment on column public.webhook_subscriptions.event_type is 'Name of the event to receive, for example appointment.cancelled.';
comment on column public.webhook_subscriptions.target_url is 'HTTPS endpoint that will receive signed outbound webhook payloads.';
comment on column public.webhook_subscriptions.secret is 'HMAC signing secret used to verify outbound webhook authenticity.';
comment on column public.webhook_subscriptions.is_active is 'Toggle used to disable deliveries without deleting configuration.';

create index if not exists audit_logs_user_id_idx
  on public.audit_logs (user_id);

create index if not exists audit_logs_resource_type_idx
  on public.audit_logs (resource_type);

create index if not exists audit_logs_created_at_idx
  on public.audit_logs (created_at desc);

create index if not exists audit_logs_user_resource_created_idx
  on public.audit_logs (user_id, resource_type, created_at desc);

create index if not exists webhook_subscriptions_event_type_idx
  on public.webhook_subscriptions (event_type);

create index if not exists webhook_subscriptions_active_event_idx
  on public.webhook_subscriptions (is_active, event_type);

create index if not exists patients_last_doctor_id_idx
  on public.patients (last_doctor_id);

create index if not exists patients_last_booking_date_idx
  on public.patients (last_booking_date desc);

create index if not exists patients_booking_source_idx
  on public.patients (booking_source);

create index if not exists patients_user_id_idx
  on public.patients (user_id);

create unique index if not exists doctors_user_id_unique_idx
  on public.doctors (user_id)
  where user_id is not null;

create unique index if not exists patients_user_id_unique_idx
  on public.patients (user_id)
  where user_id is not null;

create index if not exists doctors_user_id_idx
  on public.doctors (user_id);

create index if not exists appointments_status_idx
  on public.appointments (status);

create index if not exists appointments_scheduled_at_idx
  on public.appointments (scheduled_at desc);

create index if not exists appointments_doctor_id_idx
  on public.appointments (doctor_id);

create index if not exists appointments_patient_id_idx
  on public.appointments (patient_id);

create index if not exists appointments_doctor_schedule_idx
  on public.appointments (doctor_id, scheduled_at desc);

create index if not exists appointments_patient_schedule_idx
  on public.appointments (patient_id, scheduled_at desc);

create index if not exists appointments_google_event_id_idx
  on public.appointments (google_event_id);

create index if not exists appointments_booking_source_idx
  on public.appointments (booking_source);
