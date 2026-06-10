// Curador Before/After — detección de cambio. Dos mapas sincronizados (antes |
// después) + dibujo manual y varita mágica para anotar el cambio a mano.
const GEOJSON_URL = "deforestacion.geojson";   // overlay SERFOR (mismo folder que index.html)
const TITILER = "https://titiler.xyz/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png";
const LS_KEY   = "defo_labels_cd_v1";
const LS_EXCL  = "defo_excluded_v1";
const LS_ANNOT = "defo_annot_cd_v1";

function tciUrl(item){
  const m=item.match(/^S2[AB]_(\d+)([A-Z])([A-Z]{2})_(\d{4})(\d{2})(\d{2})_/);
  if(!m) return null;
  const[,utm,lat,sq,y,mo]=m;
  return `https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/${utm}/${lat}/${sq}/${y}/${+mo}/${item}/TCI.tif`;
}
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const bboxPoly=b=>[[[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]],[b[0],b[1]]]];
const $=id=>document.getElementById(id);

function pct(arr,lo,hi){
  const n=arr.length, step=Math.max(1,(n/20000)|0), s=[];
  for(let i=0;i<n;i+=step){ const v=arr[i]; if(v>0) s.push(v); }
  if(!s.length) return [0,1];
  s.sort((a,b)=>a-b);
  return [s[(s.length*lo/100)|0], s[Math.min(s.length-1,(s.length*hi/100)|0)]];
}
// decodifica un .tif -> {url:dataURL, imageData, w, h}. Cache por File.
const _decodeCache=new WeakMap();
async function tifDecode(file){
  if(_decodeCache.has(file)) return _decodeCache.get(file);
  const buf=await file.arrayBuffer();
  const tiff=await GeoTIFF.fromArrayBuffer(buf);
  const img=await tiff.getImage();
  const w=img.getWidth(), h=img.getHeight();
  const bands=await img.readRasters();
  const R=bands[0], G=bands[1]||bands[0], B=bands[2]||bands[0];
  const [rl,rh]=pct(R,2,98),[gl,gh]=pct(G,2,98),[bl,bh]=pct(B,2,98);
  const sc=(v,lo,hi)=>{ const t=(v-lo)/(hi-lo+1e-6); return t<0?0:t>1?255:(t*255)|0; };
  const cv=document.createElement("canvas"); cv.width=w; cv.height=h;
  const ctx=cv.getContext("2d"), im=ctx.createImageData(w,h), d=im.data;
  for(let i=0,j=0;i<w*h;i++,j+=4){
    d[j]=sc(R[i],rl,rh); d[j+1]=sc(G[i],gl,gh); d[j+2]=sc(B[i],bl,bh); d[j+3]=255;
  }
  ctx.putImageData(im,0,0);
  const out={url:cv.toDataURL("image/png"),imageData:im,w,h};
  _decodeCache.set(file,out);
  return out;
}

// ---- state ----
let SCENES=[];
let META={};
let LABELS=JSON.parse(localStorage.getItem(LS_KEY)||"{}");
let EXCLUDED=new Set(JSON.parse(localStorage.getItem(LS_EXCL)||"[]").map(String));
let ANNOT=JSON.parse(localStorage.getItem(LS_ANNOT)||"{}");   // row_id -> [ring,...]  ring=[[lon,lat],...]
let LOCAL_TIFS={};                  // row_id -> {A:File, B:File}
let IMG_DATA={};                    // row_id -> {imageData,w,h} de la imagen "después" (para la varita)
let curId=null, bound=false, MODE="pan", drawPts=[];
const saveLabels=()=>localStorage.setItem(LS_KEY,JSON.stringify(LABELS));
const saveExcl=()=>localStorage.setItem(LS_EXCL,JSON.stringify([...EXCLUDED]));
const saveAnnot=()=>localStorage.setItem(LS_ANNOT,JSON.stringify(ANNOT));

function mkMap(container){
  return new maplibregl.Map({
    container, hash:false,
    style:{ version:8,
      sources:{ gsat:{ type:"raster",
        tiles:["https://mt0.google.com/vt/lyrs=s&x={x}&y={y}&z={z}","https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}","https://mt2.google.com/vt/lyrs=s&x={x}&y={y}&z={z}","https://mt3.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"],
        tileSize:256, attribution:"© Google" } },
      layers:[ {id:"bg",type:"background",paint:{"background-color":"#0f1115"}}, {id:"gsat",type:"raster",source:"gsat"} ] },
    center:[-72.5,-8], zoom:5
  });
}
const mapA=mkMap("map-a"), mapB=mkMap("map-b");
mapB.addControl(new maplibregl.NavigationControl(),"top-right");

