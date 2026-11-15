create table if not exists public.parts (
	barcode text primary key check (length(barcode) between 1 and 14),
	part_name text not null check (length(trim(part_name)) > 0),
	description text not null default '',
	stock_level integer not null default 0 check (stock_level >= 0),
	created_at timestamptz not null default now()
);

create table if not exists public.assigned_parts (
	id uuid primary key default gen_random_uuid(),
	created_at timestamptz not null default now(),
	wo_number text not null check (length(trim(wo_number)) > 0),
	asset_number text not null default '' check (length(asset_number) <= 200),
	barcode text not null,
	part_name text not null,
	description text not null default '',
	stock_level integer not null check (stock_level >= 0),
	created_by uuid not null references auth.users(id),
	assigned_by text not null default ''
);

alter table public.assigned_parts
	add column if not exists asset_number text not null default '' check (length(asset_number) <= 200);

alter table public.assigned_parts
	add column if not exists quantity integer not null default 1 check (quantity > 0);

alter table public.assigned_parts
	alter column stock_level drop not null;

create or replace function public.set_assignment_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	select users.email
	into new.assigned_by
	from auth.users as users
	where users.id = new.created_by;
	return new;
end;
$$;

revoke all on function public.set_assignment_email() from public, anon, authenticated;

drop trigger if exists set_assignment_email on public.assigned_parts;
create trigger set_assignment_email
	before insert on public.assigned_parts
	for each row execute function public.set_assignment_email();

alter table public.parts
	add column if not exists photo_path text;

insert into storage.buckets (id, name, public)
values ('part-photos', 'part-photos', false)
on conflict (id) do nothing;

drop policy if exists "Authenticated users can read part photos" on storage.objects;
create policy "Authenticated users can read part photos"
	on storage.objects for select to authenticated using (bucket_id = 'part-photos');

drop policy if exists "Authenticated users can upload part photos" on storage.objects;
create policy "Authenticated users can upload part photos"
	on storage.objects for insert to authenticated with check (bucket_id = 'part-photos');

create table if not exists public.stock_counts (
	id uuid primary key default gen_random_uuid(),
	created_at timestamptz not null default now(),
	count_name text not null check (length(trim(count_name)) > 0),
	barcode text not null,
	part_name text not null,
	description text not null default '',
	counted_qty integer not null check (counted_qty >= 0),
	created_by uuid not null references auth.users(id),
	counted_by text not null default ''
);

create or replace function public.set_count_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	select users.email into new.counted_by from auth.users as users where users.id = new.created_by;
	return new;
end;
$$;

revoke all on function public.set_count_email() from public, anon, authenticated;

drop trigger if exists set_count_email on public.stock_counts;
create trigger set_count_email
	before insert on public.stock_counts
	for each row execute function public.set_count_email();

alter table public.stock_counts enable row level security;

drop policy if exists "Authenticated users can read stock counts" on public.stock_counts;
create policy "Authenticated users can read stock counts"
	on public.stock_counts for select to authenticated using (true);

drop policy if exists "Users can add stock counts as themselves" on public.stock_counts;
create policy "Users can add stock counts as themselves"
	on public.stock_counts for insert to authenticated
	with check (created_by = (select auth.uid()));

grant select, insert on public.stock_counts to authenticated;

create table if not exists public.part_barcodes (
	alias text primary key check (length(alias) between 1 and 14),
	barcode text not null references public.parts(barcode) on delete cascade,
	created_by uuid not null references auth.users(id),
	created_at timestamptz not null default now()
);

alter table public.part_barcodes enable row level security;

drop policy if exists "Authenticated users can read part barcodes" on public.part_barcodes;
create policy "Authenticated users can read part barcodes"
	on public.part_barcodes for select to authenticated using (true);

drop policy if exists "Users can add part barcodes as themselves" on public.part_barcodes;
create policy "Users can add part barcodes as themselves"
	on public.part_barcodes for insert to authenticated
	with check (created_by = (select auth.uid()));

grant select, insert on public.part_barcodes to authenticated;

alter table public.parts enable row level security;
alter table public.assigned_parts enable row level security;

drop policy if exists "Authenticated users can read parts" on public.parts;
create policy "Authenticated users can read parts"
	on public.parts for select to authenticated using (true);

drop policy if exists "Authenticated users can add parts" on public.parts;
create policy "Authenticated users can add parts"
	on public.parts for insert to authenticated with check (true);

drop policy if exists "Authenticated users can update parts" on public.parts;
create policy "Authenticated users can update parts"
	on public.parts for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated users can read assignments" on public.assigned_parts;
create policy "Authenticated users can read assignments"
	on public.assigned_parts for select to authenticated using (true);

drop policy if exists "Users can add assignments as themselves" on public.assigned_parts;
create policy "Users can add assignments as themselves"
	on public.assigned_parts for insert to authenticated
	with check (created_by = (select auth.uid()));

grant usage on schema public to authenticated;
grant select, insert, update on public.parts to authenticated;
grant select, insert on public.assigned_parts to authenticated;

insert into public.parts (barcode, part_name, description, stock_level)
values
	('1234567890123', 'Widget A', 'Standard widget for assembly.', 42),
	('9876543210987', 'Gadget B', 'Replacement gadget for repair.', 17)
on conflict (barcode) do nothing;

do $$
begin
	if not exists (
		select 1
		from pg_publication_tables
		where pubname = 'supabase_realtime'
			and schemaname = 'public'
			and tablename = 'parts'
	) then
		alter publication supabase_realtime add table public.parts;
	end if;
	if not exists (
		select 1
		from pg_publication_tables
		where pubname = 'supabase_realtime'
			and schemaname = 'public'
			and tablename = 'assigned_parts'
	) then
		alter publication supabase_realtime add table public.assigned_parts;
	end if;
end;
$$;
notify pgrst, 'reload schema';
