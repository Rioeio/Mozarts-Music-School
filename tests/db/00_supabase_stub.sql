-- Minimal emulation of the Supabase platform pieces the migrations depend on:
-- API roles, default grants on the public schema, and the auth schema helpers.
-- Mirrors Supabase defaults so privilege tests reflect the hosted behaviour:
-- every new table/function in public is granted to anon, authenticated and
-- service_role unless a migration revokes it, and service_role bypasses RLS.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz,
  encrypted_password text default '',
  raw_user_meta_data jsonb default '{}'::jsonb,
  banned_until timestamptz,
  created_at timestamptz default now()
);

create function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

-- Test helpers, executable by every role.
create schema tests;
grant usage on schema tests to public;

create function tests.assert(p_ok boolean, p_message text) returns void
language plpgsql
as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'ASSERTION FAILED: %', p_message;
  end if;
  raise notice 'ok - %', p_message;
end;
$$;

-- Runs a statement that must fail, optionally with a specific SQLSTATE.
create function tests.expect_error(p_sql text, p_sqlstate text, p_message text) returns void
language plpgsql
as $$
begin
  begin
    execute p_sql;
  exception when others then
    if p_sqlstate is not null and sqlstate <> p_sqlstate then
      raise exception 'ASSERTION FAILED: % (expected SQLSTATE %, got %: %)', p_message, p_sqlstate, sqlstate, sqlerrm;
    end if;
    raise notice 'ok - % [%]', p_message, sqlstate;
    return;
  end;
  raise exception 'ASSERTION FAILED: % (statement succeeded but should have failed)', p_message;
end;
$$;

-- Number of rows a query returns for the current role.
create function tests.count_rows(p_sql text) returns bigint
language plpgsql
as $$
declare
  v_count bigint;
begin
  execute format('select count(*) from (%s) q', p_sql) into v_count;
  return v_count;
end;
$$;

-- Number of rows a write statement affected for the current role.
create function tests.affected(p_sql text) returns bigint
language plpgsql
as $$
declare
  v_count bigint;
begin
  execute p_sql;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Switches the current transaction to an authenticated user.
create function tests.login(p_user uuid) returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

grant execute on all functions in schema tests to public;
