import {afterEach, beforeEach, describe, expect, test} from "bun:test";
import {chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CloudAuthError, CloudTokenProvider, inspectCloudAccount, signInAnonymous, cloudBaseUrl, parseCloudCredentials, readCloudCredentials, saveCloudCredentials, signInCloud, type CloudCredentials} from "../src/cloud-auth.ts";
import {resolveConnection} from "../src/config.ts";
import {parseLoginArguments} from "../src/login.ts";
import {errorResult} from "../src/results.ts";
import {FakeClock, json} from "./helpers.ts";

let directory: string;
let path: string;
beforeEach(() => {directory=mkdtempSync(join(tmpdir(),"oyobidashi-cloud-auth-test-")); path=join(directory,"cloud-auth.json");});
afterEach(() => rmSync(directory,{recursive:true,force:true}));
const credentials = (overrides:Partial<CloudCredentials> = {}):CloudCredentials => ({version:1,baseUrl:"https://relay.example",apiKey:"test-public-key",idToken:"test-id-token",refreshToken:"test-refresh-token",expiresAt:2_000_000,...overrides});
const refreshBody = {id_token:"rotated-id",refresh_token:"rotated-refresh",expires_in:"3600"};
const identityToken=(uid:string,nonce:string)=>`header.${Buffer.from(JSON.stringify({sub:uid,nonce})).toString("base64url")}.signature`;

async function cloudError(promise:Promise<unknown>):Promise<CloudAuthError> {
  try {await promise; throw new Error("expected failure");} catch(error) {expect(error).toBeInstanceOf(CloudAuthError); return error as CloudAuthError;}
}

