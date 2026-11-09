export function createSetupCommand(checksum) {
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error("Invalid installer checksum");
  const script = `import{createHash}from"node:crypto";import{mkdtemp,writeFile,rm}from"node:fs/promises";import{tmpdir}from"node:os";import{join}from"node:path";import{spawnSync}from"node:child_process";const r=await fetch("https://scry.giize.com/plugins/scry-desktop-install.mjs",{signal:AbortSignal.timeout(10000),redirect:"error"});if(!r.ok)throw Error("Scry installer download failed");const b=Buffer.from(await r.arrayBuffer());if(createHash("sha256").update(b).digest("hex")!=="${checksum}")throw Error("Scry installer checksum mismatch");const d=await mkdtemp(join(tmpdir(),"scry-setup-"));try{const p=join(d,"install.mjs");await writeFile(p,b,{flag:"wx"});const x=spawnSync(process.execPath,[p],{stdio:"inherit"});process.exitCode=x.status??1;}finally{await rm(d,{recursive:true,force:true});}`;
  return `node --input-type=module -e '${script}'`;
}
