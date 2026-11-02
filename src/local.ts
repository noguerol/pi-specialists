/**
 * Local-host detection used by the loopback fallback.
 *
 * Services on this machine often bind only to 127.0.0.1 (llama-server,
 * FastAPI sidecars). A request to the machine's own Tailscale/MagicDNS name
 * (`my-host`) goes to the tailnet interface instead of loopback and is refused.
 * When the configured host is this machine, the router retries the same port
 * on 127.0.0.1 before reporting a network error. Remote hosts never fall back.
 */

import { hostname, networkInterfaces } from "node:os";

let cachedNames: Set<string> | undefined;

/** Hostnames and interface addresses that identify this machine. */
export function localHostNames(): Set<string> {
	if (cachedNames) return cachedNames;
	const names = new Set<string>(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"]);
	const host = hostname().toLowerCase();
	names.add(host);
	names.add(host.split(".")[0]);
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) names.add(address.address.toLowerCase());
	}
	cachedNames = names;
	return names;
}

export function isLocalHostName(host: string): boolean {
	const clean = host.replace(/^\[|\]$/g, "").toLowerCase();
	if (!clean) return false;
	const names = localHostNames();
	if (names.has(clean)) return true;
	// MagicDNS FQDN such as my-host.tailnet.ts.net or node.example.com: match the
	// local hostname as the first label. A remote host with the same first
	// label is possible but rare; only loopback is retried, never forwarded.
	const short = clean.split(".")[0];
	return names.has(short);
}

/**
 * Loopback URL to retry when `raw` points at this machine over HTTP but is not
 * already loopback. Returns undefined for remote hosts, HTTPS and loopback.
 */
export function localFallbackUrl(raw: string): string | undefined {
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:") return undefined;
		const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
		if (host === "localhost" || host === "127.0.0.1" || host === "::1") return undefined;
		if (!isLocalHostName(host)) return undefined;
		url.hostname = "127.0.0.1";
		return url.toString().replace(/\/$/, "");
	} catch {
		return undefined;
	}
}
