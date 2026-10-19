import type { Env } from "../supabase/functions/_shared/env.ts"
import type { Rpc, RpcResult } from "../supabase/functions/_shared/submitEnquiry.ts"

export function envOf(values: Record<string, string | undefined>): Env {
  return { get: (name) => values[name] }
}

export interface RpcCall {
  fn: string
  args: Record<string, unknown>
}

// Records RPC calls and answers from a per-function handler map.
export function fakeRpc(handlers: Record<string, (args: Record<string, unknown>) => RpcResult | Promise<RpcResult>>) {
  const calls: RpcCall[] = []
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args })
    const handler = handlers[fn]
    if (!handler) return { data: null, error: { message: `unexpected rpc ${fn}` } }
    return handler(args)
  }
  return { rpc, calls }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

export const silentLog = { info() {}, warn() {}, error() {} }
