import {describe,expect,test} from "bun:test";
import {CloudAuthError} from "../src/cloud-auth.ts";
import {RelayClient,RelayError} from "../src/relay-client.ts";
import {errorResult} from "../src/results.ts";
import {FakeClock,fixture,json} from "./helpers.ts";

const sample = () => ({request:fixture("request_pending.json"), delivery:{paired_devices:1,websocket_delivered:0,push_attempted:1}});
const forbidden = () => json({error:{code:"unauthorized",message:"sign in"}},401);

describe("authenticated cloud exchanges", () => {
  test("one definitive 401 forces refresh once, including for a create mutation", async () => {
    const requests:RequestInit[]=[]; const tokens:boolean[]=[];
    const client=new RelayClient({baseUrl:"https://relay.example",agentToken:"",tokenProvider:async force=>{tokens.push(force);return force?"fresh":"expired";},fetch:async(_url,init)=>{
      requests.push(init);return requests.length===1?forbidden():json(sample(),201);
    }});
    const result=await client.createRequest({kind:"question",question:"q"});
    expect(result.request.id).toBeTruthy();expect(tokens).toEqual([false,true]);expect(requests).toHaveLength(2);
    expect(new Headers(requests[0]!.headers).get("authorization")).toBe("Bearer expired");
    expect(new Headers(requests[1]!.headers).get("authorization")).toBe("Bearer fresh");
    expect(new Headers(requests[0]!.headers).get("Idempotency-Key")).toBe(new Headers(requests[1]!.headers).get("Idempotency-Key"));
  });
  test("a repeated 401 is terminal rather than an infinite sign-in loop", async () => {
    let calls=0;let refreshes=0;const client=new RelayClient({baseUrl:"https://relay.example",agentToken:"",tokenProvider:async force=>{if(force)refreshes++;return "token";},fetch:async()=>{calls++;return forbidden();}});
    await expect(client.getPresence()).rejects.toMatchObject({status:401});expect(calls).toBe(2);expect(refreshes).toBe(1);
  });
  test("a legacy local 401 never refreshes or repeats a mutation", async () => {
    let calls=0;const client=new RelayClient({baseUrl:"http://127.0.0.1",agentToken:"ka_local",fetch:async()=>{calls++;return forbidden();}});
    await expect(client.createRequest({kind:"question",question:"q"})).rejects.toMatchObject({status:401});expect(calls).toBe(1);
  });
  test("lost cloud create response retries the same key; a subsequent create uses a different one", async () => {
    const clock=new FakeClock();const keys:string[]=[];let calls=0;
    const client=new RelayClient({baseUrl:"https://relay.example",agentToken:"",clock,tokenProvider:async()=>"id-token",fetch:async(_url,init)=>{
      calls++;keys.push(new Headers(init.headers).get("Idempotency-Key")!);
      if(calls===1)throw new Error("connection reset after commit");return json(sample(),201);
    }});
    await clock.run(client.createRequest({kind:"question",question:"q"}));
    await client.createRequest({kind:"question",question:"q2"});
    expect(keys).toHaveLength(3);expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);expect(keys[1]).toBe(keys[0]);expect(keys[2]).not.toBe(keys[0]);
    expect(clock.sleeps).toContain(250);expect(clock.pendingTimers).toBe(0);
  });
  test("lost create retries are bounded and never performed for LAN", async () => {
    const clock=new FakeClock();let calls=0;const fetch=async()=>{calls++;throw new Error("reset");};
    const cloud=new RelayClient({baseUrl:"https://relay.example",agentToken:"",clock,tokenProvider:async()=>"id-token",fetch});
    await expect(clock.run(cloud.createRequest({kind:"question",question:"q"}))).rejects.toMatchObject({kind:"network"});expect(calls).toBe(2);
    calls=0;const local=new RelayClient({baseUrl:"http://127.0.0.1",agentToken:"ka_local",fetch});
    await expect(local.createRequest({kind:"question",question:"q"})).rejects.toMatchObject({kind:"network"});expect(calls).toBe(1);
  });
  test("transient server errors do not cause ambiguous mutation replay", async () => {
    let calls=0;const client=new RelayClient({baseUrl:"https://relay.example",agentToken:"",tokenProvider:async()=>"id-token",fetch:async()=>{calls++;return json({error:{code:"internal",message:"details"}},503);}});
    await expect(client.createRequest({kind:"question",question:"q"})).rejects.toMatchObject({status:503});expect(calls).toBe(1);
  });
  test("cloud provider body and network error cannot echo authentication secrets into tool output", async () => {
    for (const failure of ["json", "html", "network"] as const) {
      const client=new RelayClient({baseUrl:"https://relay.example",agentToken:"",tokenProvider:async()=>"SECRET_BEARER",fetch:async()=>{
        if(failure==="network")throw new Error("SECRET_REFRESH connection failed");
        if(failure==="html")return new Response("SECRET_HTML",{status:500});
        return json({error:{code:"SECRET_CODE",message:"SECRET_BODY"}},403);
      }});
      let error:unknown;try{await client.getPresence();}catch(e){error=e;}
      expect(error).toBeInstanceOf(RelayError);expect(JSON.stringify(errorResult(error))).not.toContain("SECRET");
    }
  });
  test("auth failure stays an actionable auth error rather than a network error", async () => {
    let calls=0;const client=new RelayClient({baseUrl:"https://relay.example",agentToken:"",tokenProvider:async()=>{throw new CloudAuthError("cloud_auth_required");},fetch:async()=>{calls++;return json(sample());}});
    await expect(client.getPresence()).rejects.toBeInstanceOf(CloudAuthError);expect(calls).toBe(0);
  });
  test("cancellation during retry backoff prevents duplicate network activity", async () => {
    const clock=new FakeClock();const controller=new AbortController();let calls=0;
    const client=new RelayClient({baseUrl:"https://relay.example",agentToken:"",clock,tokenProvider:async()=>"id-token",fetch:async()=>{calls++;throw new Error("reset");}});
    const pending=client.createRequest({kind:"question",question:"q"},{signal:controller.signal});
    await clock.idle();controller.abort();await expect(pending).rejects.toMatchObject({name:"AbortError"});expect(calls).toBe(1);expect(clock.pendingTimers).toBe(0);
  });
  test("pairing endpoint is authenticated and does not expose a code through an MCP tool", async () => {
    const client=new RelayClient({baseUrl:"https://relay.example",agentToken:"",tokenProvider:async()=>"id-token",fetch:async(url,init)=>{
      expect(url).toBe("https://relay.example/v1/pairing-codes");expect(new Headers(init.headers).get("Authorization")).toBe("Bearer id-token");
      expect(init.redirect).toBe("error");return json({code:"test-one-time-code",expires_at:"2026-11-16T00:10:00.000Z"},201);
    }});
    expect(await client.createPairingCode()).toEqual({code:"test-one-time-code",expires_at:"2026-11-16T00:10:00.000Z"});
  });
});

