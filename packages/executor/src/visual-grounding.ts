import { createRequire } from "node:module";
import { createWorker, OEM } from "tesseract.js";
import type { Locator, Page } from "playwright";
import type { InteractionTargetIntent, VisualAnchor } from "@scry/contracts";

const eng=createRequire(import.meta.url)("@tesseract.js-data/eng") as {code:string;gzip:boolean;langPath:string};
type OcrWord={text:string;confidence:number;bbox:{x0:number;y0:number;x1:number;y1:number}};
let workerPromise:ReturnType<typeof createWorker>|undefined;
async function worker(){workerPromise??=createWorker(eng.code,OEM.LSTM_ONLY,{langPath:eng.langPath,gzip:eng.gzip});return workerPromise;}

/** Visual sources produce evidence anchors only. They never return an action target. */
export async function resolveVisualAnchors(page:Page,scope:Locator,intent:InteractionTargetIntent):Promise<VisualAnchor[]>{
  const visual=intent.preferredEvidence.visual;
  if(!visual)return [];
  const scopeBox=await scope.boundingBox();
  if(!scopeBox)return [];
  const anchors:VisualAnchor[]=[];
  if((visual.sources.includes("ocr")||visual.sources.includes("canvas"))&&visual.expectedText){
    const image=await scope.screenshot({type:"png"});
    try{
      const result=await(await worker()).recognize(image,{}, {blocks:true,text:true});
      const expected=normalize(visual.expectedText);
      for(const word of flattenWords(result.data.blocks??[])){
        const actual=normalize(word.text);
        const similarity=actual===expected?1:(actual.includes(expected)||expected.includes(actual)?0.78:0);
        if(!similarity)continue;
        anchors.push({text:word.text,bounds:{x:scopeBox.x+word.bbox.x0,y:scopeBox.y+word.bbox.y0,width:word.bbox.x1-word.bbox.x0,height:word.bbox.y1-word.bbox.y0},confidence:Math.min(1,similarity*Math.max(0,word.confidence)/100),source:visual.sources.includes("canvas")?"canvas":"ocr"});
      }
    }finally{image.fill(0);}
  }
  if(visual.sources.includes("icon")&&visual.icon){
    const aliases=iconAliases(visual.icon);const icons=scope.locator("button, a, [role=button], svg, img, canvas");
    for(let index=0,count=Math.min(await icons.count(),500);index<count;index+=1){
      const locator=icons.nth(index);
      const meta=await locator.evaluate(observeIconInPage).catch(()=>undefined);
      if(!meta||!aliases.some((alias)=>meta.identity.split(/[^a-z]+/).includes(alias)))continue;
      anchors.push({text:visual.icon,bounds:meta.bounds,confidence:.92,source:meta.canvas?"canvas":"icon"});
    }
  }
  if(visual.sources.includes("geometry")){
    const expected=visual.expectedText??intent.preferredEvidence.expectedText??intent.preferredEvidence.names[0]??intent.preferredEvidence.labels[0];
    if(expected){
      const texts=scope.getByText(expected,{exact:false});
      for(let index=0,count=Math.min(await texts.count(),20);index<count;index+=1){const box=await texts.nth(index).boundingBox();if(box)anchors.push({text:expected,bounds:box,confidence:.82,source:"ocr"});}
    }
  }
  return anchors.sort((a,b)=>b.confidence-a.confidence||a.bounds.y-b.bounds.y||a.bounds.x-b.bounds.x);
}

export async function acquireProtectedVisualText(page:Page,intent:InteractionTargetIntent):Promise<string>{
  if(!intent.preferredEvidence.visual?.protectedUse)throw new Error("VISUAL_GROUNDING_DISABLED");
  const anchors=await resolveVisualAnchors(page,page.locator("body"),intent);
  const minimum=intent.confidence.minimum??.82,margin=(anchors[0]?.confidence??0)-(anchors[1]?.confidence??0);
  if(!anchors[0]?.text||(anchors[0]?.confidence??0)<minimum||margin<(intent.confidence.minimumMargin??.15))throw new Error(anchors.length>1?"TARGET_AMBIGUOUS":"INSUFFICIENT_EVIDENCE");
  return anchors[0].text;
}

function observeIconInPage(element:Element){
  const rect=element.getBoundingClientRect();
  return{identity:[element.getAttribute("aria-label"),element.getAttribute("title"),element.getAttribute("alt"),element.getAttribute("data-icon"),element.querySelector("title")?.textContent].filter(Boolean).join(" ").toLowerCase(),canvas:element instanceof HTMLCanvasElement,bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};
}
function flattenWords(blocks:Array<{paragraphs?:Array<{lines?:Array<{words?:OcrWord[]}>}>}>):OcrWord[]{return blocks.flatMap((block)=>block.paragraphs??[]).flatMap((paragraph)=>paragraph.lines??[]).flatMap((line)=>line.words??[]);}
function normalize(value:string){return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g," ").trim();}
function iconAliases(icon:NonNullable<NonNullable<InteractionTargetIntent["preferredEvidence"]["visual"]>["icon"]>):string[]{return({add:["add","plus","new"],back:["back","left","previous"],check:["check","done","confirm"],close:["close","dismiss","x"],copy:["copy","duplicate"],delete:["delete","trash","remove"],download:["download"],edit:["edit","pencil"],forward:["forward","right","next"],menu:["menu","hamburger"],more:["more","ellipsis"],search:["search","magnify"],settings:["settings","gear","cog"],upload:["upload"],user:["user","profile","account"]}as const)[icon]as unknown as string[];}