// sincronizar pan/zoom
let syncing=false;
function link(src,dst){
  src.on("move",()=>{ if(syncing) return; syncing=true;
    dst.jumpTo({center:src.getCenter(),zoom:src.getZoom(),bearing:src.getBearing(),pitch:src.getPitch()});
    syncing=false; });
}
link(mapA,mapB); link(mapB,mapA);

const decColor=["match",["feature-state","decision"],"keep","#2ecc71","reject","#ff5470","#4ea1ff"];

function updateStats(){
  let k=0,r=0; for(const v of Object.values(LABELS)){ if(v==="keep")k++; else if(v==="reject")r++; }
  const an=Object.values(ANNOT).filter(a=>a&&a.length).length;
  $("stats").innerHTML=
    `<span>Total <b>${SCENES.length}</b></span><span class="k">Keep <b>${k}</b></span><span class="r">Reject <b>${r}</b></span><span style="color:var(--annot)">Dibuj <b>${an}</b></span><span style="color:#ff3b3b">Excl <b>${EXCLUDED.size}</b></span>`;
}

function passFilter(s){
  const cloud=+$("f-cloud").value, area=+$("f-area").value, dep=$("f-dep").value, unl=$("f-unlabeled").checked;
  if(s.cloud>cloud) return false;
  if((s.supafec||0)<area) return false;
  if(dep && String(s.nomdep)!==dep) return false;
  if(unl && LABELS[s.row_id]) return false;
  return true;
}
function applyMapFilter(){
  const cloud=+$("f-cloud").value, area=+$("f-area").value, dep=$("f-dep").value;
  const f=["all",["<=",["get","cloud"],cloud],[">=",["coalesce",["get","supafec"],0],area]];
  if(dep) f.push(["==",["to-string",["get","nomdep"]],dep]);
  [mapA,mapB].forEach(m=>["bbox-fill","bbox-line"].forEach(l=>m.getLayer(l)&&m.setFilter(l,f)));
}
function renderList(){
  const rows=SCENES.filter(passFilter);
  $("list").innerHTML=rows.slice(0,500).map(s=>{
    const lab=LABELS[s.row_id]||"";
    const pen=(ANNOT[s.row_id]&&ANNOT[s.row_id].length)?'<span class="pen">✏</span>':'';
    return `<div class="item ${lab} ${s.row_id===curId?'active':''}" data-id="${s.row_id}">
      <span class="tag"></span><span class="id">${esc(s.row_id)} · obj ${esc(s.objectid)} ${pen}</span>
      <span class="meta">${esc(s.a.date)}→${esc(s.b.date)} · ${esc(s.cloud)}%</span></div>`;
  }).join("")+(rows.length>500?`<div class="empty">… ${rows.length-500} más (afina filtros)</div>`:"");
  $("list").querySelectorAll(".item").forEach(el=>el.addEventListener("click",()=>selectScene(el.dataset.id)));
}
function refresh(){ applyMapFilter(); renderList(); updateStats(); }

function putImage(map, s, tag){
  const id=s.row_id;
  if(map.getLayer("sentinel")) map.removeLayer("sentinel");
  if(map.getSource("sentinel")) map.removeSource("sentinel");
  const below=map.getLayer("defo-fill")?"defo-fill":(map.getLayer("bbox-fill")?"bbox-fill":undefined);
  const op=+$("ly-op").value/100;
  const coords=[[s.bbox[0],s.bbox[3]],[s.bbox[2],s.bbox[3]],[s.bbox[2],s.bbox[1]],[s.bbox[0],s.bbox[1]]];
  const local=(LOCAL_TIFS[id]||{})[tag];
  if(local){
    const put=dec=>{ if(curId!==id) return;
      if(tag==="B") IMG_DATA[id]={imageData:dec.imageData,w:dec.w,h:dec.h};   // para la varita
      map.addSource("sentinel",{type:"image",url:dec.url,coordinates:coords});
      map.addLayer({id:"sentinel",type:"raster",source:"sentinel",paint:{"raster-opacity":op}},below);
      setVis("ly-sentinel"); };
    tifDecode(local).then(put).catch(e=>console.warn("tif",id,tag,e));
    return;
  }
  const stac=(tag==="A"?s.a.stac:s.b.stac);
  const tci=stac&&tciUrl(stac);
  if(tci){
    map.addSource("sentinel",{type:"raster",tiles:[`${TITILER}?url=${encodeURIComponent(tci)}`],tileSize:256,attribution:"Sentinel-2 L2A / AWS"});
    map.addLayer({id:"sentinel",type:"raster",source:"sentinel",paint:{"raster-opacity":op}},below);
    setVis("ly-sentinel");
  }
}

