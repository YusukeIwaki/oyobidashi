import {afterEach, beforeEach, expect, test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {saveCloudCredentials} from "../src/cloud-auth.ts";
import {connect,FakeClock,json,type Harness,type ToolCallResult} from "./helpers.ts";

let directory:string;let harness:Harness|undefined;
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),"oyobidashi-cloud-server-test-"));});
afterEach(async()=>{await harness?.close();harness=undefined;rmSync(directory,{recursive:true,force:true});});

test("real stdio MCP tool handlers share refreshed credentials across calls", async () => {
  const clock=new FakeClock();const file=join(directory,"cloud-auth.json");
  saveCloudCredentials(file,{version:1,baseUrl:"https://relay.example",apiKey:"test-public",idToken:"expired",refreshToken:"test-refresh",expiresAt:0});
  let refreshes=0;let apiCalls=0;
  harness=await connect({env:{OYOBIDASHI_HOME:directory},clock,fetch:async(url,init)=>{
    if(url.startsWith("https://securetoken.googleapis.com/")) {refreshes++;return json({id_token:"fresh",refresh_token:"rotated",expires_in:"3600"});}
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer fresh");apiCalls++;
    return json({devices:[],recent_events:[],now:"2026-11-16T00:00:00.000Z"});
  }});
  for(let i=0;i<3;i++){
    const result=await clock.run(harness.client.callTool({name:"get_human_status",arguments:{}})) as ToolCallResult;
    expect(result.structuredContent?.status).toBe("ok");expect(JSON.stringify(result)).not.toContain("test-refresh");
  }
  expect(refreshes).toBe(1);expect(apiCalls).toBe(3);expect(harness.logs).toEqual([]);
});

test("revoked Firebase refresh token produces actionable safe tool output", async () => {
  const clock=new FakeClock();saveCloudCredentials(join(directory,"cloud-auth.json"),{version:1,baseUrl:"https://relay.example",apiKey:"test-public",idToken:"expired",refreshToken:"SECRET_REFRESH",expiresAt:0});
  harness=await connect({env:{OYOBIDASHI_HOME:directory},clock,fetch:async()=>json({error:{message:"SECRET_PROVIDER"}},400)});
  const result=await clock.run(harness.client.callTool({name:"ask_human",arguments:{question:"question",wait_seconds:0}})) as ToolCallResult;
  expect(result.isError).toBe(true);expect(result.structuredContent?.error_code).toBe("cloud_auth_required");
  expect(JSON.stringify(result)).toContain("login");expect(JSON.stringify(result)).not.toContain("SECRET");expect(harness.logs.join("\n")).not.toContain("SECRET");
});

test("pairing codes stay outside the MCP tool list", async () => {
  harness=await connect({env:{OYOBIDASHI_HOME:directory,OYOBIDASHI_AGENT_TOKEN:"local"}});
  const listed=await harness.client.listTools();expect(listed.tools).toHaveLength(6);expect(listed.tools.some(tool=>/pair/i.test(tool.name))).toBe(false);
});
