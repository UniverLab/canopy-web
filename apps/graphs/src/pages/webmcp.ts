// SPDX-License-Identifier: Apache-2.0
/**
 * WebMCP tools for a browser agent already on a catalogue page.
 *
 * API shape matched to univerlab.org's own `src/lib/webmcp.ts`:
 * `document.modelContext` first, `navigator.modelContext` as the older
 * name earlier trial builds shipped; `registerTool` returns a Promise and
 * rejects on a duplicate `name`; the tool's `execute` result is
 * JSON-serialized for the caller. Registration is deferred past first
 * paint, and a failed registration is swallowed so the page never breaks.
 *
 * The three tools are read-only: they call the public `GET /api/*`
 * routes and nothing else. Unlike univerlab.org's bundled module, this
 * one is an inline script the layout renders on every page — the
 * catalogue has no browser bundle of its own, and the tools must run on
 * page load wherever the scanner lands.
 */
import { OFFICIAL_OWNER, OFFICIAL_REPO } from "../lib.js";

/** The tool names, in registration order. Tests pin the script to these. */
export const WEBMCP_TOOL_NAMES = ["search_catalogue", "get_graph", "get_node"] as const;

/**
 * The inline WebMCP bootstrap. Single quotes are the TS string's, double
 * quotes the script's; the script carries no `</script>` sequence and no
 * template literal, so it inlines verbatim.
 */
export function webmcpScript(): string {
  return (
    `(function(){` +
    `function modelContext(){` +
    `function from(h){var mc=h&&h.modelContext;return mc&&typeof mc.registerTool==="function"?mc:null}` +
    `var d=(typeof document!=="undefined")?from(document):null;` +
    `if(d){return d}` +
    `return (typeof navigator!=="undefined")?from(navigator):null` +
    `}` +
    `function schedule(fn){` +
    `if(typeof window!=="undefined"&&typeof window.requestIdleCallback==="function"){window.requestIdleCallback(fn,{timeout:2000})}` +
    `else{setTimeout(fn,0)}` +
    `}` +
    `function str(v){return typeof v==="string"?v.trim():""}` +
    `function fetchText(path,signal){` +
    `return fetch(path,{signal:signal}).then(function(r){return r.text()}).catch(function(){return "The catalogue API is unavailable right now; try again in a moment."})` +
    `}` +
    `function opt(){return " Official documents live under ${OFFICIAL_OWNER}/${OFFICIAL_REPO}."}` +
    `function one(kind,input,opts){` +
    `var owner=str(input.owner),repo=str(input.repo),slug=str(input.slug);` +
    `if(!owner||!repo||!slug){return Promise.resolve("Usage: one " + kind + " needs owner, repo and slug." + opt())}` +
    `var signal=opts&&opts.signal?opts.signal:undefined;` +
    `return fetchText("/api/" + (kind === "graph" ? "g" : "n") + "/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/" + encodeURIComponent(slug),signal)` +
    `}` +
    `function search(input,opts){` +
    `var q=str(input.q);` +
    `var sort=str(input.sort)==="new"?"new":"top";` +
    `var raw=input.page;` +
    `var page=(typeof raw==="number")?raw:parseInt(str(raw)||"1",10);` +
    `if(!isFinite(page)||page<1){page=1}` +
    `var signal=opts&&opts.signal?opts.signal:undefined;` +
    `return fetchText("/api/search?q=" + encodeURIComponent(q) + "&sort=" + sort + "&page=" + page,signal)` +
    `}` +
    `function tools(){` +
    `return [` +
    `{name:"search_catalogue",title:"Search the catalogue",` +
    `description:"Search the Canopy graph and node catalogue: free text over names, descriptions and repos, top or new order, 20-item pages. Read-only, served from the scheduled index.",` +
    `inputSchema:{type:"object",properties:{q:{type:"string",description:"Free text over name, slug, description and owner/repo."},sort:{type:"string",enum:["top","new"],description:"top orders by stars, new by updated."},page:{type:"integer",minimum:1,description:"One-based page over 20-item pages."}},additionalProperties:false},` +
    `annotations:{readOnlyHint:true},execute:function(input,opts){return search(input||{},opts)}}` +
    `,{name:"get_graph",title:"Get one graph",` +
    `description:"Fetch one graph document by owner, repo and slug, with its catalogue row. Read-only." + opt(),` +
    `inputSchema:{type:"object",properties:{owner:{type:"string",description:"The GitHub owner."},repo:{type:"string",description:"The GitHub repository."},slug:{type:"string",description:"The document slug."}},required:["owner","repo","slug"],additionalProperties:false},` +
    `annotations:{readOnlyHint:true},execute:function(input,opts){return one("graph",input||{},opts)}}` +
    `,{name:"get_node",title:"Get one node",` +
    `description:"Fetch one node document by owner, repo and slug, with its catalogue row. Read-only." + opt(),` +
    `inputSchema:{type:"object",properties:{owner:{type:"string",description:"The GitHub owner."},repo:{type:"string",description:"The GitHub repository."},slug:{type:"string",description:"The document slug."}},required:["owner","repo","slug"],additionalProperties:false},` +
    `annotations:{readOnlyHint:true},execute:function(input,opts){return one("node",input||{},opts)}}` +
    `]` +
    `}` +
    `function start(){` +
    `var mc=modelContext();` +
    `if(!mc){return}` +
    `var list=tools();` +
    `Promise.all(list.map(function(t){return mc.registerTool(t)})).catch(function(){})` +
    `}` +
    `schedule(start)` +
    `})();`
  );
}