function selectScene(id){
  cancelDraw();
  curId=id;
  const s=SCENES.find(x=>x.row_id===id); if(!s) return;
  [mapA,mapB].forEach(m=>{
    m.setFilter("bbox-sel",["==",["get","row_id"],id]);
    if(m.getLayer("defo-sel")) m.setFilter("defo-sel",["==",["to-number",["get","OBJECTID"]],+s.objectid]);
  });
  putImage(mapA,s,"A");
  putImage(mapB,s,"B");
  renderAnnot();
  $("date-a").textContent=" "+(s.a.date||"")+(s.a.cloud!=null?` · ${s.a.cloud}%`:"");
  $("date-b").textContent=" "+(s.b.date||"")+(s.b.cloud!=null?` · ${s.b.cloud}%`:"");
  mapA.fitBounds(s.bbox,{padding:50,maxZoom:15,duration:600});
  renderReview(s);
  document.querySelectorAll(".item").forEach(el=>el.classList.toggle("active",el.dataset.id===id));
}
function renderReview(s){
  const lab=LABELS[s.row_id];
  const nan=(ANNOT[s.row_id]||[]).length;
  $("review").innerHTML=`
    <div class="review-body">
      <h2 class="scene-title">row ${esc(s.row_id)} · obj ${esc(s.objectid)}</h2>
      <dl class="facts">
        <dt>Antes</dt><dd>${esc(s.a.date)} · ${esc(s.a.cloud)}% nube</dd>
        <dt>Después</dt><dd>${esc(s.b.date)} · ${esc(s.b.cloud)}% nube</dd>
        <dt>Depto</dt><dd>${esc(s.nomdep??"—")}</dd>
        <dt>Área defo</dt><dd>${esc(s.supafec??"—")}</dd>
        <dt>Mis polígonos</dt><dd>${nan?`<b style="color:var(--annot)">${nan}</b>`:"0"}</dd>
        <dt>Estado</dt><dd>${lab?`<b style="color:${lab==='keep'?'var(--keep)':'var(--reject)'}">${lab==='keep'?'Mantener':'Descartar'}</b>`:"sin revisar"}</dd>
      </dl>
      <div class="acts" style="margin-bottom:8px">
        <button id="b-prev" style="background:var(--panel);color:var(--text)">← Anterior (A)</button>
        <button id="b-next" style="background:var(--panel);color:var(--text)">Siguiente (D) →</button>
      </div>
      <div class="acts">
        <button class="btn-reject" id="b-reject">Descartar (R)</button>
        <button class="btn-keep" id="b-keep">Mantener (K)</button>
      </div>
    </div>`;
  $("b-keep").addEventListener("click",()=>label("keep"));
  $("b-reject").addEventListener("click",()=>label("reject"));
  $("b-prev").addEventListener("click",()=>nav(-1));
  $("b-next").addEventListener("click",()=>nav(1));
}
function nav(dir){
  const rows=SCENES.filter(passFilter);
  if(!rows.length) return;
  let i=rows.findIndex(x=>x.row_id===curId);
  if(i<0) i=dir>0?-1:rows.length;
  const j=Math.min(rows.length-1,Math.max(0,i+dir));
  if(rows[j]) selectScene(rows[j].row_id);
}
function label(val){
  if(curId==null) return;
  const s=SCENES.find(x=>x.row_id===curId);
  if(LABELS[curId]===val){ delete LABELS[curId]; } else { LABELS[curId]=val; }
  saveLabels();
  [mapA,mapB].forEach(m=>m.setFeatureState({source:"bbox",id:+curId},{decision:LABELS[curId]||null}));
  updateStats(); renderReview(s);
  const rows=SCENES.filter(passFilter);
  const i=rows.findIndex(x=>x.row_id===curId);
  const next=rows.slice(i+1).find(x=>!LABELS[x.row_id])||rows[i+1];
  renderList();
  if(next) selectScene(next.row_id);
}

