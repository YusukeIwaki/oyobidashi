#!/usr/bin/env bun
import { CloudAuthError, CloudTokenProvider } from "./cloud-auth.ts";
import { resolveConnection } from "./config.ts";
import { RelayClient } from "./relay-client.ts";

/** This interactive command deliberately stays outside the MCP tool surface. */
export async function pairCloud(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CloudAuthError("cloud_auth_required", "Run cloud pairing in an interactive terminal so the one-time pairing URL is not written to logs.");
  const connection = resolveConnection(process.env);
  if (!connection.cloudAuthFile) throw new CloudAuthError("cloud_auth_required", "Sign in to the cloud first, then run cloud pairing without local endpoint/token overrides.");
  const provider = new CloudTokenProvider(connection.cloudAuthFile);
  const client = new RelayClient({baseUrl:provider.baseUrl,agentToken:"",tokenProvider:(force, signal) => provider.getToken(force, signal)});
  const pairing = await client.createPairingCode();
  const url = new URL("oyobidashi://pair");
  url.searchParams.set("url", provider.baseUrl);
  url.searchParams.set("code", pairing.code);
  process.stdout.write(`Scan or open this one-time pairing URL on your phone (expires in ten minutes):\n${url.href}\n`);
}
if (import.meta.main) {
  try { await pairCloud(); }
  catch (error) { process.stderr.write(`${error instanceof CloudAuthError ? error.message : "Cloud pairing failed. Try again after checking connectivity."}\n`); process.exitCode=1; }
}
