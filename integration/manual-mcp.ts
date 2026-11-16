// UI integration driver: this invokes the actual stdio MCP, never a fake screen or app hook.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
const tool=process.argv[2] ?? "get_human_status";
const args=process.argv[3] ? JSON.parse(process.argv[3]) : {};
const root=resolve(import.meta.dir,"..");
const home=process.env.OYOBIDASHI_HOME ?? resolve(root,".oyobidashi");
const client=new Client({name:"oyobidashi-ui-qa",version:"0.2.0"});
await client.connect(new StdioClientTransport({command:"bun",args:[resolve(root,"mcp/src/index.ts")],env:{...process.env,OYOBIDASHI_HOME:home} as Record<string,string>}));
try {const result=await client.callTool({name:tool,arguments:args});console.log(JSON.stringify(result.structuredContent ?? result,null,2));}
finally {await client.close();}
