import { test } from "node:test";
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { isLocalHostName, localFallbackUrl, localHostNames } from "../src/local.ts";

test("this machine's hostname is local", () => {
	assert.equal(isLocalHostName(hostname()), true);
	assert.equal(isLocalHostName(hostname().toUpperCase()), true);
	assert.ok(localHostNames().has(hostname().toLowerCase()));
	assert.equal(isLocalHostName("localhost"), true);
	assert.equal(isLocalHostName("example.invalid"), false);
});

test("localFallbackUrl retries loopback only for local HTTP hosts", () => {
	const local = localFallbackUrl(`http://${hostname()}:9000/v1`);
	assert.equal(local, "http://127.0.0.1:9000/v1");
	assert.equal(localFallbackUrl(`http://${hostname()}:9000`), "http://127.0.0.1:9000");
	assert.equal(localFallbackUrl("http://localhost:9000"), undefined);
	assert.equal(localFallbackUrl("http://127.0.0.1:9000"), undefined);
	assert.equal(localFallbackUrl("http://example.invalid:9000"), undefined);
	assert.equal(localFallbackUrl(`https://${hostname()}:9000`), undefined);
});
