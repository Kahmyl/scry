import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { privateBrowser } from "../../browser-foundation/test/decisive-runtime.mjs";
const require = createRequire("/workspace/packages/praxis/package.json"),
  { chromium } = require("playwright-mcp-runtime");
const root = "/results/journey-drag-cause-" + Date.now();
await mkdir(root, { recursive: true, mode: 0o700 });
const source = await readFile(new URL("./drag-cause.mjs", import.meta.url));
await writeFile(root + "/source.mjs", source, { mode: 0o600 });
const html = `<!doctype html><style>body{font:20px system-ui;padding:30px}#from,#to{width:180px;height:70px;background:#bef;margin:20px}button{font:inherit}</style><h1>Native drag boundary</h1><div id=from draggable=true>Source</div><div id=to>Destination</div><button id=check>Check next click</button><output>0</output><script>
window.events=[];for(const type of ['mousedown','mouseup','mousemove','dragstart','dragenter','dragover','drop','dragend','click','keydown'])document.addEventListener(type,e=>events.push({type,id:e.target.id,x:e.clientX,y:e.clientY,key:e.key}),true);
document.querySelector('#from').ondragstart=e=>{e.dataTransfer.setData('text/plain','Fictional payload');};document.querySelector('#to').ondragover=e=>e.preventDefault();document.querySelector('#to').ondrop=e=>{e.preventDefault();e.currentTarget.textContent=e.dataTransfer.getData('text/plain');};document.querySelector('#check').onclick=()=>document.querySelector('output').textContent=String(Number(document.querySelector('output').textContent)+1);
</script>`;
const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
const env = await privateBrowser(),
  rows = [];
try {
  for (const mode of ["headed", "headless"]) {
    const browser =
      mode === "headed"
        ? env.browser
        : await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    for (const method of ["dragTo", "manual", "cdp-intercept"]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 } }),
        page = await context.newPage(),
        row = { mode, method };
      try {
        await page.goto(origin);
        await page.locator("#check").click();
        row.controlBefore = await page.locator("output").innerText();
        const cdp = await context.newCDPSession(page);
        if (method === "cdp-intercept") {
          await cdp.send("Input.setInterceptDrags", { enabled: true });
          const intercepted = new Promise((resolve) => cdp.once("Input.dragIntercepted", resolve));
          const a = await page.locator("#from").boundingBox(),
            b = await page.locator("#to").boundingBox();
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: a.x + 20,
            y: a.y + 20,
          });
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: a.x + 20,
            y: a.y + 20,
            button: "left",
            clickCount: 1,
          });
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: b.x + 20,
            y: b.y + 20,
            button: "left",
            buttons: 1,
          });
          let timer;
          const drag = await Promise.race([
            intercepted,
            new Promise((r) => (timer = setTimeout(() => r(null), 2000))),
          ]);
          clearTimeout(timer);
          row.intercepted = !!drag;
          if (drag)
            for (const type of ["dragEnter", "dragOver", "drop"])
              await cdp.send("Input.dispatchDragEvent", {
                type,
                x: b.x + 20,
                y: b.y + 20,
                data: drag.data,
              });
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: b.x + 20,
            y: b.y + 20,
            button: "left",
            clickCount: 1,
          });
          await cdp.send("Input.setInterceptDrags", { enabled: false });
        } else if (method === "dragTo")
          await page.locator("#from").dragTo(page.locator("#to"), { timeout: 4000 });
        else {
          await page.locator("#from").hover();
          await page.mouse.down();
          try {
            await page.locator("#to").hover();
            await page.locator("#to").hover();
          } finally {
            await page.mouse.up();
          }
        }
        row.drop = await page.locator("#to").innerText();
        await page.locator("#check").click({ timeout: 2000 });
        row.after = await page.locator("output").innerText();
        row.eventsBeforeRecovery = await page.evaluate(() => events);
        await page.keyboard.press("Escape");
        await page.mouse.up();
        await cdp.send("Input.cancelDragging");
        await page.locator("#check").click({ timeout: 2000 });
        row.afterCancel = await page.locator("output").innerText();
        await page.reload();
        await page.locator("#check").click({ timeout: 2000 });
        row.afterReload = await page.locator("output").innerText();
        await cdp.detach();
      } catch (e) {
        row.error = e.message;
      } finally {
        rows.push(row);
        await context.close();
        console.log(JSON.stringify(row));
      }
    }
    if (mode === "headless") await browser.close();
  }
} finally {
  await env.close();
  await new Promise((r) => server.close(r));
  await writeFile(
    root + "/results.json",
    JSON.stringify(
      { root, sourceHash: createHash("sha256").update(source).digest("hex"), rows },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ root, cases: rows.length }));
}
