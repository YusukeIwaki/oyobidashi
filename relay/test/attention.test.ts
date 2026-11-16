import { describe, expect, test } from "bun:test";
import { makeHarness } from "./helpers.ts";
import { validateConversationResult } from "../src/conversation.ts";

const resolvedProvider = { turn: async () => ({reply:"承知しました。エージェントに伝えて電話を切ります。",resolved:true,answer:"明日10時に実施してください"}) };

async function callSetup(provider = resolvedProvider) {
  const h=makeHarness({conversation:provider});
  const a=await h.pair(); const b=await h.pair({platform:"android",device_name:"Pixel"});
  const r=await h.ask({priority:"high",delivery_mode:"call"});
  const event=(token:string,event:string,text?:string)=>h.json("POST",`/v1/requests/${r.id}/call`,{token,body:{event,text}});
  return {h,a,b,r,event};
}

describe("attention routing and feedback",()=>{
 test("short choices are actions, long context and prose are text, low priority cannot ring",async()=>{
  const h=makeHarness();
  expect((await h.ask({priority:"low"})).delivery_mode).toBe("actions");
  expect((await h.ask({context:"背景".repeat(100)})).delivery_mode).toBe("text");
  expect((await h.ask({choices:null})).delivery_mode).toBe("text");
  expect((await h.ask({priority:"low",delivery_mode:"call"})).delivery_mode).toBe("text");
 });
 test("availability is authenticated, persistent, expires and prevents calls",async()=>{
  const h=makeHarness();const d=await h.pair();
  expect((await h.agent("PUT","/v1/presence",{availability:"busy"})).status).toBe(403);
  const until=new Date(h.clock.now()+60_000).toISOString();
  expect((await h.json("PUT","/v1/presence",{token:d.token,body:{availability:"busy",until,note:"会議中"}})).status).toBe(200);
  expect((await h.ask({priority:"urgent",delivery_mode:"call"})).delivery_mode).toBe("text");
  const status=await h.agent("GET","/v1/presence");
  expect(status.body.devices[0]).toMatchObject({availability:"busy",note:"会議中",device_id:d.device.id});
  h.clock.advance(60_001);
  expect((await h.agent("GET","/v1/presence")).body.devices[0].availability).toBe("available");
  expect((await h.ask({priority:"urgent",delivery_mode:"call"})).call.state).toBe("ringing");
 });
 test("invalid priority and presence are rejected",async()=>{
  const h=makeHarness();const d=await h.pair();
  expect((await h.agent("POST","/v1/requests",{question:"q",priority:"critical"})).status).toBe(400);
  expect((await h.json("PUT","/v1/presence",{token:d.token,body:{availability:"busy",until:"yesterday"}})).status).toBe(400);
 });
 test("agent reprioritizes existing question and one-way notification can be withdrawn",async()=>{
  const h=makeHarness(); const r=await h.ask();
  const updated=await h.agent("PATCH",`/v1/requests/${r.id}`,{priority:"urgent",delivery_mode:"call"});
  expect(updated.body.request.call.state).toBe("ringing");
  const cancel=await h.agent("POST",`/v1/requests/${r.id}/cancel`);
  expect(cancel.body.request.call).toMatchObject({state:"ended",outcome:"cancelled"});
  const n=await h.ask({kind:"notification"});
  expect((await h.agent("POST",`/v1/requests/${n.id}/cancel`)).body.request.status).toBe("cancelled");
 });
});

