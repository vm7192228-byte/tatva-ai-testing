-- Private, owner-scoped chat uploads.
-- Clients receive one-time signed upload URLs; service-role credentials remain server-side.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'tatv-private-uploads',
  'tatv-private-uploads',
  false,
  10485760,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'application/pdf',
    'video/mp4',
    'video/webm',
    'audio/mpeg',
    'audio/webm',
    'audio/wav',
    'audio/mp4',
    'audio/ogg'
  ]::text[]
)
on conflict (id) do update
set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
