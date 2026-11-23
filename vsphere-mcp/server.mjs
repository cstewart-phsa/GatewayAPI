import readline from "node:readline";
import { VsphereClient } from "./src/vsphere-client.mjs";
const client = new VsphereClient();
const entries = [
  ["vsphere_connection_status","Confirm connectivity and product version across all configured vCenters",{},()=>client.connectionStatusAll()],
  ["vsphere_inventory_summary","Return combined inventory counts across all configured vCenters",{},()=>client.inventorySummaryAll()],
  ["vsphere_list_vms","List virtual machines from all configured vCenters",{},()=>client.listAllVms()],
  ["vsphere_get_vm","Get one virtual machine by VM id, exact or short inventory name, or FQDN; searches all configured vCenters",{vm:{type:"string",description:"VM id (vm-123), exact or short inventory name, or FQDN"}},({vm})=>client.getVm(vm)],
  ["vsphere_list_hosts","List ESXi hosts from all configured vCenters",{},()=>client.listAllHosts()],
  ["vsphere_list_clusters","List clusters from all configured vCenters",{},()=>client.listAllClusters()],
  ["vsphere_list_datastores","List datastores from all configured vCenters",{},()=>client.listAllDatastores()],
  ["vsphere_list_networks","List networks from all configured vCenters",{},()=>client.listAllNetworks()],
  ["vsphere_list_datacenters","List datacenter objects from all configured vCenters",{},()=>client.listAllDatacenters()],
  ["vsphere_list_tags","List vSphere tags (with category) across all configured vCenters, with how many VMs and objects each tag is attached to",{
    category:{type:"string",description:"Only tags in this category (case-insensitive exact match)"},
    tag_prefix:{type:"string",description:"Only tags whose name starts with this (case-insensitive), e.g. 'Bkp_'"}
  },(args)=>client.listTagsAll(args)],
  ["vsphere_list_vm_tags","List VMs with their vSphere tags across all configured vCenters. Filter by category, exact tag or tag-name prefix; set without=true to list VMs that have NO matching tag (e.g. VMs without a backup tag). Returns totals and per-vCenter counts.",{
    category:{type:"string",description:"Tag category to match (case-insensitive exact match)"},
    tag:{type:"string",description:"Tag name to match (case-insensitive exact match)"},
    tag_prefix:{type:"string",description:"Tag-name prefix to match (case-insensitive), e.g. 'Bkp_'"},
    without:{type:"boolean",description:"Return VMs that have no matching tag instead of VMs that have one"},
    vcenter:{type:"string",description:"Only vCenters whose URL contains this text, e.g. 'vapvc701'"},
    limit:{type:"integer",minimum:1,description:"Return at most this many VMs (counts still cover all matches)"}
  },(args)=>client.listVmTagsAll(args)],
  ["vsphere_list_vm_details","List VMs with creation date, datacenter, cluster, host, folder, guest OS/hostname/IP, CPU, memory, storage and annotation (vCenter VI/JSON API, vSphere 8.0 U1+). Templates are excluded unless include_templates=true.",{
    vcenter:{type:"string",description:"Only vCenters whose URL contains this text, e.g. 'vapvc701'"},
    datacenter:{type:"string",description:"Datacenter name (case-insensitive exact match), e.g. 'KDC'"},
    cluster:{type:"string",description:"Cluster name (case-insensitive exact match)"},
    name_contains:{type:"string",description:"Only VMs whose name contains this text (case-insensitive)"},
    created_after:{type:"string",description:"Only VMs created at or after this ISO 8601 date/time, e.g. '2026-10-23'"},
    created_before:{type:"string",description:"Only VMs created before this ISO 8601 date/time"},
    include_templates:{type:"boolean",description:"Include VM templates (default false)"},
    limit:{type:"integer",minimum:1,description:"Return at most this many VMs (count still covers all matches)"}
  },(args)=>client.listVmDetailsAll(args)]
];
const requiredArgs={vsphere_get_vm:["vm"]};
const handlers=new Map(entries.map(([name,,,fn])=>[name,fn]));
const definitions=entries.map(([name,description,properties])=>({name,description,inputSchema:{type:"object",properties,additionalProperties:false,required:requiredArgs[name]??[]},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}}));
const send=value=>process.stdout.write(`${JSON.stringify(value)}\n`);
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",async line=>{let m;try{m=JSON.parse(line)}catch{return}if(!Object.hasOwn(m,"id"))return;try{if(m.method==="initialize")return send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"cstorage-vsphere-readonly",version:"1.0.0"}}});if(m.method==="tools/list")return send({jsonrpc:"2.0",id:m.id,result:{tools:definitions}});if(m.method==="tools/call"){const fn=handlers.get(m.params?.name);if(!fn)throw new Error("Unknown tool");const value=await fn(m.params?.arguments??{});const structuredContent=(value&&typeof value==="object"&&!Array.isArray(value))?value:{result:value};return send({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:JSON.stringify(value)}],structuredContent}})}send({jsonrpc:"2.0",id:m.id,error:{code:-32601,message:"Method not found"}})}catch(error){send({jsonrpc:"2.0",id:m.id,result:{isError:true,content:[{type:"text",text:error.message}]}})}});