describe("call lifecycle",()=>{
 test("only one call rings, declines fall back to text without redial",async()=>{
  const {h,a,r,event}=await callSetup();
  expect((await h.ask({priority:"urgent",delivery_mode:"call"})).delivery_mode).toBe("text");
  const declined=await event(a.token,"decline");
  expect(declined.body.request).toMatchObject({status:"pending",delivery_mode:"text",call:{state:"ended",outcome:"declined"}});
  expect((await h.agent("GET","/v1/presence")).body.recent_events[0].event).toBe("declined");
  const patch=await h.agent("PATCH",`/v1/requests/${r.id}`,{priority:"urgent",delivery_mode:"call"});
  expect(patch.body.request.delivery_mode).toBe("text");
 });
 test("first device claims call, conversation settles original request, second device cannot answer",async()=>{
  const {a,b,event}=await callSetup();
  expect((await event(a.token,"answer")).body.call.state).toBe("active");
  expect((await event(b.token,"answer")).status).toBe(409);
  const turn=await event(a.token,"turn","明日10時に実施してください");
  expect(turn.status).toBe(200);
  expect(turn.body.request).toMatchObject({status:"answered",answer:{text:"明日10時に実施してください",input_method:"voice"},call:{state:"ended",outcome:"resolved"}});
 });
 test("ring timeout and human hangup retain text request",async()=>{
  const {h,r,a,event}=await callSetup();h.clock.advance(45_001);h.app.sweep();
  expect((await h.agent("GET",`/v1/requests/${r.id}`)).body.request).toMatchObject({status:"pending",delivery_mode:"text",call:{outcome:"missed"}});
  expect((await event(a.token,"answer")).status).toBe(409);
  const other=await callSetup();await other.event(other.a.token,"answer");
  expect((await other.event(other.a.token,"hangup")).body.request).toMatchObject({status:"pending",delivery_mode:"text",call:{outcome:"hangup"}});
 });
 test("cancel while model is replying never creates an answer",async()=>{
  let finish!: (v:typeof resolvedProvider extends never ? never : any)=>void;
  const {h,r,a,event}=await callSetup({turn:()=>new Promise(resolve=>{finish=resolve;})});
  await event(a.token,"answer"); const pending=event(a.token,"turn","はい");
  while(!finish) await new Promise(r=>setTimeout(r,1));
  await h.agent("POST",`/v1/requests/${r.id}/cancel`);
  finish({reply:"承知しました",resolved:true,answer:"はい"});
  expect((await pending).status).toBe(409);
  expect((await h.agent("GET",`/v1/requests/${r.id}`)).body.request.status).toBe("cancelled");
 });
 test("provider failure leaves question open for a text answer",async()=>{
  const {a,event}=await callSetup({turn:async()=>{throw new Error("signed out");}});
  await event(a.token,"answer");expect((await event(a.token,"turn","はい")).status).toBe(503);
 });
 test("voice and regular push tokens stay independent",async()=>{
  const h=makeHarness();const d=await h.pair({push_token:"normal"});
  await h.json("PUT","/v1/devices/me",{token:d.token,body:{voip_token:"voip"}});
  expect(h.store.getDevice(d.device.id)).toMatchObject({push_token:"normal",voip_token:"voip"});
  await h.json("PUT","/v1/devices/me",{token:d.token,body:{voip_token:null}});
  expect(h.store.getDevice(d.device.id)).toMatchObject({push_token:"normal",voip_token:null});
 });
 test("malformed or invented resolution is rejected",()=>{
  expect(()=>validateConversationResult({reply:"ok",resolved:true,answer:null})).toThrow();
  expect(validateConversationResult({reply:"どちらですか？",resolved:false,answer:null}).resolved).toBe(false);
 });
});

describe("explicit remote device origin",()=>{
 test("a local TLS proxy can reach device API while agent token still cannot cross it",async()=>{
  const h=makeHarness({trustedProxyOrigin:"https://relay.example"});const d=await h.pair();
  const headers={"x-forwarded-host":"relay.example","x-forwarded-proto":"https","x-forwarded-for":"203.0.113.1"};
  expect((await h.json("GET","/v1/requests",{token:d.token,headers})).status).toBe(200);
  expect((await h.json("POST","/v1/requests",{token:"ka_test-agent-token",headers,body:{question:"q"}})).status).toBe(403);
  expect((await h.json("GET","/v1/presence",{token:"ka_test-agent-token",headers})).status).toBe(403);
  expect((await h.json("GET","/v1/requests",{token:d.token,headers:{...headers,"x-forwarded-host":"evil.example"}})).status).toBe(403);
  h.peer="192.168.1.4";
  expect((await h.json("GET","/v1/requests",{token:d.token,headers})).status).toBe(403);
 });
 test("device reads only its own persisted availability",async()=>{
  const h=makeHarness();const a=await h.pair();await h.pair();
  await h.json("PUT","/v1/presence",{token:a.token,body:{availability:"away"}});
  const status=await h.json("GET","/v1/presence",{token:a.token});
  expect(status.body.devices).toHaveLength(1);
  expect(status.body.devices[0].availability).toBe("away");
  expect(status.body.recent_events).toEqual([]);
 });
});

test("a declined call sends a visible text fallback using the ordinary push token",async()=>{
 const sent:{token:string;type:string|undefined;mode:string|undefined}[]=[];
 const h=makeHarness({push:{ios:{send:async(target,request)=>{sent.push({token:target.token,type:target.type,mode:request.delivery_mode});return {ok:true};}}}});
 const d=await h.pair({push_token:"normal"});
 await h.json("PUT","/v1/devices/me",{token:d.token,body:{voip_token:"voip"}});
 const r=await h.ask({priority:"high",delivery_mode:"call"});
 await h.json("POST",`/v1/requests/${r.id}/call`,{token:d.token,body:{event:"decline"}});
 await h.app.idle();
 expect(sent).toEqual([{token:"voip",type:"voip",mode:"call"},{token:"normal",type:undefined,mode:"text"}]);
});
