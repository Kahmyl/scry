import { createServer } from "node:http";

// Fictional split-origin target. Never mounted into a running customer stack.
const facts = { logins: 0, profiles: 0, logouts: 0, forbidden: 0 };
const sessions = new Set();
export function startLoginFixture(credential) {
  createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "http://fixture:8080");
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("access-control-allow-headers", "content-type");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader("content-type", "application/json");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      return response.end();
    }
    const session = /fixture_session=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
    if (request.url === "/session")
      return response.end(JSON.stringify({ authenticated: sessions.has(session) }));
    if (request.method === "POST" && request.url === "/login") {
      facts.logins++;
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 4096) {
          response.writeHead(413);
          return response.end("{}");
        }
      }
      const input = JSON.parse(body);
      if (input.email !== "fictional@example.invalid" || input.password !== credential) {
        response.writeHead(401);
        return response.end('{"error":"Credentials rejected"}');
      }
      const value = "fictional-session-" + facts.logins;
      sessions.add(value);
      response.setHeader("set-cookie", `fixture_session=${value}; HttpOnly; SameSite=Lax; Path=/`);
      return response.end('{"authenticated":true}');
    }
    if (request.method === "POST" && request.url === "/profile") {
      facts.profiles++;
      response.writeHead(sessions.has(session) ? 200 : 401);
      return response.end(JSON.stringify({ authenticated: sessions.has(session) }));
    }
    if (request.method === "POST" && request.url === "/logout") {
      facts.logouts++;
      sessions.delete(session);
      response.setHeader(
        "set-cookie",
        "fixture_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
      );
      return response.end('{"authenticated":false}');
    }
    response.writeHead(404);
    response.end("{}");
  }).listen(8082, "0.0.0.0");
  createServer((_request, response) => {
    facts.forbidden++;
    response.end("forbidden");
  }).listen(8083, "0.0.0.0");
}

export function handleLoginFixture(request, response) {
  if (request.url === "/login-facts") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(facts));
    return true;
  }
  if (request.url !== "/login-app") return false;
  response.setHeader("content-type", "text/html");
  response.end(`<!doctype html><title>Split-origin workspace</title><style>body{font:20px system-ui;margin:48px;background:#f6f8fb;color:#182437}main{max-width:640px;padding:32px;background:white;border:1px solid #c8d1dd}label{display:block;margin:16px 0}input,button{font:inherit;padding:8px}#status{min-height:40px}</style><main><h1 id="heading">Sign in to the fictional workspace</h1><form><label>Email<input aria-label="Email" type="email" required></label><label>Password<input aria-label="Password" type="password" required></label><button>Sign in</button></form><p id="status" role="status"></p><button id="logout">Sign out</button><button id="forbidden">Check excluded service</button></main><script>
const api='http://fixture:8082';
const heading=document.querySelector('#heading'),status=document.querySelector('#status');
async function state(){const r=await fetch(api+'/session',{credentials:'include'});const s=await r.json();heading.textContent=s.authenticated?'Signed in as fictional user':'Sign in to the fictional workspace';}
document.querySelector('form').onsubmit=async e=>{e.preventDefault();try{const r=await fetch(api+'/login',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({email:document.querySelector('[type=email]').value,password:document.querySelector('[type=password]').value})});if(!r.ok){status.textContent='Credentials rejected';return;}await fetch(api+'/profile',{method:'POST',credentials:'include'});status.textContent='Profile loaded';await state();}catch{status.textContent='Connection failed';}};
document.querySelector('#logout').onclick=async()=>{await fetch(api+'/logout',{method:'POST',credentials:'include'});status.textContent='Signed out';await state();};
document.querySelector('#forbidden').onclick=async()=>{try{await fetch('http://fixture:8083/excluded');}catch{status.textContent='Excluded service blocked';}};
state().catch(()=>{status.textContent='Session check unavailable';});
</script>`);
  return true;
}