// ============ DIBUJO / VARITA ============
function setMode(m){
  MODE=m;
  ["t-pan","t-draw","t-wand"].forEach(id=>$(id).classList.toggle("on", id==="t-"+m));
  const cur=m==="pan"?"":"crosshair";
  mapB.getCanvas().style.cursor=cur;
  if(m==="draw"){ mapB.doubleClickZoom.disable(); hint("Clic en cada vértice · doble clic o Enter para cerrar · Esc cancela"); }
  else { mapB.doubleClickZoom.enable(); cancelDraw(); }
  if(m==="wand") hint(IMG_DATA[curId]?"Clic en el parche de cambio":"⚠ Carga el .tif local para usar la varita");
  if(m==="pan") hint("");
}
function hint(t){ const h=$("draw-hint"); h.textContent=t; h.style.display=t?"block":"none"; }

function annotFC(id){
  const rings=ANNOT[id]||[];
  return {type:"FeatureCollection",features:rings.map((r,i)=>({type:"Feature",id:i,
    properties:{},geometry:{type:"Polygon",coordinates:[r]}}))};
}
function renderAnnot(){
  const fc=curId!=null?annotFC(curId):{type:"FeatureCollection",features:[]};
  if(mapB.getSource("annot")) mapB.getSource("annot").setData(fc);
}
function pushRing(ring){
  if(!ring||ring.length<3||curId==null) return;
  (ANNOT[curId]=ANNOT[curId]||[]).push(ring);
  saveAnnot(); renderAnnot(); updateStats(); renderList();
  const s=SCENES.find(x=>x.row_id===curId); if(s) renderReview(s);
}

// --- dibujo manual ---
function drawTempFC(){
  const feats=[];
  if(drawPts.length) feats.push({type:"Feature",properties:{},geometry:{type:"LineString",coordinates:drawPts.concat(drawPts.length>1?[drawPts[0]]:[])}});
  drawPts.forEach(p=>feats.push({type:"Feature",properties:{},geometry:{type:"Point",coordinates:p}}));
  return {type:"FeatureCollection",features:feats};
}
function renderDrawTemp(){ if(mapB.getSource("draw-temp")) mapB.getSource("draw-temp").setData(drawTempFC()); }
function addVertex(lngLat){ drawPts.push([lngLat.lng,lngLat.lat]); renderDrawTemp(); }
function finalizeDraw(){
  if(drawPts.length>=3){ const r=drawPts.slice(); r.push(r[0]); pushRing(r); }
  drawPts=[]; renderDrawTemp();
}
function cancelDraw(){ drawPts=[]; renderDrawTemp(); }

// --- varita mágica (sobre el .tif local de "después") ---
function lonlatToPx(s,lon,lat,W,H){
  const [minx,miny,maxx,maxy]=s.bbox;
  let col=Math.floor((lon-minx)/(maxx-minx)*W);
  let row=Math.floor((maxy-lat)/(maxy-miny)*H);
  col=Math.max(0,Math.min(W-1,col)); row=Math.max(0,Math.min(H-1,row));
  return [col,row];
}
function pxToLonlat(s,x,y,W,H){
  const [minx,miny,maxx,maxy]=s.bbox;
  return [minx+(x/W)*(maxx-minx), maxy-(y/H)*(maxy-miny)];
}
// dilata la máscara binaria r píxeles (disco) -> agranda la selección de la varita
function dilateMask(mask,r){
  if(r<=0) return mask;
  const W=mask.width,H=mask.height,src=mask.data,out=new Uint8Array(W*H),r2=r*r;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    if(!src[y*W+x]) continue;
    for(let dy=-r;dy<=r;dy++){const yy=y+dy; if(yy<0||yy>=H)continue;
      for(let dx=-r;dx<=r;dx++){const xx=x+dx; if(xx<0||xx>=W)continue;
        if(dx*dx+dy*dy<=r2) out[yy*W+xx]=1;}}
  }
  let minX=W,minY=H,maxX=0,maxY=0;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++) if(out[y*W+x]){
    if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; }
  return {data:out,width:W,height:H,bounds:{minX,minY,maxX,maxY}};
}
function wandAt(lngLat){
  const s=SCENES.find(x=>x.row_id===curId); if(!s) return;
  const d=IMG_DATA[curId];
  if(!d){ hint("⚠ Carga el .tif local para usar la varita"); return; }
  if(typeof MagicWand==="undefined"){ console.warn("MagicWand no cargó"); return; }
  const {imageData,w:W,h:H}=d;
  const [px,py]=lonlatToPx(s,lngLat.lng,lngLat.lat,W,H);
  const image={data:imageData.data,width:W,height:H,bytes:4};
  const thr=+$("wand-thr").value;
  let mask=MagicWand.floodFill(image,px,py,thr);
  if(!mask) return;
  const buf=+$("wand-buf").value;
  if(buf>0) mask=dilateMask(mask,buf);          // agranda la zona (buffer)
  let contours=MagicWand.traceContours(mask);
  contours=MagicWand.simplifyContours(contours,2,30);
  let added=0;
  contours.filter(c=>!c.inner).forEach(c=>{
    if(c.points.length<3) return;
    const ring=c.points.map(p=>pxToLonlat(s,p.x,p.y,W,H));
    ring.push(ring[0]);
    pushRing(ring); added++;
  });
  if(!added) hint("La varita no encontró región — sube la tolerancia");
}

