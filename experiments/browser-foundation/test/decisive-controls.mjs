import { createServer } from "node:http";
import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { privateBrowser, sharedRuntime } from "./decisive-runtime.mjs";
const root = "/results/decisive-controls-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const source = await readFile(new URL("./decisive-runtime.mjs", import.meta.url)),
  runtimeHash = createHash("sha256").update(source).digest("hex");
await writeFile(root + "/runtime-source.mjs", source, { mode: 0o600 });
const cases = [
  "input",
  "textarea",
  "controlled",
  "nested-editable",
  "noneditable-widget",
  "iframe",
  "shadow",
  "replace-on-focus",
  "steal-on-select",
  "rollback",
  "reject-paste",
  "uppercase",
  "readonly",
  "disabled",
  "ambiguous",
  "copy-denied",
  "proxy-editor",
  "editing-island",
  "trailing-empty-blocks",
  "edit-context",
  "edit-context-scope",
  "edit-context-readonly",
  "edit-context-disabled",
];
function fixture(kind) {
  let field = '<input id="target" aria-label="Target" value="old">';
  if (kind === "textarea") field = '<textarea id="target" aria-label="Target">old</textarea>';
  if (kind === "nested-editable")
    field =
      '<div id="target" contenteditable="true" role="textbox" aria-label="Target"><p><strong>old</strong></p></div>';
  if (kind === "noneditable-widget")
    field =
      '<div id="target" contenteditable="true" role="textbox" aria-label="Target"><span contenteditable="false">Collaborator</span><p>old</p></div>';
  if (kind === "readonly" || kind === "disabled")
    field = `<input id="target" aria-label="Target" value="old" ${kind}>`;
  if (kind === "ambiguous") field += '<input aria-label="Target" value="other">';
  if (kind === "shadow") field = '<section id="host"></section>';
  if (kind === "proxy-editor")
    field =
      '<div id="target" role="group" aria-label="Visible editor"><textarea id="receiver" style="position:absolute;opacity:0;width:1px;height:1px;min-width:1px;min-height:1px"></textarea><pre id="rendered">old</pre></div>';
  if (kind === "editing-island")
    field =
      '<div contenteditable="false"><h2 id="target" contenteditable="true" role="textbox" aria-label="Target">old</h2></div>';
  if (kind === "trailing-empty-blocks")
    field =
      '<div id="target" contenteditable="true" role="textbox" aria-label="Target"><div>old</div><div><br></div><div><br></div></div>';
  if (kind === "iframe")
    field =
      '<iframe title="Editor" srcdoc="&lt;body contenteditable=&quot;true&quot;&gt;&lt;p id=&quot;target&quot;&gt;old&lt;/p&gt;&lt;/body&gt;"></iframe>';
  if (kind.startsWith("edit-context"))
    field =
      kind === "edit-context-scope"
        ? '<div id="target" role="group"><div id="ec" role="textbox" tabindex="0" style="min-width:500px;min-height:70px">old</div></div>'
        : `<div id="target" role="textbox" tabindex="0" aria-readonly="${kind === "edit-context-readonly"}" aria-disabled="${kind === "edit-context-disabled"}" style="min-width:500px;min-height:70px">old</div>`;
  return `<!doctype html><meta charset="utf-8"><style>body{font:18px system-ui;padding:40px}input,textarea,[contenteditable]{display:block;min-width:500px;min-height:50px;margin:16px 0;border:1px solid #666}iframe{width:650px;height:200px}</style><h1>${kind}</h1>${field}<label>Decoy<input id="decoy" value="untouched"></label><script>
  const kind=${JSON.stringify(kind)}; window.witness=[];
  if(kind==='shadow'){const s=document.querySelector('#host').attachShadow({mode:'open'});s.innerHTML='<input id="target" aria-label="Target" value="old">';}
  const target=()=>document.querySelector('#host')?.shadowRoot?.querySelector('#target')||document.querySelector('#target');
  document.addEventListener('input',e=>window.witness.push({id:e.target.id,value:e.target.value??e.target.textContent}));
  if(kind==='replace-on-focus'){target().addEventListener('focus',()=>setTimeout(()=>{const old=target(),n=old.cloneNode();old.replaceWith(n);n.focus();},30),{once:true});}
  if(kind==='steal-on-select')target().addEventListener('keydown',e=>{if(e.ctrlKey&&e.key.toLowerCase()==='a')document.querySelector('#decoy').focus()});
  if(kind==='rollback')target().addEventListener('input',()=>setTimeout(()=>target().value='old',120));
  if(kind==='reject-paste')target().addEventListener('paste',e=>e.preventDefault());
  if(kind==='uppercase')target().addEventListener('input',()=>target().value=target().value.toUpperCase());
  if(kind==='controlled')target().addEventListener('input',()=>{window.model=target().value;});
  if(kind==='copy-denied')target().addEventListener('copy',e=>e.preventDefault());
  if(kind==='proxy-editor'){const receiver=document.querySelector('#receiver'),rendered=document.querySelector('#rendered');let selected=false;target().addEventListener('click',()=>receiver.focus());receiver.addEventListener('keydown',e=>{if(e.ctrlKey&&e.key.toLowerCase()==='a'){selected=true;e.preventDefault();}});receiver.addEventListener('paste',e=>{e.preventDefault();rendered.textContent=(selected?'':rendered.textContent)+e.clipboardData.getData('text/plain');selected=false;});receiver.addEventListener('copy',e=>{e.preventDefault();e.clipboardData.setData('text/plain',rendered.textContent);});}
  if(kind.startsWith('edit-context')){const e=document.querySelector('#ec')||target(),ec=new EditContext({text:'old'});e.editContext=ec;ec.addEventListener('textupdate',()=>{e.textContent=ec.text});e.addEventListener('keydown',v=>{if(v.ctrlKey&&v.key.toLowerCase()==='a'){v.preventDefault();ec.updateSelection(0,ec.text.length);}});e.addEventListener('paste',v=>{v.preventDefault();const start=ec.selectionStart,end=ec.selectionEnd,text=v.clipboardData.getData('text/plain');ec.updateText(start,end,text);ec.updateSelection(start+text.length,start+text.length);e.textContent=ec.text;});e.addEventListener('copy',v=>{v.preventDefault();v.clipboardData.setData('text/plain',ec.text.substring(ec.selectionStart,ec.selectionEnd));});}
  </script>`;
}
const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(fixture(new URL(req.url, "http://localhost").pathname.slice(1)));
});
await new Promise((r) => server.listen(0, "0.0.0.0", r));
const origin = "http://127.0.0.1:" + server.address().port;
const env = await privateBrowser();
const rows = [];
try {
  for (const strategy of process.env.SCRY_DECISIVE_STRATEGIES?.split(",") ?? [
    "official-fill",
    "native-paste-with-dom-readback",
    "native-paste-with-native-copy-readback",
  ]) {
    const context = await env.browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: root + "/video" },
    });
    const page = await context.newPage();
    let runtime;
    try {
      await page.goto(origin + "/input");
      runtime = await sharedRuntime(context, env.clipboard);
      for (const kind of cases) {
        await page.goto(origin + "/" + kind);
        const target =
          kind === "iframe"
            ? "iframe >> internal:control=enter-frame >> body"
            : kind === "ambiguous"
              ? '[aria-label="Target"]'
              : kind === "shadow"
                ? "#host >> #target"
                : "#target";
        const expected = kind === "textarea" ? "New value\nCafé 日本語 😀" : "New Café 日本語 😀";
        const result = await runtime.replace({ page, target, text: expected, strategy });
        const read = () =>
          page
            .locator(target)
            .first()
            .evaluate((e) => {
              const c = e.cloneNode(true);
              for (const n of c.querySelectorAll('[contenteditable="false"]')) n.remove();
              return {
                value: e.matches("input,textarea") ? e.value : c.textContent,
                rawView: e.innerText,
                connected: e.isConnected,
              };
            });
        const immediate = await read();
        await page.waitForTimeout(700);
        const later = await read();
        const decoy = await page.locator("#decoy").inputValue();
        const row = {
          kind,
          strategy,
          expected,
          result,
          immediate,
          later,
          decoy,
          falseAcceptance:
            result.status === "accepted" && immediate.value.replace(/\r\n/g, "\n") !== expected,
          wrongTarget: decoy !== "untouched",
          laterMismatch: result.status === "accepted" && later.value !== expected,
        };
        rows.push(row);
        await appendFile(root + "/cases.jsonl", JSON.stringify(row) + "\n", { mode: 0o600 });
        console.log(
          JSON.stringify({
            kind,
            strategy,
            status: result.status,
            reason: result.reason,
            falseAcceptance: row.falseAcceptance,
            wrongTarget: row.wrongTarget,
            laterMismatch: row.laterMismatch,
          }),
        );
        if (kind === "steal-on-select" || kind === "noneditable-widget")
          await page.screenshot({ path: root + "/" + strategy + "-" + kind + ".png" });
      }
    } finally {
      await runtime?.close();
      await context.close();
    }
  }
} finally {
  await env.close();
  await new Promise((r) => server.close(r));
  await writeFile(root + "/results.json", JSON.stringify({ root, runtimeHash, rows }, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify({ root, runtimeHash, cases: rows.length }));
}