test("an existing question survives a temporary Firebase refresh outage while waiting", async () => {
  const {waitForResolution}=await import("../src/wait.ts");const clock=new FakeClock();let attempts=0;
  const client=new RelayClient({baseUrl:"https://relay.example",agentToken:"",clock,tokenProvider:async()=>{
    if(++attempts===1)throw new CloudAuthError("cloud_auth_unavailable");return "valid";
  },fetch:async()=>json({request:fixture("request_answered.json")})});
  const result=await clock.run(waitForResolution(client,"req",{clock,waitSeconds:20,initial:fixture("request_pending.json")}));
  expect(result.status).toBe("answered");expect(attempts).toBe(2);expect(clock.sleeps).toContain(1000);expect(clock.pendingTimers).toBe(0);
});

test("revoked Firebase credentials do not trigger wait-loop retries", async () => {
  const {waitForResolution}=await import("../src/wait.ts");const clock=new FakeClock();let attempts=0;
  const client=new RelayClient({baseUrl:"https://relay.example",agentToken:"",clock,tokenProvider:async()=>{attempts++;throw new CloudAuthError("cloud_auth_required");}});
  await expect(waitForResolution(client,"req",{clock,waitSeconds:20,initial:fixture("request_pending.json")})).rejects.toMatchObject({code:"cloud_auth_required"});expect(attempts).toBe(1);expect(clock.pendingTimers).toBe(0);
});