$("t-pan").addEventListener("click",()=>setMode("pan"));
$("t-draw").addEventListener("click",()=>setMode("draw"));
$("t-wand").addEventListener("click",()=>setMode("wand"));
$("t-undo").addEventListener("click",()=>{
  if(curId!=null && ANNOT[curId] && ANNOT[curId].length){ ANNOT[curId].pop(); saveAnnot(); renderAnnot(); updateStats(); renderList();
    const s=SCENES.find(x=>x.row_id===curId); if(s) renderReview(s); }
});
$("t-clear").addEventListener("click",()=>{
  if(curId!=null && confirm("¿Borrar mis polígonos de este par?")){ delete ANNOT[curId]; saveAnnot(); renderAnnot(); updateStats(); renderList();
    const s=SCENES.find(x=>x.row_id===curId); if(s) renderReview(s); }
});
$("wand-thr").addEventListener("input",e=>$("wand-thr-v").textContent=e.target.value);
$("wand-buf").addEventListener("input",e=>$("wand-buf-v").textContent=e.target.value);

document.addEventListener("keydown",e=>{
  if(e.target.tagName==="INPUT"||e.target.tagName==="SELECT") return;
  if(MODE==="draw"){
    if(e.key==="Enter"){ e.preventDefault(); finalizeDraw(); return; }
    if(e.key==="Escape"){ e.preventDefault(); cancelDraw(); return; }
  }
  if(e.key==="k"||e.key==="K") label("keep");
  if(e.key==="r"||e.key==="R") label("reject");
  if(e.key==="ArrowLeft"||e.key==="a"||e.key==="A"){ e.preventDefault(); nav(-1); }
  if(e.key==="ArrowRight"||e.key==="d"||e.key==="D"){ e.preventDefault(); nav(1); }
});

