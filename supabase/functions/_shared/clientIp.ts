// Client IP for rate limiting.
//
// X-Forwarded-For is a list: every proxy appends the address it received the
// request from. A caller can put anything at the front, but cannot control the
// entries appended by proxies in front of this function. With N trusted proxies,
// the client address is the Nth entry from the right.
//
// CLIENT_IP_TRUSTED_PROXY_HOPS (default 1) sets N. Headers such as
// cf-connecting-ip or x-real-ip are ignored because a caller can set them freely
// unless a trusted proxy overwrites them.

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/
const IPV6 = /^[0-9a-f:]+$/i

function normalise(candidate: string): string | null {
  let value = candidate.trim()
  if (value.startsWith("[") && value.includes("]")) value = value.slice(1, value.indexOf("]"))
  else if (IPV4.test(value.split(":")[0]) && value.split(":").length === 2) value = value.split(":")[0]
  if (IPV4.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255) ? value : null
  }
  if (IPV6.test(value) && value.includes(":")) return value.toLowerCase()
  return null
}

export function getClientIp(headers: Headers, trustedProxyHops = 1): string | null {
  const hops = Number.isInteger(trustedProxyHops) && trustedProxyHops > 0 ? trustedProxyHops : 1
  const chain = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (chain.length < hops) return null
  return normalise(chain[chain.length - hops])
}