describe("cloud credentials and isolation", () => {
  test("atomic mode600 write keeps local settings intact and creates a private directory", () => {
    const local=join(directory,"config.json"); writeFileSync(local,"preserve-other-provider",{mode:0o600});
    const nested=join(directory,"private","cloud-auth.json");
    saveCloudCredentials(nested,credentials());
    expect(lstatSync(nested).mode&0o777).toBe(0o600);
    expect(lstatSync(join(directory,"private")).mode&0o777).toBe(0o700);
    expect(readCloudCredentials(nested)).toEqual(credentials());
    saveCloudCredentials(nested,credentials({refreshToken:"replacement"}));
    expect(readCloudCredentials(nested).refreshToken).toBe("replacement");
    expect(readFileSync(local,"utf8")).toBe("preserve-other-provider");
    expect(readdirSync(join(directory,"private"))).toEqual(["cloud-auth.json"]);
  });
  test("an existing directory's permissions are preserved", () => {
    chmodSync(directory,0o750); saveCloudCredentials(path,credentials());
    expect(lstatSync(directory).mode&0o777).toBe(0o750);
  });
  test("refuses shared-readable and symlink credentials", () => {
    saveCloudCredentials(path,credentials()); chmodSync(path,0o644);
    expect(()=>readCloudCredentials(path)).toThrow(CloudAuthError);
    const link=join(directory,"link.json"); symlinkSync(path,link);
    expect(()=>readCloudCredentials(link)).toThrow(CloudAuthError);
    expect(()=>saveCloudCredentials(link,credentials())).toThrow(CloudAuthError);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
  test("failed validation/write never truncates existing credentials or exposes secrets", () => {
    saveCloudCredentials(path,credentials()); const before=readFileSync(path,"utf8");
    expect(()=>saveCloudCredentials(path,credentials({expiresAt:NaN}))).toThrow(CloudAuthError);
    expect(readFileSync(path,"utf8")).toBe(before);
    mkdirSync(join(directory,"blocked"));
    expect(()=>saveCloudCredentials(join(directory,"blocked"),credentials())).toThrow(CloudAuthError);
    expect(readdirSync(directory).some(name=>name.endsWith(".tmp"))).toBe(false);
  });
  test.each([null,[],{}, {version:1}, credentials({idToken:"token\nheader"}), credentials({expiresAt:-1}), credentials({projectId:"bad/project"})].map(value => [value]))("malformed credentials fail closed: %p", value => {
    expect(()=>parseCloudCredentials(value)).toThrow(CloudAuthError);
  });
  test.each(["http://relay.example", "https://u:password@relay.example", "https://relay.example?token=secret", "https://relay.example/#fragment", "https://relay.example/path", "ftp://relay.example", "not-a-url"])('refuses unsafe cloud URL %s', value => {
    expect(()=>cloudBaseUrl(value)).toThrow(CloudAuthError);
  });
  test("permits HTTPS origins and HTTP loopback for local verification", () => {
    expect(cloudBaseUrl("https://relay.example/")).toBe("https://relay.example");
    expect(cloudBaseUrl("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234");
    expect(cloudBaseUrl("http://[::1]:1234")).toBe("http://[::1]:1234");
  });
  test("cloud default coexists with local configuration; explicit local settings win", () => {
    saveCloudCredentials(path,credentials()); writeFileSync(join(directory,"config.json"),JSON.stringify({port:9911,agent_token:"ka_local"}),{mode:0o600});
    expect(resolveConnection({OYOBIDASHI_HOME:directory})).toMatchObject({baseUrl:"https://relay.example",cloudAuthFile:path,source:{agentToken:"cloud",baseUrl:"cloud"}});
    expect(resolveConnection({OYOBIDASHI_HOME:directory,OYOBIDASHI_AGENT_TOKEN:"ka_override"})).toMatchObject({baseUrl:"http://127.0.0.1:9911",agentToken:"ka_override"});
    expect(resolveConnection({OYOBIDASHI_HOME:directory,OYOBIDASHI_RELAY_URL:"http://127.0.0.1:22"})).toMatchObject({baseUrl:"http://127.0.0.1:22",agentToken:"ka_local"});
  });
  test("explicit missing cloud file never silently falls back to a local account", () => {
    writeFileSync(join(directory,"config.json"),JSON.stringify({agent_token:"ka_local"}),{mode:0o600});
    expect(()=>resolveConnection({OYOBIDASHI_HOME:directory,OYOBIDASHI_CLOUD_AUTH_FILE:join(directory,"missing")})).toThrow(CloudAuthError);
  });
  test("CLI arguments never accept passwords or email as argv", () => {
    expect(()=>parseLoginArguments(["--password","secret"])).toThrow(CloudAuthError);
    expect(()=>parseLoginArguments(["--email","somebody@example.com"])).toThrow(CloudAuthError);
    expect(()=>parseLoginArguments(["--url"])).toThrow(CloudAuthError);
    expect(parseLoginArguments(["--url","https://relay.example","--api-key","public"],{OYOBIDASHI_HOME:directory})).toMatchObject({authFile:path,apiKey:"public"});
  });
});

describe("Firebase refresh and login", () => {
  test("an account replaced before expiry refresh is not silently adopted",async()=>{
    saveCloudCredentials(path,credentials({idToken:identityToken("alice","old"),expiresAt:0}));let calls=0;
    const provider=new CloudTokenProvider(path,{fetch:async()=>{calls++;return json(refreshBody);}});
    saveCloudCredentials(path,credentials({idToken:identityToken("bob","new"),refreshToken:"bob-refresh",expiresAt:Date.now()+3600_000}));
    expect((await cloudError(provider.getToken())).code).toBe("cloud_auth_required");expect(calls).toBe(0);
    expect(readCloudCredentials(path).idToken).toBe(identityToken("bob","new"));
  });
  test("a refresh response with a different account cannot replace the credential file",async()=>{
    const old=identityToken("alice","old");saveCloudCredentials(path,credentials({idToken:old,expiresAt:0}));
    const provider=new CloudTokenProvider(path,{fetch:async()=>json({...refreshBody,id_token:identityToken("bob","wrong")})});
    expect((await cloudError(provider.getToken())).code).toBe("cloud_auth_required");expect(readCloudCredentials(path).idToken).toBe(old);
  });
  test("another process's valid refresh for the same UID is reused without another network call",async()=>{
    saveCloudCredentials(path,credentials({idToken:identityToken("alice","old"),expiresAt:0}));let calls=0;
    const provider=new CloudTokenProvider(path,{fetch:async()=>{calls++;return json(refreshBody);}});
    const next=identityToken("alice","new");saveCloudCredentials(path,credentials({idToken:next,refreshToken:"rotated-by-another-process",expiresAt:Date.now()+3600_000}));
    expect(await provider.getToken()).toBe(next);expect(calls).toBe(0);
  });
  test("two MCP processes refreshing together converge on the same account without corrupting login",async()=>{
    saveCloudCredentials(path,credentials({idToken:identityToken("alice","old"),expiresAt:0}));let finish!:(r:Response)=>void;
    const provider=new CloudTokenProvider(path,{fetch:()=>new Promise(resolve=>{finish=resolve;})});
    const pending=provider.getToken();while(!finish)await Bun.sleep(1);
    const next=identityToken("alice","other-process");saveCloudCredentials(path,credentials({idToken:next,refreshToken:"other-process-refresh",expiresAt:Date.now()+3600_000}));
    finish(json({...refreshBody,id_token:identityToken("alice","own-refresh")}));expect(await pending).toBe(next);expect(readCloudCredentials(path).idToken).toBe(next);
  });
  test("an account switch during an identified refresh is rejected without overwriting the new login",async()=>{
    saveCloudCredentials(path,credentials({idToken:identityToken("alice","old"),expiresAt:0}));let finish!:(r:Response)=>void;
    const provider=new CloudTokenProvider(path,{fetch:()=>new Promise(resolve=>{finish=resolve;})});
    const pending=provider.getToken();while(!finish)await Bun.sleep(1);
    const next=identityToken("bob","new-login");saveCloudCredentials(path,credentials({idToken:next,refreshToken:"bob-refresh",expiresAt:Date.now()+3600_000}));
    finish(json({...refreshBody,id_token:identityToken("alice","late")}));expect((await cloudError(pending)).code).toBe("cloud_auth_required");expect(readCloudCredentials(path).idToken).toBe(next);
  });
  test("a forced 401 refresh still goes to Firebase after another process refreshed the same account",async()=>{
    saveCloudCredentials(path,credentials({idToken:identityToken("alice","old"),expiresAt:0}));let calls=0;
    const final=identityToken("alice","forced");const provider=new CloudTokenProvider(path,{fetch:async()=>{calls++;return json({...refreshBody,id_token:final});}});
    saveCloudCredentials(path,credentials({idToken:identityToken("alice","new"),refreshToken:"new-refresh",expiresAt:Date.now()+3600_000}));
    expect(await provider.getToken(true)).toBe(final);expect(calls).toBe(1);
  });
  test("cached tokens require no network calls", async () => {
    const clock=new FakeClock(); saveCloudCredentials(path,credentials()); let calls=0;
    const provider=new CloudTokenProvider(path,{clock,fetch:async()=>{calls++;return json(refreshBody);}});
    expect(await provider.getToken()).toBe("test-id-token"); expect(await provider.getToken()).toBe("test-id-token"); expect(calls).toBe(0);
  });
  test("expired tokens refresh once across concurrent callers and rotate atomically", async () => {
    const clock=new FakeClock(); saveCloudCredentials(path,credentials({expiresAt:clock.now()})); let calls=0;
    let finish!:(r:Response)=>void;
    const provider=new CloudTokenProvider(path,{clock,fetch:async(url,init)=>{
      calls++;expect(url).toBe("https://securetoken.googleapis.com/v1/token?key=test-public-key");
      expect(init.redirect).toBe("error"); expect(new URLSearchParams(String(init.body)).get("refresh_token")).toBe("test-refresh-token");
      return new Promise(resolve=>{finish=resolve;});
    }});
    const pending=Array.from({length:8},()=>provider.getToken());
    await clock.idle(); expect(calls).toBe(1); finish(json(refreshBody));
    expect(await Promise.all(pending)).toEqual(Array(8).fill("rotated-id"));
    expect(readCloudCredentials(path)).toMatchObject({idToken:"rotated-id",refreshToken:"rotated-refresh",expiresAt:clock.now()+3_600_000});
    expect(await provider.getToken()).toBe("rotated-id");expect(calls).toBe(1);expect(clock.pendingTimers).toBe(0);
  });
  test("one caller cancellation does not cancel refresh needed by other callers", async () => {
    const clock=new FakeClock();saveCloudCredentials(path,credentials({expiresAt:0}));let finish!:(r:Response)=>void;
    const provider=new CloudTokenProvider(path,{clock,fetch:()=>new Promise(resolve=>{finish=resolve;})});
    const controller=new AbortController();const a=provider.getToken(false,controller.signal);const b=provider.getToken();
    controller.abort();await expect(a).rejects.toMatchObject({name:"AbortError"});finish(json(refreshBody));expect(await b).toBe("rotated-id");
    expect(clock.pendingTimers).toBe(0);
  });
  test("an already cancelled request never starts refresh", async () => {
    saveCloudCredentials(path,credentials({expiresAt:0}));let calls=0;const provider=new CloudTokenProvider(path,{fetch:async()=>{calls++;return json(refreshBody);}});
    const c=new AbortController();c.abort();await expect(provider.getToken(false,c.signal)).rejects.toMatchObject({name:"AbortError"});expect(calls).toBe(0);
  });
  test("transport hangs are bounded even when abort is ignored", async () => {
    const clock=new FakeClock();saveCloudCredentials(path,credentials({expiresAt:0}));
    const provider=new CloudTokenProvider(path,{clock,timeoutMs:25,fetch:()=>new Promise(()=>{})});
    const error=await clock.run(cloudError(provider.getToken()));expect(error.code).toBe("cloud_auth_unavailable");
    expect(readCloudCredentials(path).refreshToken).toBe("test-refresh-token");expect(clock.pendingTimers).toBe(0);
  });
  test("hanging response bodies are bounded", async () => {
    const clock=new FakeClock();saveCloudCredentials(path,credentials({expiresAt:0}));
    const provider=new CloudTokenProvider(path,{clock,timeoutMs:25,fetch:async()=>new Response(new ReadableStream({start(){}}))});
    expect((await clock.run(cloudError(provider.getToken()))).code).toBe("cloud_auth_unavailable");
  });
  test.each([400,401,403,429,500,503,302])("HTTP %i preserves credentials and returns no provider data", async status => {
    saveCloudCredentials(path,credentials({expiresAt:0})); const before=readFileSync(path,"utf8");
    const provider=new CloudTokenProvider(path,{fetch:async()=>new Response("SUPER_SECRET_PROVIDER_RESPONSE",{status})});
    const error=await cloudError(provider.getToken());expect(error.message).not.toContain("SUPER_SECRET");
    expect(error.code).toBe(status>=500||status===429?"cloud_auth_unavailable":"cloud_auth_required");expect(readFileSync(path,"utf8")).toBe(before);
  });
  test("a failed refresh is not permanently memoized", async () => {
    saveCloudCredentials(path,credentials({expiresAt:0}));let calls=0;const provider=new CloudTokenProvider(path,{fetch:async()=>++calls===1?new Response(null,{status:503}):json(refreshBody)});
    await cloudError(provider.getToken());expect(await provider.getToken()).toBe("rotated-id");expect(calls).toBe(2);
  });
  test.each([{},null,[],{...refreshBody,expires_in:"NaN"},{...refreshBody,expires_in:"0"},{...refreshBody,id_token:""},{...refreshBody,refresh_token:null}].map(value => [value]))("malformed refresh does not corrupt the file: %p", async body => {
    saveCloudCredentials(path,credentials({expiresAt:0}));const before=readFileSync(path,"utf8");
    const provider=new CloudTokenProvider(path,{fetch:async()=>json(body)});
    expect((await cloudError(provider.getToken())).code).toBe("cloud_auth_invalid");expect(readFileSync(path,"utf8")).toBe(before);
  });
  test("project binding is checked when provisioned", async () => {
    saveCloudCredentials(path,credentials({expiresAt:0,projectId:"expected-project"}));
    const provider=new CloudTokenProvider(path,{fetch:async()=>json({...refreshBody,project_id:"wrong-project"})});
    expect((await cloudError(provider.getToken())).code).toBe("cloud_auth_invalid");
  });
  test("Firebase numeric project number differs from the JWT audience project ID", async () => {
    const token=(project:string,nonce:string)=>`header.${Buffer.from(JSON.stringify({sub:"alice",aud:project,nonce})).toString("base64url")}.signature`;
    saveCloudCredentials(path,credentials({expiresAt:0,projectId:"expected-project",idToken:token("expected-project","old")}));
    const next=token("expected-project","new");
    const provider=new CloudTokenProvider(path,{fetch:async()=>json({...refreshBody,id_token:next,project_id:"1234567890"})});
    expect(await provider.getToken()).toBe(next);
    expect(readCloudCredentials(path).idToken).toBe(next);
  });
  test("a different JWT audience is rejected even if project_id equals the configured project", async () => {
    const next=`header.${Buffer.from(JSON.stringify({sub:"alice",aud:"other-project"})).toString("base64url")}.signature`;
    saveCloudCredentials(path,credentials({expiresAt:0,projectId:"expected-project"}));
    const before=readFileSync(path,"utf8");
    const provider=new CloudTokenProvider(path,{fetch:async()=>json({...refreshBody,id_token:next,project_id:"expected-project"})});
    expect((await cloudError(provider.getToken())).code).toBe("cloud_auth_invalid");
    expect(readFileSync(path,"utf8")).toBe(before);
  });
  test("login posts password only to Firebase and does not persist it", async () => {
    const clock=new FakeClock();
    const value=await signInCloud({baseUrl:"https://relay.example",apiKey:"public/key",email:" user@example.com ",password:"never-save-this"},{clock,fetch:async(url,init)=>{
      expect(url).toBe("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=public%2Fkey");expect(init.redirect).toBe("error");
      expect(JSON.parse(String(init.body))).toEqual({email:"user@example.com",password:"never-save-this",returnSecureToken:true});
      return json({idToken:"signed-in-id",refreshToken:"signed-in-refresh",expiresIn:"3600"});
    }});
    saveCloudCredentials(path,value);expect(readFileSync(path,"utf8")).not.toContain("never-save-this");expect(value.expiresAt).toBe(clock.now()+3_600_000);
  });
  test("auth errors in MCP tool results are safe and actionable", () => {
    const result=errorResult(new CloudAuthError("cloud_auth_required"));
    expect(JSON.stringify(result)).toContain("cloud_auth_required");expect(JSON.stringify(result)).toContain("login");
    expect(existsSync(path)).toBe(false);
  });
});

test("a concurrent new login is never overwritten by an old refresh", async () => {
  const clock=new FakeClock();saveCloudCredentials(path,credentials({expiresAt:0}));let finish!:(r:Response)=>void;
  const provider=new CloudTokenProvider(path,{clock,fetch:()=>new Promise(resolve=>{finish=resolve;})});
  const pending=provider.getToken();await clock.idle();
  saveCloudCredentials(path,credentials({idToken:"new-login",refreshToken:"new-user-refresh"}));
  finish(json(refreshBody));expect((await cloudError(pending)).code).toBe("cloud_auth_required");
  expect(readCloudCredentials(path).idToken).toBe("new-login");
});

test("broken authentication response streams cannot leak raw provider errors", async () => {
  saveCloudCredentials(path,credentials({expiresAt:0}));
  const provider=new CloudTokenProvider(path,{fetch:async()=>new Response(new ReadableStream({start(controller){controller.error(new Error("SECRET_STREAM_FAILURE"));}}))});
  const error=await cloudError(provider.getToken());expect(error.code).toBe("cloud_auth_unavailable");
  expect(JSON.stringify(errorResult(error))).not.toContain("SECRET");
});

test("oversized credentials and authentication bodies are rejected without corruption", async () => {
  saveCloudCredentials(path,credentials({expiresAt:0}));const before=readFileSync(path,"utf8");
  const provider=new CloudTokenProvider(path,{fetch:async()=>new Response("x".repeat(128*1024+1))});
  expect((await cloudError(provider.getToken())).code).toBe("cloud_auth_invalid");expect(readFileSync(path,"utf8")).toBe(before);
  writeFileSync(path,"x".repeat(128*1024+1),{mode:0o600});expect(()=>readCloudCredentials(path)).toThrow(CloudAuthError);
});

describe("anonymous Firebase REST sign-in", () => {
  test("sends only returnSecureToken and preserves the version1 credential format", async () => {
    const clock=new FakeClock();let calls=0;
    const value=await signInAnonymous({baseUrl:"https://relay.example/",apiKey:"public/key",projectId:"test-project"},{clock,fetch:async(url,init)=>{
      calls++;expect(url).toBe("https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=public%2Fkey");
      expect(init.method).toBe("POST");expect(init.redirect).toBe("error");expect(new Headers(init.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init.body))).toEqual({returnSecureToken:true});
      return json({idToken:"anonymous-id",refreshToken:"anonymous-refresh",expiresIn:"3600",localId:"anonymous-uid",email:""});
    }});
    expect(value).toEqual({version:1,baseUrl:"https://relay.example",apiKey:"public/key",idToken:"anonymous-id",refreshToken:"anonymous-refresh",expiresAt:clock.now()+3_600_000,projectId:"test-project"});
    expect(calls).toBe(1);expect(clock.pendingTimers).toBe(0);expect(existsSync(path)).toBe(false);
  });
  test("supports anonymous sign-in without an optional projectId", async () => {
    const result=await signInAnonymous({baseUrl:"https://relay.example",apiKey:"test-public"},{fetch:async()=>json({idToken:"anonymous-id",refreshToken:"anonymous-refresh",expiresIn:3600})});
    expect(result.version).toBe(1);expect(result.projectId).toBeUndefined();expect(Object.keys(result).sort()).toEqual(["apiKey","baseUrl","expiresAt","idToken","refreshToken","version"]);
  });
  test.each([
    {},{idToken:"id"},{idToken:"id",refreshToken:"refresh"},{idToken:"",refreshToken:"refresh",expiresIn:"3600"},
    {idToken:"id",refreshToken:null,expiresIn:"3600"},{idToken:"id",refreshToken:"refresh",expiresIn:"0"},
    {idToken:"id",refreshToken:"refresh",expiresIn:"NaN"},{idToken:"id",refreshToken:"refresh",expiresIn:"86401"},
  ].map(value=>[value]))("incomplete anonymous credentials fail closed: %p", async value => {
    const error=await cloudError(signInAnonymous({baseUrl:"https://relay.example",apiKey:"public"},{fetch:async()=>json(value)}));
    expect(error.code).toBe("cloud_auth_invalid");expect(existsSync(path)).toBe(false);
  });
  test.each([
    {baseUrl:"http://remote.example",apiKey:"public"}, {baseUrl:"https://relay.example",apiKey:""},
    {baseUrl:"https://relay.example",apiKey:"has whitespace"}, {baseUrl:"https://relay.example",apiKey:"public",projectId:"bad/project"},
  ])("invalid local input never creates an anonymous account: %p", async input => {
    let calls=0;await cloudError(signInAnonymous(input,{fetch:async()=>{calls++;return json({});}}));expect(calls).toBe(0);
  });
  test.each([[401,"cloud_auth_required"],[429,"cloud_auth_unavailable"],[503,"cloud_auth_unavailable"]] as const)("HTTP %i is safely classified as %s", async(status,code)=>{
    const error=await cloudError(signInAnonymous({baseUrl:"https://relay.example",apiKey:"public"},{fetch:async()=>json({error:{message:"SECRET_ANONYMOUS_ERROR"}},Number(status))}));
    expect(error.code).toBe(code);expect(error.message).not.toContain("SECRET");expect(existsSync(path)).toBe(false);
  });
  test("a network failure is safe and does not save partial credentials", async () => {
    const error=await cloudError(signInAnonymous({baseUrl:"https://relay.example",apiKey:"public"},{fetch:async()=>{throw new Error("SECRET_NETWORK_ERROR");}}));
    expect(error.code).toBe("cloud_auth_unavailable");expect(error.message).not.toContain("SECRET");expect(existsSync(path)).toBe(false);
  });
  test("a stalled sign-up has a bounded deadline without leaking a timer", async () => {
    const clock=new FakeClock();
    const error=await clock.run(cloudError(signInAnonymous({baseUrl:"https://relay.example",apiKey:"public"},{clock,timeoutMs:25,fetch:()=>new Promise(()=>{})})));
    expect(error.code).toBe("cloud_auth_unavailable");expect(clock.pendingTimers).toBe(0);
  });
});

describe("Firebase account inspection", () => {
  const token=(payload:unknown)=>`header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
  test("reports linked provider IDs and UID without returning email or other profile data", async () => {
    const stored=credentials({idToken:token({sub:"alice"})});let calls=0;
    const value=await inspectCloudAccount(stored,{fetch:async(url,init)=>{
      calls++;expect(url).toBe("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=test-public-key");expect(init.method).toBe("POST");expect(init.redirect).toBe("error");
      expect(JSON.parse(String(init.body))).toEqual({idToken:stored.idToken});
      return json({users:[{localId:"alice",email:"PRIVATE_EMAIL@example.com",displayName:"PRIVATE_NAME",photoUrl:"https://private.example/photo",passwordHash:"PRIVATE_HASH",providerUserInfo:[
        {providerId:"password",email:"PRIVATE_EMAIL@example.com"},{providerId:"google.com",federatedId:"PRIVATE_ID"},{providerId:"github.com"},{providerId:"apple.com"},{providerId:"google.com"},
      ]}]});
    }});
    expect(value).toEqual({uid:"alice",providers:["password","google.com","github.com","apple.com"],anonymous:false});expect(calls).toBe(1);
    expect(JSON.stringify(value)).not.toContain("PRIVATE");expect(Object.keys(value).sort()).toEqual(["anonymous","providers","uid"]);expect(existsSync(path)).toBe(false);
  });
  test.each([[],undefined].map(value=>[value]))("empty/omitted provider metadata represents an anonymous identity: %p", async providerUserInfo => {
    const account={localId:"alice",...(providerUserInfo===undefined?{}:{providerUserInfo})};
    expect(await inspectCloudAccount(credentials({idToken:token({sub:"alice"})}),{fetch:async()=>json({users:[account]})})).toEqual({uid:"alice",providers:[],anonymous:true});
  });
  test("preserves safe provider identifiers beyond the four default choices", async () => {
    expect(await inspectCloudAccount(credentials(),{fetch:async()=>json({users:[{localId:"alice",providerUserInfo:[{providerId:"oidc.work-account"}]}]})})).toEqual({uid:"alice",providers:["oidc.work-account"],anonymous:false});
  });
  test("existing protected opaque test credentials can be inspected when no subject is embedded", async () => {
    expect((await inspectCloudAccount(credentials(),{fetch:async()=>json({users:[{localId:"alice",providerUserInfo:[]}]})})).uid).toBe("alice");
    expect((await inspectCloudAccount(credentials({idToken:token({aud:"test-project"})}),{fetch:async()=>json({users:[{localId:"alice",providerUserInfo:[]}]})})).uid).toBe("alice");
  });
  test("UID mismatch never rebinds protected credentials to a different user", async () => {
    const stored=credentials({idToken:token({sub:"alice"})});saveCloudCredentials(path,stored);const before=readFileSync(path,"utf8");
    expect((await cloudError(inspectCloudAccount(stored,{fetch:async()=>json({users:[{localId:"bob",providerUserInfo:[]}]})}))).code).toBe("cloud_auth_invalid");
    expect(readFileSync(path,"utf8")).toBe(before);
  });
  test.each([null,[],{}, {users:null},{users:{}},{users:[]},{users:[{localId:"alice"},{localId:"bob"}]},{users:[null]},{users:[[]]},{users:[{}]},
    {users:[{localId:""}]},{users:[{localId:123}]},{users:[{localId:"x".repeat(129)}]},{users:[{localId:"unsafe\nuid"}]},
  ].map(value=>[value]))("missing or malformed account results fail closed: %p", async value => {
    expect((await cloudError(inspectCloudAccount(credentials(),{fetch:async()=>json(value)}))).code).toBe("cloud_auth_invalid");
  });
  test.each([null,{},"google.com",[null],[[]],[{}],[{providerId:""}],[{providerId:123}],[{providerId:"google.com\nunsafe"}],[{providerId:"user@example.com"}],[{providerId:"x".repeat(129)}]].map(value=>[value]))("malformed present provider arrays/members fail closed: %p", async providerUserInfo => {
    expect((await cloudError(inspectCloudAccount(credentials(),{fetch:async()=>json({users:[{localId:"alice",providerUserInfo}]})}))).code).toBe("cloud_auth_invalid");
  });
  test.each([123,null,"",[],{uid:"alice"}].map(value=>[value]))("a present malformed token subject cannot bypass UID binding: %p", async sub => {
    expect((await cloudError(inspectCloudAccount(credentials({idToken:token({sub})}),{fetch:async()=>json({users:[{localId:"alice",providerUserInfo:[]}]})}))).code).toBe("cloud_auth_invalid");
  });
  test.each([[401,"cloud_auth_required"],[429,"cloud_auth_unavailable"],[503,"cloud_auth_unavailable"]] as const)("lookup HTTP %i is safely classified as %s", async(status,code)=>{
    const error=await cloudError(inspectCloudAccount(credentials(),{fetch:async()=>json({error:{message:"SECRET_LOOKUP_TOKEN"}},Number(status))}));
    expect(error.code).toBe(code);expect(JSON.stringify(errorResult(error))).not.toContain("SECRET");
  });
  test("lookup network errors are sanitized and preserve saved credentials", async () => {
    const stored=credentials();saveCloudCredentials(path,stored);const before=readFileSync(path,"utf8");
    const error=await cloudError(inspectCloudAccount(stored,{fetch:async()=>{throw new Error("SECRET_SOCKET_ERROR");}}));
    expect(error.code).toBe("cloud_auth_unavailable");expect(error.message).not.toContain("SECRET");expect(readFileSync(path,"utf8")).toBe(before);
  });
  test("a hanging lookup response is bounded and releases its timer", async () => {
    const clock=new FakeClock();const error=await clock.run(cloudError(inspectCloudAccount(credentials(),{clock,timeoutMs:25,fetch:()=>new Promise(()=>{})})));
    expect(error.code).toBe("cloud_auth_unavailable");expect(clock.pendingTimers).toBe(0);
  });
});
