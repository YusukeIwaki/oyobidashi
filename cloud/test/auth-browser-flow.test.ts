import {describe,expect,test} from "bun:test";
import type {AuthHandoff} from "../../relay/src/auth-handoff.ts";
import {
  browserAuthFailure,createAuthBrowserFlow,parsePublicAuthConfig,
  type AuthCallbackFields,type BrowserAuthSdk,type BrowserAuthUser,type PublicAuthConfig,
} from "../src/auth-browser-flow.ts";

const now=1_800_000_000_000;
const config=():PublicAuthConfig=>({firebase:{apiKey:"public-config-key",projectId:"test-project",authDomain:"test-project.firebaseapp.com"},providers:["google","apple","github"],canLinkExisting:true});
const handoff=(mode:"signin"|"link"="link",extra:Partial<AuthHandoff>={}):AuthHandoff=>({version:1,mode,callbackUrl:"http://127.0.0.1:12345/callback",state:"a".repeat(43),...(mode==="link"?{uid:"alice",customToken:"header.payload.signature"}:{}),...extra});
function user(uid="alice"){
  const reads:string[]=[];
  return {uid,refreshToken:"synthetic-refresh-token",reads,
    async getIdToken(){reads.push("id");return "synthetic-id-token";},
    async getIdTokenResult(){reads.push("expiry");return {expirationTime:new Date(now+3_600_000).toISOString()};},
  };
}
function harness(input=handoff(),settings=config()){
  const alice=user(),calls:string[]=[],submitted:{url:string;fields:AuthCallbackFields}[]=[];
  const sdk:BrowserAuthSdk<typeof alice>={
    async resetSession(){calls.push("reset");},
    async signInWithCustomToken(token){expect(token).toBe("header.payload.signature");calls.push("custom");return {user:alice};},
    async signInWithPopup(provider){calls.push(`signin:${provider}`);return {user:alice};},
    async linkWithPopup(current,provider){expect(current).toBe(alice);calls.push(`link:${provider}`);return {user:alice};},
  };
  const flow=createAuthBrowserFlow(input,settings,{sdk,now:()=>now,submit:(url,fields)=>submitted.push({url,fields})});
  return {flow,sdk,alice,calls,submitted};
}
function deferred<T>(){let resolve!:(v:T)=>void;let reject!:(e:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const providerError=(code:string)=>({code,message:"SECRET_PROVIDER_ERROR",credential:{accessToken:"SECRET_ACCESS_TOKEN"},email:"PRIVATE_EMAIL@example.com"});

describe("public Firebase browser configuration",()=>{
  test("keeps only public Firebase settings and supported providers",()=>{
    expect(parsePublicAuthConfig({...config(),unused:"PRIVATE",firebase:{...config().firebase,privateValue:"PRIVATE"},providers:["google","google","apple"]})).toEqual({...config(),providers:["google","apple"]});
  });
  test.each([null,[],{}, {firebase:{}}, {...config(),canLinkExisting:undefined},{...config(),providers:null},{...config(),providers:["google", "unknown"]},{...config(),providers:["google","apple","github","google"]},
    {...config(),firebase:{...config().firebase,apiKey:""}},{...config(),firebase:{...config().firebase,projectId:"bad/project"}},{...config(),firebase:{...config().firebase,authDomain:"evil.example/path"}},
    {...config(),firebase:{...config().firebase,authDomain:"user:password@evil.example"}},{...config(),firebase:{...config().firebase,authDomain:"evil.example?token=PRIVATE"}},
  ].map(value=>[value]))("malformed configuration fails without exposing its values: %p",value=>{
    try{parsePublicAuthConfig(value);throw new Error("expected rejection");}catch(error){expect((error as Error).message).toBe("invalid public authentication configuration");expect((error as Error).message).not.toContain("PRIVATE");}
  });
  test("only the preselected configured provider remains available",()=>{
    expect(harness(handoff("link",{provider:"google"})).flow.providers).toEqual(["google"]);
  });
  test("a preselected provider absent from server configuration never opens a popup",async()=>{
    const h=harness(handoff("link",{provider:"github"}),{...config(),providers:["google"]});
    expect((await h.flow.prepare()).status).toBe("error");expect(h.flow.providers).toEqual([]);expect(h.calls).toEqual([]);expect(h.submitted).toEqual([]);
  });
  test("disabled link support never authenticates or submits a custom token",async()=>{
    const h=harness(handoff(),{...config(),canLinkExisting:false});
    const result=await h.flow.prepare();expect(result.status).toBe("error");expect(result.retryable).toBe(false);expect(h.calls).toEqual([]);expect(h.submitted).toEqual([]);
  });
  test("invalid handoffs cannot redirect tokens to a non-loopback destination",()=>{
    expect(()=>harness(handoff("link",{callbackUrl:"https://evil.example/callback"}))).toThrow("invalid authentication handoff");
    expect(()=>harness(handoff("link",{state:"bad"}))).toThrow("invalid authentication handoff");
  });
});

describe("explicit authentication and same-UID link",()=>{
  test("sign-in first resets the existing browser session and waits for an explicit provider choice",async()=>{
    const h=harness(handoff("signin"));expect(await h.flow.prepare()).toMatchObject({status:"ready"});expect(h.calls).toEqual(["reset"]);expect(h.submitted).toEqual([]);
    const pending=h.flow.choose("google");expect(h.calls).toEqual(["reset","signin:google"]);
    expect(await pending).toMatchObject({status:"complete"});
    expect(h.submitted).toEqual([{url:"http://127.0.0.1:12345/callback",fields:{state:"a".repeat(43),id_token:"synthetic-id-token",refresh_token:"synthetic-refresh-token",expires_at:String(now+3_600_000)}}]);
  });
  test("link mode signs into the custom-token UID and links to that exact user",async()=>{
    const h=harness();expect((await h.flow.prepare()).status).toBe("ready");expect(h.calls).toEqual(["reset","custom"]);
    expect((await h.flow.choose("apple")).status).toBe("complete");expect(h.calls).toEqual(["reset","custom","link:apple"]);expect(h.submitted).toHaveLength(1);
  });
  test("mismatched custom-token UID fails closed before a popup or token read",async()=>{
    const h=harness();h.sdk.signInWithCustomToken=async()=>({user:user("bob")});
    const result=await h.flow.prepare();expect(result.status).toBe("error");expect(result.retryable).toBe(false);
    expect((await h.flow.choose("google")).status).toBe("error");expect(h.alice.reads).toEqual([]);expect(h.submitted).toEqual([]);expect(h.calls).toEqual(["reset"]);
  });
  test("a popup result with a different UID cannot send either account's tokens",async()=>{
    const h=harness(),bob=user("bob");await h.flow.prepare();h.sdk.linkWithPopup=async()=>({user:bob});
    expect((await h.flow.choose("github")).status).toBe("error");expect(bob.reads).toEqual([]);expect(h.alice.reads).toEqual([]);expect(h.submitted).toEqual([]);
  });
  test("UID is checked again after asynchronous token retrieval",async()=>{
    const h=harness();await h.flow.prepare();h.alice.getIdToken=async()=>{h.alice.uid="bob";return "synthetic-id-token";};
    expect((await h.flow.choose("google")).status).toBe("error");expect(h.submitted).toEqual([]);
  });
  test("empty UID is rejected even when token methods otherwise succeed",async()=>{
    const h=harness(handoff("signin"));await h.flow.prepare();h.alice.uid="";
    expect((await h.flow.choose("google")).status).toBe("error");expect(h.submitted).toEqual([]);
  });
  test("unconfigured provider calls cannot escape the button allowlist",async()=>{
    const h=harness(handoff(),{...config(),providers:["google"]});await h.flow.prepare();
    expect((await h.flow.choose("github")).status).toBe("error");expect(h.calls).toEqual(["reset","custom"]);expect(h.submitted).toEqual([]);
  });
});

describe("popup concurrency and recoverable errors",()=>{
  test("double-clicks share no second popup and a completed flow never submits twice",async()=>{
    const h=harness(handoff("signin"));await h.flow.prepare();const popup=deferred<{user:typeof h.alice}>();
    h.sdk.signInWithPopup=provider=>{h.calls.push(`signin:${provider}`);return popup.promise;};
    const first=h.flow.choose("google");expect(h.flow.busy).toBe(true);
    expect((await h.flow.choose("github")).status).toBe("busy");expect(h.calls).toEqual(["reset","signin:google"]);expect(h.submitted).toEqual([]);
    popup.resolve({user:h.alice});expect((await first).status).toBe("complete");expect(h.flow.busy).toBe(false);expect(h.flow.completed).toBe(true);
    expect((await h.flow.choose("apple")).status).toBe("complete");expect(h.submitted).toHaveLength(1);expect(h.calls).toEqual(["reset","signin:google"]);
  });
  test("simultaneous preparations never duplicate custom sign-in",async()=>{
    const h=harness(),custom=deferred<{user:typeof h.alice}>();let customCalls=0;
    h.sdk.signInWithCustomToken=()=>{customCalls++;return custom.promise;};
    const one=h.flow.prepare(),two=h.flow.prepare();await Promise.resolve();expect(customCalls).toBe(1);expect(h.flow.busy).toBe(true);
    expect((await h.flow.choose("google")).status).toBe("busy");custom.resolve({user:h.alice});
    expect((await one).status).toBe("ready");expect((await two).status).toBe("ready");expect(customCalls).toBe(1);expect(h.submitted).toEqual([]);
  });
  test.each(["auth/popup-closed-by-user","auth/cancelled-popup-request","auth/popup-blocked","auth/credential-already-in-use","auth/account-exists-with-different-credential","auth/operation-not-allowed","auth/network-request-failed","auth/too-many-requests"])("%s never sends a form and permits another explicit attempt",async code=>{
    const h=harness();await h.flow.prepare();h.sdk.linkWithPopup=async()=>{throw providerError(code);};
    const result=await h.flow.choose("google");expect(result.status).toBe("error");expect(result.retryable).toBe(true);expect(h.flow.busy).toBe(false);expect(h.submitted).toEqual([]);expect(JSON.stringify(result)).not.toContain("SECRET");expect(JSON.stringify(result)).not.toContain("PRIVATE");
    h.sdk.linkWithPopup=async()=>({user:h.alice});expect((await h.flow.choose("google")).status).toBe("complete");expect(h.submitted).toHaveLength(1);
  });
  test("credential-already-in-use explains recovery instead of switching users",()=>{
    const result=browserAuthFailure(providerError("auth/credential-already-in-use"));expect(result.message).toContain("別の利用者に登録済み");expect(result.message).toContain("復旧ログイン");
  });
  test("a temporary session initialization failure can be retried without a popup",async()=>{
    const h=harness();let resets=0;h.sdk.resetSession=async()=>{if(++resets===1)throw providerError("auth/network-request-failed");};
    expect((await h.flow.prepare()).retryable).toBe(true);expect(h.submitted).toEqual([]);
    expect((await h.flow.prepare()).status).toBe("ready");expect(resets).toBe(2);expect(h.calls).toEqual(["custom"]);
  });
  test("expired custom tokens require a fresh handoff and never open a provider popup",async()=>{
    const h=harness();h.sdk.signInWithCustomToken=async()=>{throw providerError("auth/invalid-custom-token");};
    expect((await h.flow.prepare()).retryable).toBe(false);expect((await h.flow.choose("google")).status).toBe("error");expect(h.submitted).toEqual([]);
  });
  test("unknown provider failures remain sanitized",async()=>{
    const h=harness(handoff("signin"));await h.flow.prepare();h.sdk.signInWithPopup=async()=>{throw new Error("SECRET_TOKEN PRIVATE_EMAIL@example.com");};
    const result=await h.flow.choose("google");expect(result.status).toBe("error");expect(result.message).not.toContain("SECRET");expect(result.message).not.toContain("PRIVATE");expect(h.submitted).toEqual([]);
  });
});

describe("callback token validation",()=>{
  test.each(["", "invalid token", "token\nheader"])("invalid ID token %p is never posted",async value=>{
    const h=harness();await h.flow.prepare();h.alice.getIdToken=async()=>value;
    expect((await h.flow.choose("google")).status).toBe("error");expect(h.submitted).toEqual([]);
  });
  test("missing refresh token is never posted",async()=>{
    const h=harness();await h.flow.prepare();h.alice.refreshToken="";
    expect((await h.flow.choose("google")).status).toBe("error");expect(h.submitted).toEqual([]);
  });
  test.each(["invalid",new Date(now).toISOString(),new Date(now-1).toISOString()])("expired or malformed expiry %s is never posted",async expirationTime=>{
    const h=harness();await h.flow.prepare();h.alice.getIdTokenResult=async()=>({expirationTime});
    expect((await h.flow.choose("google")).status).toBe("error");expect(h.submitted).toEqual([]);
  });
  test("token-read network failure is retryable and sends no form",async()=>{
    const h=harness();await h.flow.prepare();h.alice.getIdTokenResult=async()=>{throw providerError("auth/network-request-failed");};
    expect((await h.flow.choose("google")).retryable).toBe(true);expect(h.submitted).toEqual([]);
  });
  test("a failed submit is not reported as a successful navigation",async()=>{
    const alice=user();const sdk:BrowserAuthSdk<BrowserAuthUser>={async resetSession(){},async signInWithCustomToken(){return {user:alice};},async signInWithPopup(){return {user:alice};},async linkWithPopup(){return {user:alice};}};
    const flow=createAuthBrowserFlow(handoff(),config(),{sdk,now:()=>now,submit(){throw new Error("SECRET_DOM_ERROR");}});
    await flow.prepare();const result=await flow.choose("apple");expect(result.status).toBe("error");expect(result.message).not.toContain("SECRET");expect(flow.completed).toBe(false);
  });
});