// ---- export ----
function download(name,obj){
  const blob=new Blob([JSON.stringify(obj,null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=name; a.click();
}
$("exp-keep").addEventListener("click",()=>
  download("seleccion_keep_cd.json",SCENES.filter(s=>LABELS[s.row_id]==="keep").map(s=>({row_id:s.row_id,objectid:s.objectid,stac_item:s.b.stac}))));
$("exp-annot").addEventListener("click",()=>{
  const feats=[];
  for(const [rid,rings] of Object.entries(ANNOT)){
    const s=SCENES.find(x=>x.row_id===rid);
    (rings||[]).forEach(r=>feats.push({type:"Feature",
      properties:{row_id:rid,objectid:s?s.objectid:null},geometry:{type:"Polygon",coordinates:[r]}}));
  }
  download("anotaciones_cd.geojson",{type:"FeatureCollection",features:feats});
});
$("exp-excl").addEventListener("click",()=>
  download("objectid_excluidos.json",[...EXCLUDED].map(Number).sort((a,b)=>a-b)));
$("reset").addEventListener("click",()=>{
  if(!confirm("¿Borrar todas las etiquetas? (no toca tus polígonos dibujados)")) return;
  LABELS={}; saveLabels();
  [mapA,mapB].forEach(m=>SCENES.forEach(s=>m.setFeatureState({source:"bbox",id:+s.row_id},{decision:null})));
  refresh();
});
["f-cloud","f-area","f-dep","f-unlabeled"].forEach(id=>$(id).addEventListener("input",refresh));
$("f-cloud").addEventListener("input",e=>$("cloud-val").textContent=e.target.value+"%");
$("f-area").addEventListener("input",e=>$("area-val").textContent=e.target.value);

// ---- construir escenas desde manifest CD ----
function buildScenes(manifest){
  SCENES=[]; const feats=[]; const deps=new Set(); let nok=0;
  for(const [id,v] of Object.entries(manifest)){
    if(v.status!=="ok"||!v.bbox||!v.antes||!v.despues) continue; nok++;
    const m=META[String((v.objectid|0))]||{};
    const cloud=Math.max(v.antes.cloud||0, v.despues.cloud||0);
    SCENES.push({row_id:id,objectid:v.objectid,bbox:v.bbox,
      a:{stac:v.antes.stac_item,date:v.antes.datetime,cloud:v.antes.cloud},
      b:{stac:v.despues.stac_item,date:v.despues.datetime,cloud:v.despues.cloud},
      cloud, nomdep:m.nomdep, supafec:m.supafec});
    if(m.nomdep!=null) deps.add(String(m.nomdep));
    feats.push({type:"Feature",id:+id,
      properties:{row_id:id,cloud,nomdep:m.nomdep==null?"":String(m.nomdep),supafec:m.supafec||0},
      geometry:{type:"Polygon",coordinates:bboxPoly(v.bbox)}});
  }
  const sel=$("f-dep"); sel.innerHTML='<option value="">todos</option>';
  [...deps].sort().forEach(d=>{const o=document.createElement("option");o.value=d;o.textContent="Depto "+d;sel.appendChild(o);});

  const fc={type:"FeatureCollection",features:feats};
  [mapA,mapB].forEach(m=>{
    if(m.getSource("bbox")){ m.getSource("bbox").setData(fc); }
    else {
      m.addSource("bbox",{type:"geojson",data:fc});
      m.addLayer({id:"bbox-fill",type:"fill",source:"bbox",paint:{"fill-color":decColor,"fill-opacity":0.10}});
      m.addLayer({id:"bbox-line",type:"line",source:"bbox",paint:{"line-color":decColor,"line-width":1}});
      m.addLayer({id:"bbox-sel",type:"line",source:"bbox",filter:["==",["get","row_id"],"__none__"],paint:{"line-color":"#ffd24e","line-width":2.5}});
    }
    for(const [id,val] of Object.entries(LABELS)) m.setFeatureState({source:"bbox",id:+id},{decision:val});
  });
  ensureAnnotLayers();
  applyAllVis();
  bindInteractions();

  const b=new maplibregl.LngLatBounds();
  feats.forEach(f=>{f.geometry.coordinates[0].forEach(p=>b.extend(p));});
  if(!b.isEmpty()) mapA.fitBounds(b,{padding:40,maxZoom:9,duration:600});

  $("drop").style.display="none";
  $("io-status").textContent=`${nok} pares ok cargados`+(Object.keys(META).length?"":" · (sin geojson: filtros depto/área off)");
  refresh();
}
// capas de anotación (mis polígonos) + dibujo temporal, solo en mapB
function ensureAnnotLayers(){
  if(!mapB.getSource("annot")){
    mapB.addSource("annot",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
    mapB.addLayer({id:"annot-fill",type:"fill",source:"annot",paint:{"fill-color":"#34d399","fill-opacity":0.35}});
    mapB.addLayer({id:"annot-line",type:"line",source:"annot",paint:{"line-color":"#34d399","line-width":2}});
  }
  if(!mapB.getSource("draw-temp")){
    mapB.addSource("draw-temp",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
    mapB.addLayer({id:"draw-line",type:"line",source:"draw-temp",filter:["==","$type","LineString"],paint:{"line-color":"#ffd24e","line-width":2,"line-dasharray":[2,1]}});
    mapB.addLayer({id:"draw-pts",type:"circle",source:"draw-temp",filter:["==","$type","Point"],paint:{"circle-radius":4,"circle-color":"#ffd24e"}});
  }
}
function bindInteractions(){
  if(bound) return; bound=true;
  // hover popups en ambos
  [mapA,mapB].forEach(m=>{
    const popup=new maplibregl.Popup({closeButton:false,offset:6});
    m.on("mouseenter","bbox-fill",e=>{m.getCanvas().style.cursor=(m===mapB&&MODE!=="pan")?"crosshair":"pointer";const p=e.features[0].properties;
      popup.setLngLat(e.lngLat).setHTML(`<strong>row ${esc(p.row_id)}</strong><br>${esc(p.cloud)}% nube`).addTo(m);});
    m.on("mousemove","bbox-fill",e=>popup.setLngLat(e.lngLat));
    m.on("mouseleave","bbox-fill",()=>{m.getCanvas().style.cursor=(m===mapB&&MODE!=="pan")?"crosshair":"";popup.remove();});
  });
  // mapA: solo seleccionar / excluir
  mapA.on("click",e=>handlePick(mapA,e));
  // mapB: según modo
  mapB.on("click",e=>{
    if(MODE==="draw"){ addVertex(e.lngLat); return; }
    if(MODE==="wand"){ wandAt(e.lngLat); return; }
    handlePick(mapB,e);
  });
  mapB.on("dblclick",e=>{ if(MODE==="draw"){ e.preventDefault(); finalizeDraw(); } });
}
function handlePick(m,e){
  if(m.getLayer("defo-fill")){
    const df=m.queryRenderedFeatures(e.point,{layers:["defo-fill"]});
    if(df.length){ toggleExclude(df[0].id); return; }
  }
  const bf=m.queryRenderedFeatures(e.point,{layers:["bbox-fill"]});
  if(bf.length) selectScene(bf[0].properties.row_id);
}
function toggleExclude(oid){
  if(oid==null) return;
  const k=String(oid), on=!EXCLUDED.has(k);
  if(on) EXCLUDED.add(k); else EXCLUDED.delete(k);
  [mapA,mapB].forEach(m=>m.getSource("defo")&&m.setFeatureState({source:"defo",id:oid},{excluded:on}));
  saveExcl(); updateStats();
}

// ---- capas ----
const LAYER_GROUPS={
  "ly-sentinel":["sentinel"],
  "ly-defo":["defo-fill","defo-line","defo-sel"],
  "ly-annot":["annot-fill","annot-line"],
  "ly-bbox":["bbox-fill","bbox-line","bbox-sel"],
};
function setVis(id){
  const on=$(id).checked;
  [mapA,mapB].forEach(m=>LAYER_GROUPS[id].forEach(l=>{ if(m.getLayer(l)) m.setLayoutProperty(l,"visibility",on?"visible":"none"); }));
}
function applyAllVis(){ Object.keys(LAYER_GROUPS).forEach(setVis); }
Object.keys(LAYER_GROUPS).forEach(id=>$(id).addEventListener("change",()=>setVis(id)));
$("ly-op").addEventListener("input",e=>{
  const v=+e.target.value/100;
  [mapA,mapB].forEach(m=>m.getLayer("sentinel")&&m.setPaintProperty("sentinel","raster-opacity",v));
});

// ---- persistencia (IndexedDB): manifest + handle de la carpeta de imágenes ----
const idb={
  open(){return new Promise((res,rej)=>{const r=indexedDB.open("defo_curator_cd",1);
    r.onupgradeneeded=()=>r.result.createObjectStore("kv");
    r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);});},
  async set(k,v){const db=await this.open();return new Promise((res,rej)=>{const t=db.transaction("kv","readwrite");t.objectStore("kv").put(v,k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error);});},
  async get(k){const db=await this.open();return new Promise((res,rej)=>{const t=db.transaction("kv","readonly");const q=t.objectStore("kv").get(k);q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});},
};

// ---- file inputs ----
function readJSON(file,cb){
  const r=new FileReader();
  r.onload=()=>{ try{ cb(JSON.parse(r.result)); }catch(e){ alert("JSON inválido: "+e.message); } };
  r.readAsText(file);
}
function onManifestFile(e){
  const f=e.target.files[0]; if(!f) return;
  $("io-status").textContent="leyendo "+f.name+"…";
  readJSON(f, m=>{
    idb.set("manifest",m).catch(()=>{});           // recordar para el próximo refresh
    const go=()=>buildScenes(m);
    (mapA.loaded()&&mapB.loaded())?go():mapB.on("load",go);
  });
}
$("mf-input").addEventListener("change",onManifestFile);
$("mf-input2").addEventListener("change",onManifestFile);

function setTifs(pairs){
  LOCAL_TIFS={}; let n=0;
  for(const {name,file} of pairs){
    const m=name.match(/^s2_(\d+)_([AB])_\d+\.tiff?$/i);
    if(m){ (LOCAL_TIFS[m[1]]=LOCAL_TIFS[m[1]]||{})[m[2].toUpperCase()]=file; n++; }
  }
  $("io-status").textContent=`${n} .tif locales (A/B) cargados`+(SCENES.length?"":" · carga también el manifest");
  $("reconnect-row").style.display="none";
  if(curId!=null) selectScene(curId);
}
function onDirInput(e){
  const files=[...e.target.files].filter(f=>/\.tiff?$/i.test(f.name));
  setTifs(files.map(f=>({name:f.name,file:f})));
}
$("dir-input").addEventListener("change",onDirInput);

async function scanDirHandle(handle){
  const pairs=[];
  for await (const entry of handle.values())
    if(entry.kind==="file" && /\.tiff?$/i.test(entry.name)) pairs.push({name:entry.name,file:await entry.getFile()});
  setTifs(pairs);
}
async function pickDirectory(){
  try{
    const handle=await window.showDirectoryPicker();
    await idb.set("dirHandle",handle).catch(()=>{});   // recordar la carpeta
    await scanDirHandle(handle);
  }catch(e){ if(e.name!=="AbortError") console.warn("pickDirectory",e); }
}
$("dir-btn").addEventListener("click",()=>{ if(window.showDirectoryPicker) pickDirectory(); else $("dir-input").click(); });

// reconecta la carpeta guardada (tras refresh). El navegador exige un gesto del
// usuario para re-dar permiso, por eso mostramos el botón "Reconectar".
async function restoreDirectory(){
  if(!window.showDirectoryPicker) return;
  let handle; try{ handle=await idb.get("dirHandle"); }catch(e){ return; }
  if(!handle) return;
  const perm=await handle.queryPermission({mode:"read"});
  if(perm==="granted"){ scanDirHandle(handle); return; }
  $("reconnect-row").style.display="flex";
  $("dir-reconnect").onclick=async()=>{
    const p=await handle.requestPermission({mode:"read"});
    if(p==="granted") scanDirHandle(handle);
  };
}

// ---- overlay deforestación ----
async function loadDefo(map){
  const defo=await fetch(GEOJSON_URL).then(r=>r.json());
  if(!Object.keys(META).length)
    for(const f of defo.features){ const p=f.properties; META[String(p.OBJECTID|0)]={nomdep:p.NOMDEP,supafec:p.SUPAFEC}; }
  map.addSource("defo",{type:"geojson",data:defo,promoteId:"OBJECTID"});
  const below=map.getLayer("bbox-fill")?"bbox-fill":undefined;
  const exclColor=["case",["boolean",["feature-state","excluded"],false],"#ff3b3b","#ff8a4e"];
  map.addLayer({id:"defo-fill",type:"fill",source:"defo",paint:{"fill-color":exclColor,"fill-opacity":["case",["boolean",["feature-state","excluded"],false],0.45,0.38]}},below);
  map.addLayer({id:"defo-line",type:"line",source:"defo",paint:{"line-color":exclColor,"line-width":1.2,"line-opacity":0.9}},below);
  map.addLayer({id:"defo-sel",type:"line",source:"defo",filter:["==",["to-number",["get","OBJECTID"]],-1],paint:{"line-color":"#ffd24e","line-width":2.5}},below);
  EXCLUDED.forEach(oid=>map.setFeatureState({source:"defo",id:oid},{excluded:true}));
}
async function onMapReady(map){
  try{ await loadDefo(map); }catch(e){ console.warn("sin deforestacion.geojson:",e); }
  if(SCENES.length){ SCENES.forEach(s=>{const m=META[String(s.objectid|0)]||{};s.nomdep=m.nomdep;s.supafec=m.supafec;}); refresh(); }
  applyAllVis();
}
mapA.on("load",()=>onMapReady(mapA));
mapB.on("load",async()=>{
  await onMapReady(mapB);
  ensureAnnotLayers();
  // 1) manifest recordado del refresh anterior
  try{
    if(!SCENES.length){
      const saved=await idb.get("manifest");
      if(saved){ buildScenes(saved); $("io-status").textContent="manifest restaurado (sesión anterior)"; }
    }
  }catch(e){ console.warn("sin manifest recordado:",e); }
  // 2) manifest bundled (si lo dejas en el folder)
  try{
    if(!SCENES.length){
      const mf=await fetch("sentinel_manifest_cd.json").then(r=>r.ok?r.json():null);
      if(mf) buildScenes(mf);
    }
  }catch(e){ console.warn("sin manifest CD bundled:",e); }
  // 3) reconectar la carpeta de imágenes guardada
  restoreDirectory();
});
