/**
 * Classification of the peer (socket) address. The relay is LAN-only: anything that is not a private
 * address is refused, and the agent API additionally requires loopback. Unparseable input is never private.
 */

function parseIPv4(s: string): [number, number, number, number] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    // decimal only, no signs / hex / leading zeros (those are ambiguous octal in some parsers)
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

/** Expands an IPv6 literal (optionally with an embedded IPv4 tail) into 8 hextets. */
function parseIPv6(input: string): number[] | null {
  let s = input;
  if (!s.includes(":")) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, lastColon + 1);
    // "::ffff:" → keep the "::" intact, otherwise drop the separator we cut at
    if (!s.endsWith("::")) s = s.slice(0, -1);
  }
  const want = 8 - tail.length;
  const hextets = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const h of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const dbl = s.indexOf("::");
  let groups: number[];
  if (dbl === -1) {
    const all = hextets(s);
    if (!all || all.length !== want) return null;
    groups = all;
  } else {
    if (s.indexOf("::", dbl + 1) !== -1) return null;
    const head = hextets(s.slice(0, dbl));
    const rest = hextets(s.slice(dbl + 2));
    if (!head || !rest) return null;
    const fill = want - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  }
  return [...groups, ...tail];
}

type Kind = "loopback" | "private" | "public";

function classifyIPv4(a: [number, number, number, number]): Kind {
  if (a[0] === 127) return "loopback";
  if (a[0] === 10) return "private";
  if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return "private";
  if (a[0] === 192 && a[1] === 168) return "private";
  if (a[0] === 169 && a[1] === 254) return "private";
  return "public";
}

export function classifyAddress(address: unknown): Kind | "invalid" {
  if (typeof address !== "string" || address.length === 0 || address.length > 64) return "invalid";
  let s = address;
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  // zone id of a link-local address: fe80::1%en0
  const zone = s.indexOf("%");
  if (zone !== -1) {
    if (!s.includes(":") || !/^%[0-9A-Za-z_.-]+$/.test(s.slice(zone))) return "invalid";
    s = s.slice(0, zone);
  }
  if (!s.includes(":")) {
    const v4 = parseIPv4(s);
    return v4 ? classifyIPv4(v4) : "invalid";
  }
  const g = parseIPv6(s);
  if (!g) return "invalid";
  const leadingZeros = g.slice(0, 5).every((x) => x === 0);
  if (leadingZeros && g[5] === 0xffff) {
    // IPv4-mapped (::ffff:a.b.c.d): what a dual-stack socket reports for an IPv4 peer
    return classifyIPv4([g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]);
  }
  if (leadingZeros && g[5] === 0 && g[6] === 0 && g[7] === 1) return "loopback";
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return "private"; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return "private"; // fe80::/10 link-local
  return "public";
}

/** Loopback, RFC 1918, link-local, IPv6 ULA / link-local, and their IPv4-mapped forms. */
export function isPrivateAddress(address: unknown): boolean {
  const kind = classifyAddress(address);
  return kind === "loopback" || kind === "private";
}

/** 127.0.0.0/8, ::1 and the IPv4-mapped form of 127.0.0.0/8. */
export function isLoopbackAddress(address: unknown): boolean {
  return classifyAddress(address) === "loopback";
}

/** RFC 1918 only — what a phone on the same Wi-Fi can reach (used to pick the pairing URL). */
export function isLanIPv4(address: string): boolean {
  const v4 = parseIPv4(address);
  return v4 !== null && classifyIPv4(v4) === "private" && !(v4[0] === 169 && v4[1] === 254);
}
