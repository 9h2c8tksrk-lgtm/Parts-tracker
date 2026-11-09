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
12