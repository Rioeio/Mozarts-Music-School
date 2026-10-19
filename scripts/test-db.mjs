#!/usr/bin/env node
// Runs the migrations and database security tests against a throwaway Postgres
// container that emulates Supabase's API roles, default grants and auth helpers.
//
//   npm run test:db                      (needs Docker)
//   DB_TEST_IMAGE=postgres:15 npm run test:db
//
// The container is removed afterwards. No hosted database is touched.
import { spawn, spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const image = process.env.DB_TEST_IMAGE || "postgres:17-alpine"
const container = `mozart-db-test-${process.pid}`
const migrationsDir = path.join(root, "supabase", "migrations")
const testsDir = path.join(root, "tests", "db")
// Legacy data is inserted just before this migration runs.
const legacySeedBefore = "20261020000003_security_hardening.sql"

function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", ...options })
}

function psql(sql, label) {
  const result = docker(
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-o", "/dev/null", "-v", "ON_ERROR_STOP=1"],
    { input: sql, maxBuffer: 64 * 1024 * 1024 },
  )
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  if (result.status !== 0) {
    throw new Error(`${label} failed:\n${output}`)
  }
  return output
}

function psqlAsync(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"])
    let out = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (out += chunk))
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(out))))
    child.stdin.end(sql)
  })
}

function file(dir, name) {
  return readFileSync(path.join(dir, name), "utf8")
}

function countOks(output) {
  return output.split(/\r?\n/).filter((line) => line.includes("ok - ")).length
}

async function concurrencyChecks() {
  const submit = `set role service_role;
select public.submit_enquiry_atomic(p_type => 'general', p_contact_name => 'Concurrent', p_email => 'race@test.local', p_phone => null, p_preferred_contact => 'email', p_instrument => null, p_learner_group => null, p_learner_name => null, p_experience => null, p_preferred_times => null, p_message => 'race', p_source => 'race', p_contact_consent => true, p_location_updates => false, p_consent_version => 'v1', p_idempotency_key => 'race-key', p_metadata => '{}', p_owner_email => 'owner@test.local');`
  const ids = await Promise.all(Array.from({ length: 8 }, () => psqlAsync(submit)))
  if (new Set(ids).size !== 1) throw new Error(`concurrent submissions returned different ids: ${ids.join(", ")}`)
  const counts = await psqlAsync(`select (select count(*) from public.enquiries where idempotency_key = 'race-key') || ',' ||
    (select count(*) from public.notification_jobs j join public.enquiries e on e.id = j.enquiry_id where e.idempotency_key = 'race-key');`)
  if (counts !== "1,2") throw new Error(`concurrent idempotent submissions produced enquiries,jobs = ${counts}`)
  console.log("ok - 8 concurrent submissions with one idempotency key create one enquiry and two jobs")

  const limit = `set role service_role; select public.check_rate_limit('race:ip', 10, 600);`
  const results = await Promise.all(Array.from({ length: 20 }, () => psqlAsync(limit)))
  const allowed = results.filter((r) => r === "t").length
  if (allowed !== 10) throw new Error(`20 concurrent requests against a limit of 10 allowed ${allowed}`)
  console.log("ok - 20 concurrent rate-limit checks allow exactly 10")

  const claim = `set role service_role; select count(*) from public.claim_notification_jobs(50, 300);`
  await psqlAsync(`update public.notification_jobs set status = 'pending', attempts = 0, next_attempt_at = now(), processing_token = null, processing_expires_at = null;`)
  const total = Number(await psqlAsync(`select count(*) from public.notification_jobs;`))
  const claimed = (await Promise.all(Array.from({ length: 6 }, () => psqlAsync(claim)))).map(Number)
  const sum = claimed.reduce((a, b) => a + b, 0)
  if (sum !== total) throw new Error(`6 concurrent workers claimed ${sum} jobs in total, expected ${total} with no duplicates`)
  console.log(`ok - 6 concurrent workers claimed ${total} jobs exactly once`)
  return 3
}

async function main() {
  if (docker(["version", "--format", "{{.Server.Version}}"]).status !== 0) {
    console.error("Docker is not running. Start Docker Desktop and retry.")
    process.exit(2)
  }

  console.log(`Starting ${image} as ${container} ...`)
  const run = docker(["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD=postgres", image])
  if (run.status !== 0) throw new Error(run.stderr)

  try {
    for (let i = 0; ; i++) {
      // pg_isready can report ready during the init restart, so require a query.
      const ready = docker(["exec", container, "psql", "-U", "postgres", "-c", "select 1"])
      if (ready.status === 0 && i > 0) break
      if (i > 60) throw new Error("Postgres did not become ready")
      await new Promise((r) => setTimeout(r, 1000))
    }

    let oks = 0
    psql(file(testsDir, "00_supabase_stub.sql"), "Supabase stub")
    const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
    for (const migration of migrations) {
      if (migration === legacySeedBefore) {
        oks += countOks(psql(file(testsDir, "10_legacy_seed.sql"), "legacy seed"))
      }
      const out = psql(file(migrationsDir, migration), `migration ${migration}`)
      console.log(`applied ${migration}`)
      for (const line of out.split(/\r?\n/)) if (/WARNING|NOTICE/.test(line) && !line.includes("ok - ")) console.log(`  ${line.trim()}`)
    }
    psql(file(testsDir, "20_seed.sql"), "seed")

    const output = psql(file(testsDir, "30_security.test.sql"), "security tests")
    oks += countOks(output)
    oks += await concurrencyChecks()
    console.log(`\nDatabase tests passed: ${oks} assertions.`)
  } finally {
    docker(["rm", "-f", container])
  }
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
