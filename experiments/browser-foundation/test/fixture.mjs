import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const facts = {};
const html = (body) =>
  `<!doctype html><html><head><title>Controlled browser diagnostic</title><style>body{font:18px sans-serif;padding:24px}button,input{margin:8px;padding:10px}</style></head><body>${body}</body></html>`;
createServer(async (req, res) => {
  const url = new URL(req.url, "http://diagnosis:8080");
  const tag = url.searchParams.get("tag") ?? "none";
  appendFileSync(
    "/lab/request-events.jsonl",
    JSON.stringify({
      at: new Date().toISOString(),
      method: req.method,
      host: req.headers.host,
      path: url.pathname,
      tag,
    }) + "\n",
    { mode: 0o600 },
  );
  const f = (facts[tag] ??= { read: 0, telemetry: 0, save: 0, logout: 0, image: 0 });
  res.setHeader("cache-control", "no-store");
  if (url.pathname === "/facts") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(facts));
  }
  if (url.pathname === "/rpc/read") {
    f.read++;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ items: ["Customer Alpha", "Customer Beta"] }));
  }
  if (url.pathname === "/telemetry") {
    f.telemetry++;
    res.setHeader("content-type", "application/json");
    return res.end('{"accepted":true}');
  }
  if (url.pathname === "/save") {
    f.save++;
    res.setHeader("content-type", "application/json");
    return res.end('{"saved":true}');
  }
  if (url.pathname === "/logout") {
    f.logout++;
    res.writeHead(302, { location: `/signed-out?tag=${tag}` });
    return res.end();
  }
  if (url.pathname === "/redirect-save") {
    f.save++;
    res.writeHead(302, {
      location: `http://${url.searchParams.get("mode") === "same" ? "diagnosis" : "diagnosis-assets"}:8080/result?tag=${tag}`,
    });
    return res.end();
  }
  if (url.pathname === "/icon.svg") {
    f.image++;
    res.setHeader("content-type", "image/svg+xml");
    return res.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="green"/></svg>',
    );
  }
  res.setHeader("content-type", "text/html");
  const q = `?tag=${encodeURIComponent(tag)}`;
  const script = (code) => `<script>${code}</script>`;
  let body;
  if (url.pathname === "/case/postread")
    body =
      `<h1>Customers</h1><button onclick="loadCustomers()">Open customers</button><p id="result">Not loaded</p>` +
      script(
        `async function loadCustomers(){try{const r=await fetch('/rpc/read${q}',{method:'POST',body:'query'});const j=await r.json();result.textContent=j.items.join(', ')}catch{result.textContent='Read blocked'}}`,
      );
  else if (url.pathname === "/case/multi")
    body =
      `<h1>Order</h1><button onclick="saveOrder()">Save order</button><p id="result">Unsaved</p>` +
      script(
        `async function saveOrder(){try{await fetch('/telemetry${q}',{method:'POST',body:'event'});await fetch('/save${q}',{method:'POST',body:'order'});result.textContent='Order saved'}catch{result.textContent='Order not saved'}}`,
      );
  else if (url.pathname === "/case/getlogout")
    body = `<h1>Signed in</h1><a href="/logout${q}">Sign out</a>`;
  else if (url.pathname === "/case/readonlyget")
    body = `<h1>Signed in</h1><a href="/logout${q}">Sign out</a>`;
  else if (url.pathname === "/case/autofill")
    body =
      `<h1>Automatic save on typing</h1><input aria-label="Customer name" oninput="saveNote()"><p id="result">Unsaved</p>` +
      script(
        `async function saveNote(){await fetch('/save${q}',{method:'POST',body:'fictional note'});result.textContent='Autosave persisted'}`,
      );
  else if (url.pathname === "/case/delayed")
    body =
      `<h1>Deferred application communication</h1><button onclick="setTimeout(saveNote,700)">Schedule autosave</button><p id="result">Unsaved</p>` +
      script(
        `async function saveNote(){await fetch('/save${q}',{method:'POST',body:'fictional note'});result.textContent='Deferred save persisted'}`,
      );
  else if (url.pathname === "/case/assets")
    body =
      `<h1>Product with ordinary image</h1><button onclick="saveWithImage()">Save product</button><p id="result">Unsaved</p><img id="icon" alt="Ordinary public icon">` +
      script(
        `async function saveWithImage(){try{await fetch('/save${q}',{method:'POST',body:'product'});icon.onload=()=>result.textContent='Saved and icon loaded';icon.onerror=()=>result.textContent='Saved but icon broken';icon.src='http://diagnosis-assets:8080/icon.svg${q}'}catch{result.textContent='Save failed'}}`,
      );
  else if (["/case/redirect", "/case/redirectsame"].includes(url.pathname))
    body = `<h1>Redirect after save</h1><form action="/redirect-save${q}${url.pathname.endsWith("same") ? "&mode=same" : ""}" method="POST"><button>Save and continue</button></form>`;
  else if (url.pathname === "/case/controls")
    body =
      `<h1>Real form controls</h1><input type="hidden" name="csrf" value="fictional"><input style="display:none" placeholder="Hidden duplicate"><label for="email">Work email</label><input id="email"><div role="textbox" contenteditable="true" aria-label="Rich editor" oninput="document.getElementById('rich-preview').textContent=this.textContent"></div><p id="rich-preview" aria-label="Rich preview"></p><iframe src="/frame"></iframe>` +
      Array.from({ length: 205 }, (_, i) => `<a href="#row${i}">Row ${i}</a>`).join("") +
      "<button>Important final action</button>";
  else if (url.pathname === "/case/timeout")
    body =
      '<h1>Normal usable page</h1><button style="display:none">Hidden action</button><input aria-label="Visible note"><p>The hidden action must not be offered as usable.</p>';
  else if (url.pathname === "/case/widgets")
    body =
      "<h1>Normal interaction controls</h1><label>Country<select><option>Canada</option><option>Japan</option></select></label><label><input type=\"checkbox\">Agree</label><button onclick=\"document.querySelector('p').textContent=confirm('Continue?')?'Confirmed':'Cancelled'\">Confirm action</button><a href=\"/result\" target=\"_blank\">Open another tab</a><p>Ready</p>";
  else if (url.pathname === "/case/surface")
    body = `<style>body{margin:0;padding:0}.fixed{position:absolute;box-sizing:border-box;margin:0}p{margin:0}#pointer{background:#def}#drop{background:#fed}</style>
      <h1 class="fixed" style="left:600px;top:20px">Tool surface</h1>
      <div class="fixed" style="left:20px;top:10px"><label>Name<input aria-label="Name"></label><label><input type="checkbox">Accept</label><label>Mode<select><option>Alpha</option><option>Beta</option></select></label></div>
      <button id="hover" class="fixed" style="left:20px;top:140px;width:100px;height:40px" onmouseenter="hovercount.textContent='Hover count '+(++window.hovers)">Hover target</button>
      <button class="fixed" style="left:20px;top:200px;width:120px;height:40px" onclick="xy.textContent='Coordinate clicked'">Coordinate action</button>
      <div role="button" aria-label="Drag source" draggable="true" class="fixed" style="left:20px;top:260px;width:100px;height:40px;background:#ddd" ondragstart="event.dataTransfer.setData('text/plain','source')">Drag source</div>
      <div id="drop" role="button" aria-label="Drop area" class="fixed" style="left:200px;top:260px;width:100px;height:40px" ondragover="event.preventDefault()" ondrop="event.preventDefault();dropresult.textContent=event.dataTransfer.getData('text/plain')==='source'?'DOM drop accepted':'Wrong drop'">Drop area</div>
      <div id="pointer" class="fixed" style="left:20px;top:340px;width:280px;height:70px" onpointerdown="down.textContent='Pointer down';this.setPointerCapture(event.pointerId)" onpointermove="if(event.buttons) moved.textContent='Pointer moved while pressed'" onpointerup="up.textContent='Pointer up'">Pointer interaction area</div>
      <div class="fixed" style="left:340px;top:20px;width:200px;height:160px;overflow:auto" onscroll="wheelresult.textContent='Wheel scrolled'"><div style="height:1000px;background:linear-gradient(white,#ddd)">Scrollable area</div></div>
      <div class="fixed" style="left:20px;top:440px"><p id="hovercount">Hover count 0</p><p id="xy">Coordinate ready</p><p id="dropresult">Drop ready</p><p id="down">Pointer ready</p><p id="moved">Pointer unmoved</p><p id="up">Pointer not released</p><p id="wheelresult">Wheel ready</p></div><script>window.hovers=0</script>`;
  else if (url.pathname === "/case/secrets")
    body =
      '<h1 style="background:#def;padding:20px">Original styled application</h1><label>Email<input aria-label="Email"></label><label>Password<input type="password" aria-label="Password"></label><p>Ordinary customer and business content stays visible.</p><img src="http://diagnosis-assets:8080/icon.svg" alt="Public icon">';
  else if (url.pathname === "/case/stale")
    body =
      "<button onclick=\"this.outerHTML='<button>Replacement action</button>'\">Replace control</button>";
  else if (url.pathname === "/case/hang")
    body = '<button onclick="while(true){}">Unresponsive application</button>';
  else if (url.pathname === "/frame")
    body = "<button onclick=\"this.textContent='Frame clicked'\">Embedded frame action</button>";
  else if (url.pathname === "/signed-out") body = "<h1>Signed out</h1>";
  else if (url.pathname === "/result") body = "<h1>Redirect result</h1>";
  else body = "<h1>Diagnostic target ready</h1>";
  res.end(html(body));
}).listen(8080, "0.0.0.0");
