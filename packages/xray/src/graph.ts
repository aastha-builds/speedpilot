/** `speedpilot xray graph`: an interactive dependency graph (HTML with Cytoscape.js, pinned from cdnjs). */
import type { SiteModel } from './model.js';

const KEEP = new Set(['script', 'stylesheet', 'global', 'handler', 'plugin', 'theme', 'app', 'third-party', 'platform', 'core', 'first-party', 'page', 'liquid', 'query', 'hook']);
const EDGES = new Set(['depends-on', 'defines', 'uses', 'listens', 'owned-by', 'renders', 'initiates']);
const COLORS: Record<string, string> = { script: '#0969da', stylesheet: '#8250df', global: '#9a6700', handler: '#cf222e', page: '#1a7f37', liquid: '#bf3989', query: '#953800', hook: '#6e7781' };

export function graphHtml(model: SiteModel, title = 'SpeedPilot X-ray graph', maxNodes = 1500): string {
  const nodes = [...model.nodes.values()].filter((n) => KEEP.has(n.type)).slice(0, maxNodes);
  const ids = new Set(nodes.map((n) => n.id));
  const els = [
    ...nodes.map((n) => ({ data: { id: n.id, label: n.label.replace(/^https?:\/\/[^/]+/, '').slice(0, 48), type: n.type, owner: n.owner ?? '', color: COLORS[n.type] ?? '#57606a' } })),
    ...model.edges.filter((e) => EDGES.has(e.type) && ids.has(e.src) && ids.has(e.dst)).map((e, i) => ({ data: { id: `e${i}`, source: e.src, target: e.dst, type: e.type, evidence: e.evidence, confidence: e.confidence } })),
  ];
  const json = JSON.stringify(els).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>:root{--bg:#fff;--fg:#1f2328}@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3}}body{margin:0;font:13px system-ui;background:var(--bg);color:var(--fg)}#cy{position:absolute;inset:40px 0 0 0}header{height:40px;display:flex;gap:12px;align-items:center;padding:0 12px}#info{font-size:12px;opacity:.8}</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script></head><body>
<header><strong>${title}</strong><input id="q" placeholder="filter (handle, URL, owner)" style="flex:1;max-width:320px"><span id="info">${nodes.length} nodes. Click a node for its edges.</span></header><div id="cy"></div>
<script>const els=${json};
if(!window.cytoscape){document.getElementById('cy').textContent='Cytoscape.js could not load (offline). The graph data is embedded in this file as JSON.';}else{
const cy=cytoscape({container:document.getElementById('cy'),elements:els,layout:{name:'cose',animate:false},style:[{selector:'node',style:{'background-color':'data(color)',label:'data(label)','font-size':8,color:getComputedStyle(document.body).color}},{selector:'edge',style:{width:1,'curve-style':'bezier','target-arrow-shape':'triangle','line-color':'#999','target-arrow-color':'#999'}},{selector:'edge[type="depends-on"]',style:{'line-color':'#cf222e','target-arrow-color':'#cf222e',width:2}},{selector:'.dim',style:{opacity:.1}}]});
cy.on('tap','node',e=>{const n=e.target;cy.elements().addClass('dim');n.closedNeighborhood().removeClass('dim');document.getElementById('info').textContent=n.data('id')+' — owner '+n.data('owner')+' — '+n.connectedEdges().length+' edges';});
document.getElementById('q').addEventListener('input',e=>{const q=e.target.value.toLowerCase();cy.elements().removeClass('dim');if(q)cy.nodes().filter(n=>!(n.data('id')+n.data('owner')).toLowerCase().includes(q)).addClass('dim');});}
</script></body></html>`;
}
