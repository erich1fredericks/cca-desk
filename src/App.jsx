/* eslint-disable no-unused-vars */
import { useState, useMemo, useEffect } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const MONTHS    = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const Q_SHORT   = ["Q1","Q2","Q3","Q4"];
const Q_COLORS  = ["#38bdf8","#a78bfa","#34d399","#fb923c"];
const STRIKES   = Array.from({length:36},(x,i)=>i+15); // 15‥50

// Quarterly expiry months: Mar=2, Jun=5, Sep=8, Dec=11
const Q_MONTHS  = [2,5,8,11];

// All quarterly contracts from Apr-26 through Dec-27
// Apr-26 is NOT a standard quarterly expiry itself — the first expiry from Apr-26 onward is Jun-26
// But we want the CURVE to start at Apr-26 (first month displayed).
// Options expiries available: Jun-26, Sep-26, Dec-26, Mar-27, Jun-27, Sep-27, Dec-27
const OPTIONS_EXPIRIES = [
  {label:"Jun-26", month:5,  year:2026},
  {label:"Sep-26", month:8,  year:2026},
  {label:"Dec-26", month:11, year:2026},
  {label:"Mar-27", month:2,  year:2027},
  {label:"Jun-27", month:5,  year:2027},
  {label:"Sep-27", month:8,  year:2027},
  {label:"Dec-27", month:11, year:2027},
];

// ─── Math ─────────────────────────────────────────────────────────────────────
function erf(x) {
  const a = Math.abs(x);
  const t = 1/(1+0.3275911*a);
  const p = t*(0.254829592+t*(-0.284496736+t*(1.421413741+t*(-1.453152027+t*1.061405429))));
  const r = 1 - p*Math.exp(-a*a);
  return x < 0 ? -r : r;
}
const normCDF = x => 0.5*(1+erf(x/Math.SQRT2));
const normPDF = x => Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI);

function bsCall(F,K,T,r,s){
  if(T<=0||s<=0) return Math.max(F-K,0);
  const d1=(Math.log(F/K)+0.5*s*s*T)/(s*Math.sqrt(T)), d2=d1-s*Math.sqrt(T);
  return Math.exp(-r*T)*(F*normCDF(d1)-K*normCDF(d2));
}
function bsPut(F,K,T,r,s){
  if(T<=0||s<=0) return Math.max(K-F,0);
  const d1=(Math.log(F/K)+0.5*s*s*T)/(s*Math.sqrt(T)), d2=d1-s*Math.sqrt(T);
  return Math.exp(-r*T)*(K*normCDF(-d2)-F*normCDF(-d1));
}
function bsDelta(F,K,T,r,s,call){
  if(T<=0||s<=0) return call?(F>K?1:0):(F<K?-1:0);
  const d1=(Math.log(F/K)+0.5*s*s*T)/(s*Math.sqrt(T));
  return call?Math.exp(-r*T)*normCDF(d1):-Math.exp(-r*T)*normCDF(-d1);
}
function bsGamma(F,K,T,r,s){
  if(T<=0||s<=0) return 0;
  const d1=(Math.log(F/K)+0.5*s*s*T)/(s*Math.sqrt(T));
  return Math.exp(-r*T)*normPDF(d1)/(F*s*Math.sqrt(T));
}
function bsTheta(F,K,T,r,s,call){
  if(T<=0||s<=0) return 0;
  const d1=(Math.log(F/K)+0.5*s*s*T)/(s*Math.sqrt(T)), d2=d1-s*Math.sqrt(T);
  const t1=-F*Math.exp(-r*T)*normPDF(d1)*s/(2*Math.sqrt(T));
  return call?(t1-r*K*Math.exp(-r*T)*normCDF(d2)+r*F*Math.exp(-r*T)*normCDF(d1))/365
             :(t1+r*K*Math.exp(-r*T)*normCDF(-d2)-r*F*Math.exp(-r*T)*normCDF(-d1))/365;
}
function bsVega(F,K,T,r,s){
  if(T<=0||s<=0) return 0;
  const d1=(Math.log(F/K)+0.5*s*s*T)/(s*Math.sqrt(T));
  return F*Math.exp(-r*T)*normPDF(d1)*Math.sqrt(T)/100;
}

// ─── Vol surface: SVI-inspired parametric smile ───────────────────────────────
// sigma(K) = atmVol + skew*(ln(K/F)) + convexity*(ln(K/F))^2 + perStrikeAdj[K]
function strikeVol(K, F, atmVol, skew, convexity, adj) {
  const m = Math.log(K/F);
  return Math.max(0.01, atmVol + skew*m + convexity*m*m + (adj||0)/100);
}

// ─── Futures curve ────────────────────────────────────────────────────────────
function getQuarter(m){ return Math.floor(m/3); }

function buildForwardCurve(anchorPrice, quarterRates, baseRate) {
  // Anchor = Dec-26 (nearest December from today if today < Dec 2026)
  const dec1Year = 2026, dec2Year = 2027;
  const anchorDate = new Date(dec1Year, 11, 15);

  // Start curve at Apr-26

  let y = 2026, m = 3;
  const curve = [];

  while(true){
    const cellDate = new Date(y, m, 15);
    const dtYears = (cellDate - anchorDate)/(365.25*24*3600*1000);
    let logCarry = 0;

    if(dtYears >= 0){
      let sy=dec1Year, sm=11;
      while(!(sy===y&&sm===m)){
        sm++; if(sm>11){sm=0;sy++;}
        const r2 = (sy===dec1Year) ? quarterRates[getQuarter(sm)] : baseRate;
        logCarry += (r2/100)/12;
      }
    } else {
      let sy=dec1Year, sm=11;
      while(!(sy===y&&sm===m)){
        const r2 = (sy===dec1Year) ? quarterRates[getQuarter(sm)] : baseRate;
        logCarry -= (r2/100)/12;
        sm--; if(sm<0){sm=11;sy--;}
      }
    }

    const isQExpiry = Q_MONTHS.includes(m);
    curve.push({
      label:`${MONTHS[m]}-${String(y).slice(2)}`,
      month:m, year:y,
      price: anchorPrice*Math.exp(logCarry),
      isDecember: m===11,
      isAnchor: y===dec1Year && m===11,
      quarter: getQuarter(m),
      inAnchorYear: y===dec1Year,
      isQExpiry,
      effectiveRate: y===dec1Year ? quarterRates[getQuarter(m)] : baseRate,
    });

    if(y===dec2Year && m===11) break;
    m++; if(m>11){m=0;y++;}
  }
  return curve;
}

// ─── Vol Smile SVG Chart ──────────────────────────────────────────────────────
function VolSmileChart({strikes, volFn, F, atmVol}){
  const W=360, H=120, PL=38, PR=12, PT=12, PB=26;
  const iW=W-PL-PR, iH=H-PT-PB;
  const vols = strikes.map(k=>volFn(k)*100);
  const minV = Math.max(0, Math.min(...vols)-3);
  const maxV = Math.max(...vols)+3;
  const xS = i => (strikes[i]-strikes[0])/(strikes[strikes.length-1]-strikes[0])*iW;
  const yS = v => iH-(v-minV)/(maxV-minV)*iH;
  const pts = strikes.map((_,i)=>`${PL+xS(i)},${PT+yS(vols[i])}`).join(" ");
  const atmX = PL + Math.max(0,Math.min(1,(F-strikes[0])/(strikes[strikes.length-1]-strikes[0])))*iW;
  const atmY = PT + yS(volFn(F)*100);
  const gridVs = [minV,(minV+maxV)/2,maxV];
  return (
    <svg width={W} height={H} style={{display:"block",overflow:"visible"}}>
      {gridVs.map(v=>{
        const gy=PT+yS(v);
        return <g key={v}>
          <line x1={PL} y1={gy} x2={PL+iW} y2={gy} stroke="#182030" strokeWidth={0.5}/>
          <text x={PL-4} y={gy+3} textAnchor="end" fontSize={7} fill="#334155">{v.toFixed(0)}%</text>
        </g>;
      })}
      {[15,20,25,30,35,40,45,50].map(k=>{
        const gx=PL+(k-15)/35*iW;
        return <text key={k} x={gx} y={H-6} textAnchor="middle" fontSize={7} fill="#334155">{k}</text>;
      })}
      {/* ATM dashed line */}
      <line x1={atmX} y1={PT} x2={atmX} y2={PT+iH} stroke="#38bdf844" strokeWidth={1} strokeDasharray="3,2"/>
      <text x={atmX+3} y={PT+9} fontSize={7} fill="#38bdf8">ATM</text>
      {/* Area fill */}
      <polygon points={`${PL+xS(0)},${PT+iH} ${pts} ${PL+xS(strikes.length-1)},${PT+iH}`}
        fill="url(#smileGrad)" opacity={0.15}/>
      <defs>
        <linearGradient id="smileGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#38bdf8"/>
          <stop offset="100%" stopColor="#38bdf800"/>
        </linearGradient>
      </defs>
      {/* Smile line */}
      <polyline points={pts} fill="none" stroke="#38bdf8" strokeWidth={1.5} strokeLinejoin="round"/>
      {/* ATM dot */}
      <circle cx={atmX} cy={atmY} r={3} fill="#38bdf8"/>
    </svg>
  );
}

// ─── Slider control ───────────────────────────────────────────────────────────
function VolSlider({label, value, min, max, step, onChange, color="#38bdf8", format, hint}){
  const pct = ((value-min)/(max-min)*100).toFixed(1);
  return (
    <div style={{marginBottom:14}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:6}}>
        <div>
          <span style={{fontSize:9,letterSpacing:"0.14em",color:"#475569",textTransform:"uppercase"}}>{label}</span>
          {hint && <span style={{fontSize:8,color:"#334155",marginLeft:8}}>{hint}</span>}
        </div>
        <span style={{fontSize:16,fontWeight:600,color,fontFamily:"'IBM Plex Mono',monospace"}}>
          {format ? format(value) : value}
        </span>
      </div>
      <div style={{position:"relative"}}>
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={e=>onChange(parseFloat(e.target.value))}
          style={{
            width:"100%",
            background:`linear-gradient(to right, ${color} ${pct}%, #182030 ${pct}%)`,
            accentColor:color,
          }}
        />
      </div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:7,color:"#1e2d3d",marginTop:2}}>
        <span>{format?format(min):min}</span><span>{format?format(max):max}</span>
      </div>
    </div>
  );
}

// ─── Rate input ───────────────────────────────────────────────────────────────
function RateInput({value,onChange,color,label}){
  const [loc,setLoc]=useState(String(value));
  useEffect(()=>setLoc(String(value)),[value]);
  const commit=v=>{const n=parseFloat(v);if(!isNaN(n)&&n>=0)onChange(n);else setLoc(String(value));};
  return (
    <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"center"}}>
      <div style={{width:22,height:2,borderRadius:2,background:color,opacity:0.75}}/>
      <div style={{fontSize:8,letterSpacing:"0.14em",color:"#475569",textTransform:"uppercase"}}>{label}</div>
      <div style={{display:"flex",alignItems:"center",gap:2}}>
        <input type="number" step="0.01" value={loc}
          onChange={e=>setLoc(e.target.value)}
          onBlur={e=>commit(e.target.value)}
          onKeyDown={e=>{if(e.key==="Enter")commit(e.target.value);}}
          style={{background:"#0b0f18",border:`1px solid ${color}44`,color,fontFamily:"'IBM Plex Mono',monospace",
            fontSize:13,fontWeight:600,padding:"4px 6px",width:58,outline:"none",borderRadius:2,textAlign:"right"}}
          onFocus={e=>{e.target.style.borderColor=color;}}
          onBlurCapture={e=>{e.target.style.borderColor=`${color}44`;}}
        />
        <span style={{color,fontSize:11}}>%</span>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function CCADesk() {
  // ── Futures state
  const [anchorPrice,setAnchorPrice] = useState(30.00);
  const [priceInput,setPriceInput]   = useState("30.00");
  const [quarterRates,setQuarterRates] = useState([5.25,5.00,4.75,4.50]);
  const [baseRate,setBaseRate]         = useState(4.25);

  // ── Vol surface state
  const [atmVol,setAtmVol]       = useState(0.35);   // 35%
  const [skew,setSkew]           = useState(-0.08);  // negative = put skew (typical for carbon)
  const [convexity,setConvexity] = useState(0.20);   // smile curvature
  const [perStrikeAdj,setPerStrikeAdj] = useState(
    Object.fromEntries(STRIKES.map(k=>[k,0]))
  );

  // ── Options state
  const [selectedExpiry,setSelectedExpiry] = useState("Dec-26");
  const [greeksMode,setGreeksMode]         = useState(false);
  const [tab,setTab]                       = useState(0);

  // ── Spread state
  const [spreadNear,setSpreadNear] = useState("Apr-26");
  const [spreadFar,setSpreadFar]   = useState("Dec-26");

  function setQR(i,v){ setQuarterRates(p=>p.map((r,j)=>j===i?v:r)); }
  function commitPrice(v){ const n=parseFloat(v); if(!isNaN(n)&&n>0) setAnchorPrice(n); }

  // ── Futures curve
  const curve = useMemo(()=>buildForwardCurve(anchorPrice,quarterRates,baseRate),[anchorPrice,quarterRates,baseRate]);

  // Map label → {price, T}
  const expiryPriceMap = useMemo(()=>{
    const today = new Date();
    const map = {};
    for(const c of curve){
      const key=`${MONTHS[c.month].slice(0,3)}-${String(c.year).slice(2)}`;
      const expDate = new Date(c.year,c.month,15);
      const T = Math.max((expDate-today)/(365*24*3600*1000),0.003);
      map[key]={price:c.price, T, label:key, month:c.month, year:c.year};
    }
    return map;
  },[curve]);

  // ── Spread calculator
  const curveMap = useMemo(()=>{
    const m={};
    curve.forEach(c=>{ m[c.label]={price:c.price,month:c.month,year:c.year}; });
    return m;
  },[curve]);

  const spreadNearData = curveMap[spreadNear];
  const spreadFarData  = curveMap[spreadFar];
  const spreadResult = useMemo(()=>{
    if(!spreadNearData||!spreadFarData||spreadNear===spreadFar) return null;
    const nearDate = new Date(spreadNearData.year, spreadNearData.month, 15);
    const farDate  = new Date(spreadFarData.year,  spreadFarData.month,  15);
    const days = Math.round((farDate - nearDate)/(24*3600*1000));
    const spread = spreadFarData.price - spreadNearData.price;
    const spreadPct = (spread / spreadNearData.price)*100;
    const tYears = Math.abs(days)/365;
    // annualized: ln(far/near) / T
    const annualizedRate = tYears > 0 ? (Math.log(spreadFarData.price/spreadNearData.price)/tYears)*100 : 0;
    return { spread, spreadPct, days, annualizedRate };
  },[spreadNear,spreadFar,spreadNearData,spreadFarData]);

  const activeExp = expiryPriceMap[selectedExpiry] || Object.values(expiryPriceMap)[0];
  const F   = activeExp?.price ?? anchorPrice;
  const T   = activeExp?.T ?? 0.5;
  const r   = baseRate/100;

  // ── Vol function for this expiry
  const volFn = useMemo(()=>(K)=>strikeVol(K,F,atmVol,skew,convexity,perStrikeAdj[K]),[F,atmVol,skew,convexity,perStrikeAdj]);

  // ── Options rows
  const rows = useMemo(()=>STRIKES.map(K=>{
    const s   = volFn(K);
    const call= bsCall(F,K,T,r,s);
    const put = bsPut(F,K,T,r,s);
    return {
      K, s, call, put,
      cDelta:bsDelta(F,K,T,r,s,true),
      pDelta:bsDelta(F,K,T,r,s,false),
      gamma: bsGamma(F,K,T,r,s),
      cTheta:bsTheta(F,K,T,r,s,true),
      pTheta:bsTheta(F,K,T,r,s,false),
      vega:  bsVega(F,K,T,r,s),
    };
  }),[F,T,r,volFn]);

  const maxCall = Math.max(...rows.map(r=>r.call));
  const maxPut  = Math.max(...rows.map(r=>r.put));

  // ── Futures table grouping
  const minP = Math.min(...curve.map(c=>c.price));
  const maxP = Math.max(...curve.map(c=>c.price));
  const pRange = maxP-minP||1;
  const byYear = {};
  curve.forEach(c=>{ if(!byYear[c.year])byYear[c.year]=[]; byYear[c.year].push(c); });

  const pctFmt = v=>`${(v*100).toFixed(1)}%`;
  const skewFmt = v=>`${v>=0?"+":""}${(v*100).toFixed(1)}%`;

  return (
    <div style={{minHeight:"100vh",background:"#070b10",color:"#d8e2ef",fontFamily:"'IBM Plex Mono','Courier New',monospace",padding:"20px 18px"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=IBM+Plex+Sans:wght@300;400;600&display=swap');
        *{box-sizing:border-box;}
        input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;}
        input[type=range]{-webkit-appearance:none;appearance:none;height:4px;border-radius:2px;outline:none;cursor:pointer;}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:13px;height:13px;border-radius:50%;cursor:pointer;border:2px solid #070b10;}
        .rh{transition:background 0.1s;}
        .rh:hover{background:rgba(56,189,248,0.04)!important;}
        .panel{background:#0b0f18;border:1px solid #182030;border-radius:3px;padding:12px 15px;}
        .tab-btn{cursor:pointer;padding:5px 14px;font-size:9px;letter-spacing:0.12em;text-transform:uppercase;border-bottom:2px solid transparent;transition:all 0.15s;background:transparent;color:#334155;font-family:'IBM Plex Mono',monospace;border-top:none;border-left:none;border-right:none;}
        .tab-btn.on{color:#38bdf8;border-bottom-color:#38bdf8;}
        .tab-btn:hover:not(.on){color:#64748b;}
        .exp-btn{cursor:pointer;padding:3px 9px;font-size:9px;font-family:'IBM Plex Mono',monospace;letter-spacing:0.08em;border-radius:2px;border:1px solid #182030;background:#0b0f18;color:#475569;transition:all 0.15s;white-space:nowrap;}
        .exp-btn.on{background:#0d1f2f;border-color:#38bdf8;color:#38bdf8;}
        .vadj{width:40px;background:#070b10;border:1px solid #182030;color:#a78bfa;font-family:'IBM Plex Mono',monospace;font-size:10px;padding:2px 3px;text-align:center;outline:none;border-radius:2px;}
        .vadj:focus{border-color:#a78bfa;}
        .gtog{cursor:pointer;font-size:8px;letter-spacing:0.1em;padding:3px 8px;border:1px solid #182030;border-radius:2px;font-family:'IBM Plex Mono',monospace;transition:all 0.15s;background:transparent;}
        .gtog.on{border-color:#a78bfa55;color:#a78bfa;}
        .gtog:not(.on){color:#475569;}
      `}</style>

      {/* ── Header */}
      <div style={{marginBottom:16}}>
        <div style={{display:"flex",gap:8,alignItems:"baseline",marginBottom:2}}>
          <span style={{fontSize:9,letterSpacing:"0.22em",color:"#2d3d50",textTransform:"uppercase"}}>California Carbon Allowances</span>
          <span style={{color:"#182030"}}>|</span>
          <span style={{fontSize:9,color:"#1a2840",letterSpacing:"0.1em"}}>Options &amp; Futures Desk · Apr-26 → Dec-27</span>
        </div>
        <div style={{fontSize:21,fontWeight:600,color:"#f0f4fa",fontFamily:"'IBM Plex Sans',sans-serif",letterSpacing:"-0.01em"}}>
          CCA Derivatives Pricer
        </div>
      </div>

      {/* ── Global controls row */}
      <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap",alignItems:"stretch"}}>

        {/* Anchor price */}
        <div className="panel" style={{minWidth:170}}>
          <div style={{fontSize:8,letterSpacing:"0.14em",color:"#475569",textTransform:"uppercase",marginBottom:7}}>Dec-26 Anchor Price</div>
          <div style={{display:"flex",alignItems:"flex-end",gap:4}}>
            <span style={{color:"#38bdf8",fontSize:17,lineHeight:1,marginBottom:1}}>$</span>
            <input type="number" step="0.01" value={priceInput}
              onChange={e=>setPriceInput(e.target.value)}
              onBlur={e=>commitPrice(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter")commitPrice(e.target.value);}}
              style={{background:"transparent",border:"none",borderBottom:"2px solid #38bdf8",color:"#38bdf8",fontFamily:"'IBM Plex Mono',monospace",fontSize:24,fontWeight:600,width:86,outline:"none",paddingBottom:1}}
            />
            <span style={{fontSize:7,color:"#2d3d50",marginBottom:2}}>USD/tCO₂e</span>
          </div>
        </div>

        {/* Quarterly rates */}
        <div className="panel" style={{flex:1,minWidth:300}}>
          <div style={{fontSize:8,letterSpacing:"0.14em",color:"#475569",textTransform:"uppercase",marginBottom:9}}>2026 Quarterly Carry Rates</div>
          <div style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"flex-start"}}>
            {quarterRates.map((rate,qi)=>(
              <RateInput key={qi} value={rate} onChange={v=>setQR(qi,v)} color={Q_COLORS[qi]} label={Q_SHORT[qi]}/>
            ))}
            <div style={{width:1,background:"#182030",alignSelf:"stretch",margin:"0 2px"}}/>
            <RateInput value={baseRate} onChange={setBaseRate} color="#64748b" label="2027+"/>
          </div>
        </div>

        {/* Quarterly prices quick-ref */}
        <div className="panel" style={{minWidth:200}}>
          <div style={{fontSize:8,letterSpacing:"0.14em",color:"#475569",textTransform:"uppercase",marginBottom:8}}>Quarterly Futures</div>
          <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
            {OPTIONS_EXPIRIES.map(e=>{
              const key=`${MONTHS[e.month].slice(0,3)}-${String(e.year).slice(2)}`;
              const cp=expiryPriceMap[key];
              const isSel=selectedExpiry===key;
              return (
                <div key={key} onClick={()=>setSelectedExpiry(key)} style={{cursor:"pointer",opacity:isSel?1:0.45,transition:"opacity 0.15s"}}>
                  <div style={{fontSize:7,color:isSel?"#38bdf8":"#475569",letterSpacing:"0.08em"}}>{key}</div>
                  <div style={{fontSize:12,fontWeight:600,color:isSel?"#38bdf8":"#94a3b8"}}>${cp?.price.toFixed(2)??"-"}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Tab bar */}
      <div style={{display:"flex",borderBottom:"1px solid #182030",marginBottom:18,gap:0}}>
        {["Options Chain","Vol Surface","Futures Curve"].map((t,i)=>(
          <button key={t} className={`tab-btn${tab===i?" on":""}`} onClick={()=>setTab(i)}>{t}</button>
        ))}
      </div>

      {/* ════════════ OPTIONS CHAIN ════════════ */}
      {tab===0 && (
        <div>
          <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap",alignItems:"stretch"}}>

            {/* Expiry selector */}
            <div className="panel">
              <div style={{fontSize:8,letterSpacing:"0.14em",color:"#475569",textTransform:"uppercase",marginBottom:7}}>Expiry</div>
              <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                {OPTIONS_EXPIRIES.map(e=>{
                  const key=`${MONTHS[e.month].slice(0,3)}-${String(e.year).slice(2)}`;
                  return (
                    <button key={key} className={`exp-btn${selectedExpiry===key?" on":""}`}
                      onClick={()=>setSelectedExpiry(key)}>{key}</button>
                  );
                })}
              </div>
              {activeExp && (
                <div style={{marginTop:8,fontSize:9,color:"#334155",display:"flex",gap:12}}>
                  <span>F=<span style={{color:"#38bdf8",fontWeight:600}}>${F.toFixed(3)}</span></span>
                  <span>T=<span style={{color:"#34d399"}}>{(T*365).toFixed(0)}d</span></span>
                  <span>r=<span style={{color:"#a78bfa"}}>{(r*100).toFixed(2)}%</span></span>
                  <span>ATMσ=<span style={{color:"#fb923c"}}>{(atmVol*100).toFixed(1)}%</span></span>
                </div>
              )}
            </div>

            {/* Vol parameters — compact for chain view */}
            <div className="panel" style={{flex:1,minWidth:300}}>
              <div style={{fontSize:8,letterSpacing:"0.14em",color:"#475569",textTransform:"uppercase",marginBottom:10}}>Volatility Parameters</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"0 18px"}}>
                <VolSlider label="ATM Vol" value={atmVol*100} min={5} max={120} step={0.5}
                  onChange={v=>setAtmVol(v/100)} color="#38bdf8" format={v=>`${v.toFixed(1)}%`}
                  hint="shift all"/>
                <VolSlider label="Skew" value={skew*100} min={-30} max={15} step={0.5}
                  onChange={v=>setSkew(v/100)} color="#fb923c"
                  format={v=>`${v>=0?"+":""}${v.toFixed(1)}%`}
                  hint="put/call tilt"/>
                <VolSlider label="Convexity" value={convexity*100} min={0} max={80} step={0.5}
                  onChange={v=>setConvexity(v/100)} color="#a78bfa" format={v=>`${v.toFixed(1)}%`}
                  hint="wing curvature"/>
              </div>
            </div>

            <div className="panel" style={{minWidth:110,display:"flex",flexDirection:"column",justifyContent:"space-between"}}>
              <div>
                <div style={{fontSize:8,color:"#334155",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:6}}>Display</div>
                <button className={`gtog${greeksMode?" on":""}`} onClick={()=>setGreeksMode(g=>!g)}>
                  {greeksMode?"Hide Greeks":"Show Greeks"}
                </button>
              </div>
              <div style={{marginTop:10}}>
                {[["ITM","#34d399"],["ATM","#38bdf8"],["OTM","#f87171"]].map(([m,c])=>(
                  <div key={m} style={{display:"flex",alignItems:"center",gap:5,marginBottom:3}}>
                    <div style={{width:5,height:5,borderRadius:"50%",background:c}}/>
                    <span style={{fontSize:8,color:c}}>{m}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Chain table */}
          <div style={{overflowX:"auto"}}>
            <div style={{minWidth: greeksMode?1020:680}}>
              {/* Col headers */}
              <div style={{
                display:"grid",
                gridTemplateColumns: greeksMode
                  ?"54px 72px 70px 62px 55px 52px 52px 8px 70px 62px 55px 52px 52px"
                  :"54px 72px 70px 62px 55px 8px 70px 62px 55px",
                gap:"0 5px",fontSize:8,color:"#2d3d50",letterSpacing:"0.1em",textTransform:"uppercase",
                padding:"4px 8px",borderBottom:"1px solid #182030",marginBottom:2
              }}>
                <span style={{color:"#38bdf844"}}>Strike</span>
                <span style={{color:"#a78bfa88",textAlign:"center"}}>σ(K) / Adj</span>
                {/* CALLS */}
                <span style={{color:"#34d39988",textAlign:"right"}}>Call $</span>
                <span style={{color:"#34d39966",textAlign:"right"}}>Δ</span>
                {greeksMode&&<><span style={{color:"#34d39966",textAlign:"right"}}>Γ</span><span style={{color:"#34d39966",textAlign:"right"}}>Θ/d</span><span style={{color:"#34d39966",textAlign:"right"}}>Vega</span></>}
                {!greeksMode&&<span style={{color:"#34d39966",textAlign:"right"}}>Vega</span>}
                {/* divider */}
                <span/>
                {/* PUTS */}
                <span style={{color:"#f8718488",textAlign:"right"}}>Put $</span>
                <span style={{color:"#f8718466",textAlign:"right"}}>Δ</span>
                {greeksMode&&<><span style={{color:"#f8718466",textAlign:"right"}}>Γ</span><span style={{color:"#f8718466",textAlign:"right"}}>Θ/d</span><span style={{color:"#f8718466",textAlign:"right"}}>Vega</span></>}
                {!greeksMode&&<span style={{color:"#f8718466",textAlign:"right"}}>Vega</span>}
              </div>

              {rows.map(row=>{
                const isATM   = Math.abs(row.K-F)<0.5;
                const isNear  = Math.abs(row.K-F)<2;
                const callItm = row.K<F, putItm = row.K>F;
                const cColor  = isATM?"#38bdf8":callItm?"#34d399":"#64748b";
                const pColor  = isATM?"#38bdf8":putItm?"#34d399":"#64748b";
                const cBar    = (row.call/maxCall)*100;
                const pBar    = (row.put/maxPut)*100;
                const adj     = perStrikeAdj[row.K]||0;
                return (
                  <div key={row.K} className="rh" style={{
                    display:"grid",
                    gridTemplateColumns: greeksMode
                      ?"54px 72px 70px 62px 55px 52px 52px 8px 70px 62px 55px 52px 52px"
                      :"54px 72px 70px 62px 55px 8px 70px 62px 55px",
                    gap:"0 5px",alignItems:"center",padding:"5px 8px",
                    borderBottom:"1px solid #0a0e14",
                    background:isATM?"rgba(56,189,248,0.08)":isNear?"rgba(56,189,248,0.02)":"transparent",
                    borderLeft:isATM?"2px solid #38bdf8":"2px solid transparent",
                  }}>
                    <span style={{fontSize:12,fontWeight:isATM?700:500,color:isATM?"#38bdf8":"#7a8fa6",fontVariantNumeric:"tabular-nums"}}>
                      {row.K}{isATM&&<span style={{fontSize:7,marginLeft:2,color:"#38bdf8"}}>●</span>}
                    </span>

                    {/* Vol + per-strike adj */}
                    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
                      <span style={{fontSize:9,color:"#a78bfa",fontVariantNumeric:"tabular-nums"}}>{(row.s*100).toFixed(1)}%</span>
                      <div style={{display:"flex",alignItems:"center",gap:2}}>
                        <span style={{fontSize:7,color:"#334155"}}>adj</span>
                        <input className="vadj" type="number" step="0.5" value={adj}
                          onChange={e=>setPerStrikeAdj(p=>({...p,[row.K]:parseFloat(e.target.value)||0}))}
                          title="Per-strike vol ±pp"/>
                      </div>
                    </div>

                    {/* Call price */}
                    <div style={{position:"relative",textAlign:"right"}}>
                      <div style={{position:"absolute",right:0,top:"50%",transform:"translateY(-50%)",height:3,width:`${cBar}%`,background:"#34d39918",borderRadius:1}}/>
                      <span style={{fontSize:12,fontWeight:600,color:row.call<0.005?"#1e2d3d":cColor,position:"relative",fontVariantNumeric:"tabular-nums"}}>
                        {row.call<0.005?"<0.01":row.call.toFixed(3)}
                      </span>
                    </div>
                    <span style={{fontSize:10,color:"#34d39988",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{row.cDelta.toFixed(3)}</span>
                    {greeksMode&&<><span style={{fontSize:9,color:"#34d39966",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{row.gamma.toFixed(4)}</span>
                      <span style={{fontSize:9,color:"#34d39966",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{row.cTheta.toFixed(3)}</span></>}
                    <span style={{fontSize:9,color:"#a78bfa66",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{row.vega.toFixed(3)}</span>

                    {/* Divider */}
                    <div style={{width:1,background:"#182030",height:14,alignSelf:"center"}}/>

                    {/* Put price */}
                    <div style={{position:"relative",textAlign:"right"}}>
                      <div style={{position:"absolute",right:0,top:"50%",transform:"translateY(-50%)",height:3,width:`${pBar}%`,background:"#f8718418",borderRadius:1}}/>
                      <span style={{fontSize:12,fontWeight:600,color:row.put<0.005?"#1e2d3d":pColor,position:"relative",fontVariantNumeric:"tabular-nums"}}>
                        {row.put<0.005?"<0.01":row.put.toFixed(3)}
                      </span>
                    </div>
                    <span style={{fontSize:10,color:"#f8718488",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{row.pDelta.toFixed(3)}</span>
                    {greeksMode&&<><span style={{fontSize:9,color:"#f8718466",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{row.gamma.toFixed(4)}</span>
                      <span style={{fontSize:9,color:"#f8718466",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{row.pTheta.toFixed(3)}</span></>}
                    <span style={{fontSize:9,color:"#a78bfa66",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{row.vega.toFixed(3)}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{marginTop:14,borderTop:"1px solid #182030",paddingTop:9,display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:5,fontSize:8,color:"#1a2840",letterSpacing:"0.06em"}}>
            <span>BS FUTURES OPTIONS · σ(K)=ATMvol + Skew·ln(K/F) + Convexity·ln(K/F)² + adj</span>
            <span>● ATM · ITM=green · OTM=dim · adj=per-strike pp override</span>
          </div>
        </div>
      )}

      {/* ════════════ VOL SURFACE TAB ════════════ */}
      {tab===1 && (
        <div>
          <div style={{display:"flex",gap:14,flexWrap:"wrap",marginBottom:22}}>
            {/* Large vol controls */}
            <div className="panel" style={{flex:1,minWidth:320}}>
              <div style={{fontSize:8,letterSpacing:"0.14em",color:"#475569",textTransform:"uppercase",marginBottom:14}}>Vol Surface Parameters</div>
              <VolSlider label="ATM Volatility" value={atmVol*100} min={5} max={120} step={0.25}
                onChange={v=>setAtmVol(v/100)} color="#38bdf8" format={pctFmt}
                hint="parallel shift of entire surface"/>
              <VolSlider label="Skew  (∂σ/∂ln K)" value={skew*100} min={-30} max={15} step={0.25}
                onChange={v=>setSkew(v/100)} color="#fb923c" format={skewFmt}
                hint="negative = put vol > call vol (typical CCA)"/>
              <VolSlider label="Convexity  (∂²σ/∂ln K²)" value={convexity*100} min={0} max={80} step={0.25}
                onChange={v=>setConvexity(v/100)} color="#a78bfa" format={pctFmt}
                hint="smile curvature / wing steepness"/>
            </div>

            {/* Smile chart + stats */}
            <div className="panel" style={{minWidth:380}}>
              <div style={{fontSize:8,letterSpacing:"0.14em",color:"#475569",textTransform:"uppercase",marginBottom:10}}>
                Vol Smile — {selectedExpiry} (F={F.toFixed(2)})
              </div>
              <VolSmileChart strikes={STRIKES} volFn={volFn} F={F} atmVol={atmVol}/>
              <div style={{marginTop:10,display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                {[
                  {label:"25Δ Put vol", k:Math.round(F*0.90)},
                  {label:"ATM vol",     k:Math.round(F)},
                  {label:"25Δ Call vol",k:Math.round(F*1.10)},
                ].map(({label,k})=>{
                  const kc=Math.max(15,Math.min(50,k));
                  return (
                    <div key={label} style={{textAlign:"center"}}>
                      <div style={{fontSize:7,color:"#334155",marginBottom:2,letterSpacing:"0.08em",textTransform:"uppercase"}}>{label}</div>
                      <div style={{fontSize:14,fontWeight:600,color:"#a78bfa"}}>{(volFn(kc)*100).toFixed(1)}%</div>
                      <div style={{fontSize:8,color:"#334155"}}>K={kc}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Per-strike vol adj table */}
          <div className="panel">
            <div style={{fontSize:8,letterSpacing:"0.14em",color:"#475569",textTransform:"uppercase",marginBottom:10}}>
              Per-Strike Vol Fine-Tuning &nbsp;<span style={{color:"#334155",fontWeight:400}}>— adjust individual strikes to smooth the observed vol surface</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(110px,1fr))",gap:6}}>
              {STRIKES.map(K=>{
                const sigma=volFn(K);
                const adj=perStrikeAdj[K]||0;
                const isATM=Math.abs(K-F)<0.5;
                return (
                  <div key={K} style={{
                    padding:"7px 9px",borderRadius:2,
                    background:isATM?"rgba(56,189,248,0.08)":"#070b10",
                    border:`1px solid ${isATM?"#38bdf855":"#182030"}`,
                  }}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
                      <span style={{fontSize:11,fontWeight:600,color:isATM?"#38bdf8":"#7a8fa6"}}>K={K}</span>
                      <span style={{fontSize:9,color:"#a78bfa"}}>{(sigma*100).toFixed(1)}%</span>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:4}}>
                      <span style={{fontSize:7,color:"#334155"}}>±pp</span>
                      <input className="vadj" type="number" step="0.5" value={adj} style={{width:"100%"}}
                        onChange={e=>setPerStrikeAdj(p=>({...p,[K]:parseFloat(e.target.value)||0}))}/>
                    </div>
                    {adj!==0&&<div style={{fontSize:7,marginTop:3,color:adj>0?"#34d399":"#f87171",textAlign:"right"}}>
                      {adj>0?"+":""}{adj}pp
                    </div>}
                  </div>
                );
              })}
            </div>
            <div style={{marginTop:10,textAlign:"right"}}>
              <button onClick={()=>setPerStrikeAdj(Object.fromEntries(STRIKES.map(k=>[k,0])))}
                style={{fontSize:8,color:"#334155",background:"transparent",border:"1px solid #182030",borderRadius:2,padding:"3px 10px",cursor:"pointer",fontFamily:"'IBM Plex Mono',monospace",letterSpacing:"0.08em"}}>
                RESET ALL ADJ
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════════ FUTURES CURVE TAB ════════════ */}
      {tab===2 && (
        <div>
          {/* ── Rate Sliders + Spread Generator ── */}
          <div style={{display:"flex",gap:12,marginBottom:20,flexWrap:"wrap",alignItems:"stretch"}}>

            {/* Quarter rate sliders */}
            <div className="panel" style={{flex:1,minWidth:320}}>
              <div style={{fontSize:8,letterSpacing:"0.14em",color:"#475569",textTransform:"uppercase",marginBottom:14}}>
                2026 Quarterly Carry Rates
              </div>
              {quarterRates.map((rate,qi)=>{
                const pct=((rate-0)/(15-0)*100).toFixed(1);
                return (
                  <div key={qi} style={{marginBottom:14}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:5}}>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <div style={{width:10,height:10,borderRadius:2,background:Q_COLORS[qi]}}/>
                        <span style={{fontSize:9,color:Q_COLORS[qi],letterSpacing:"0.1em"}}>
                          {Q_SHORT[qi]}
                          <span style={{color:"#334155",marginLeft:6,fontSize:8}}>
                            {qi===0?"Jan-Mar":qi===1?"Apr-Jun":qi===2?"Jul-Sep":"Oct-Dec"}
                          </span>
                        </span>
                      </div>
                      <span style={{fontSize:16,fontWeight:600,color:Q_COLORS[qi],fontFamily:"'IBM Plex Mono',monospace"}}>
                        {rate.toFixed(2)}<span style={{fontSize:11,color:"#334155"}}>%</span>
                      </span>
                    </div>
                    <input type="range" min={0} max={15} step={0.05} value={rate}
                      onChange={e=>setQR(qi,parseFloat(e.target.value))}
                      style={{width:"100%",background:`linear-gradient(to right,${Q_COLORS[qi]} ${pct}%,#182030 ${pct}%)`,accentColor:Q_COLORS[qi]}}
                    />
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:7,color:"#1e2d3d",marginTop:2}}>
                      <span>0%</span><span>15%</span>
                    </div>
                  </div>
                );
              })}
              <div style={{borderTop:"1px solid #182030",paddingTop:12,marginTop:2}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:5}}>
                  <span style={{fontSize:9,color:"#64748b",letterSpacing:"0.1em"}}>2027+ Base Rate</span>
                  <span style={{fontSize:16,fontWeight:600,color:"#64748b",fontFamily:"'IBM Plex Mono',monospace"}}>
                    {baseRate.toFixed(2)}<span style={{fontSize:11,color:"#334155"}}>%</span>
                  </span>
                </div>
                <input type="range" min={0} max={15} step={0.05} value={baseRate}
                  onChange={e=>setBaseRate(parseFloat(e.target.value))}
                  style={{width:"100%",background:`linear-gradient(to right,#64748b ${((baseRate/15)*100).toFixed(1)}%,#182030 ${((baseRate/15)*100).toFixed(1)}%)`,accentColor:"#64748b"}}
                />
                <div style={{display:"flex",justifyContent:"space-between",fontSize:7,color:"#1e2d3d",marginTop:2}}>
                  <span>0%</span><span>15%</span>
                </div>
              </div>
            </div>

            {/* Spread Generator */}
            <div className="panel" style={{flex:1,minWidth:300}}>
              <div style={{fontSize:8,letterSpacing:"0.14em",color:"#475569",textTransform:"uppercase",marginBottom:14}}>
                Spread Generator
              </div>
              {/* Leg selectors */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 32px 1fr",gap:8,alignItems:"center",marginBottom:16}}>
                <div>
                  <div style={{fontSize:8,color:"#334155",letterSpacing:"0.1em",marginBottom:5}}>NEAR LEG</div>
                  <select
                    value={spreadNear}
                    onChange={e=>setSpreadNear(e.target.value)}
                    style={{width:"100%",background:"#0b0f18",border:"1px solid #182030",color:"#34d399",fontFamily:"'IBM Plex Mono',monospace",fontSize:12,fontWeight:600,padding:"6px 8px",borderRadius:2,outline:"none",cursor:"pointer"}}
                  >
                    {curve.filter(c=>c.isQExpiry||c.isAnchor).map(c=>(
                      <option key={c.label} value={c.label}>{c.label}</option>
                    ))}
                  </select>
                  {spreadNearData && (
                    <div style={{fontSize:11,color:"#34d399",fontWeight:600,marginTop:4,textAlign:"center"}}>
                      ${spreadNearData.price.toFixed(3)}
                    </div>
                  )}
                </div>
                <div style={{textAlign:"center",fontSize:14,color:"#334155",fontWeight:600}}>/</div>
                <div>
                  <div style={{fontSize:8,color:"#334155",letterSpacing:"0.1em",marginBottom:5}}>FAR LEG</div>
                  <select
                    value={spreadFar}
                    onChange={e=>setSpreadFar(e.target.value)}
                    style={{width:"100%",background:"#0b0f18",border:"1px solid #182030",color:"#f87171",fontFamily:"'IBM Plex Mono',monospace",fontSize:12,fontWeight:600,padding:"6px 8px",borderRadius:2,outline:"none",cursor:"pointer"}}
                  >
                    {curve.filter(c=>c.isQExpiry||c.isAnchor).map(c=>(
                      <option key={c.label} value={c.label}>{c.label}</option>
                    ))}
                  </select>
                  {spreadFarData && (
                    <div style={{fontSize:11,color:"#f87171",fontWeight:600,marginTop:4,textAlign:"center"}}>
                      ${spreadFarData.price.toFixed(3)}
                    </div>
                  )}
                </div>
              </div>

              {/* Spread results */}
              {spreadResult && (
                <div style={{background:"#070b10",border:"1px solid #182030",borderRadius:3,padding:"12px 14px"}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
                    <div>
                      <div style={{fontSize:8,color:"#334155",letterSpacing:"0.1em",marginBottom:3}}>SPREAD</div>
                      <div style={{fontSize:22,fontWeight:600,color:spreadResult.spread>=0?"#34d399":"#f87171",fontFamily:"'IBM Plex Mono',monospace"}}>
                        {spreadResult.spread>=0?"+":""}{spreadResult.spread.toFixed(3)}
                      </div>
                      <div style={{fontSize:8,color:"#334155",marginTop:1}}>USD / tCO2e</div>
                    </div>
                    <div>
                      <div style={{fontSize:8,color:"#334155",letterSpacing:"0.1em",marginBottom:3}}>ANNUALIZED RATE</div>
                      <div style={{fontSize:22,fontWeight:600,color:"#38bdf8",fontFamily:"'IBM Plex Mono',monospace"}}>
                        {spreadResult.annualizedRate.toFixed(2)}<span style={{fontSize:13,color:"#334155"}}>%</span>
                      </div>
                      <div style={{fontSize:8,color:"#334155",marginTop:1}}>continuous carry</div>
                    </div>
                  </div>
                  <div style={{borderTop:"1px solid #182030",paddingTop:8,display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
                    <div>
                      <div style={{fontSize:7,color:"#334155",marginBottom:2}}>DAYS</div>
                      <div style={{fontSize:11,color:"#94a3b8",fontWeight:600}}>{spreadResult.days}d</div>
                    </div>
                    <div>
                      <div style={{fontSize:7,color:"#334155",marginBottom:2}}>SPREAD %</div>
                      <div style={{fontSize:11,color:"#94a3b8",fontWeight:600}}>
                        {spreadResult.spreadPct>=0?"+":""}{spreadResult.spreadPct.toFixed(2)}%
                      </div>
                    </div>
                    <div>
                      <div style={{fontSize:7,color:"#334155",marginBottom:2}}>NEAR / FAR</div>
                      <div style={{fontSize:11,color:"#94a3b8",fontWeight:600}}>
                        {spreadNear.slice(0,6)} / {spreadFar.slice(0,6)}
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {!spreadResult && (
                <div style={{textAlign:"center",padding:"20px 0",fontSize:9,color:"#1e2d3d"}}>
                  Select two different contracts to calculate spread
                </div>
              )}
            </div>
          </div>

          {/* ── Curve Table ── */}
          <div style={{overflowX:"auto"}}>
            {Object.entries(byYear).map(([year,months])=>{
              const yr=parseInt(year);
              return (
                <div key={year} style={{marginBottom:18}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,borderBottom:"1px solid #182030",paddingBottom:5,marginBottom:3}}>
                    <span style={{fontSize:10,fontWeight:600,color:yr===2026?"#38bdf8":"#475569",letterSpacing:"0.1em"}}>{year}</span>
                    {yr===2026
                      ?<span style={{fontSize:8,color:"#38bdf8",letterSpacing:"0.08em"}}>Q RATES:&nbsp;{quarterRates.map((rate,i)=><span key={i} style={{color:Q_COLORS[i]}}>{Q_SHORT[i]}:{rate.toFixed(2)}% </span>)}</span>
                      :<span style={{fontSize:8,color:"#475569",letterSpacing:"0.07em"}}>BASE RATE {baseRate.toFixed(2)}%</span>
                    }
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"100px 110px 36px 1fr 88px 82px",gap:"0 10px",fontSize:7,color:"#2d3d50",letterSpacing:"0.1em",textTransform:"uppercase",padding:"3px 8px",marginBottom:1}}>
                    <span>Contract</span><span style={{textAlign:"right"}}>Price</span><span style={{textAlign:"center"}}>Qtr</span><span>Carry</span><span style={{textAlign:"right"}}>Rate</span><span style={{textAlign:"right"}}>vs Anchor</span>
                  </div>
                  {months.map(c=>{
                    const bw=((c.price-minP)/pRange)*100;
                    const diff=(c.price-anchorPrice)/anchorPrice*100;
                    const qc=c.inAnchorYear?Q_COLORS[c.quarter]:"#475569";
                    const isSpreadLeg=c.label===spreadNear||c.label===spreadFar;
                    return (
                      <div key={c.label} className="rh" style={{
                        display:"grid",gridTemplateColumns:"100px 110px 36px 1fr 88px 82px",
                        gap:"0 10px",alignItems:"center",padding:"5px 8px",borderBottom:"1px solid #090d12",
                        background:c.isAnchor?"rgba(56,189,248,0.09)":isSpreadLeg?"rgba(52,211,153,0.05)":c.isQExpiry?"rgba(56,189,248,0.03)":"transparent",
                        borderLeft:c.isAnchor?"2px solid #38bdf8":isSpreadLeg?"2px solid #34d399":c.isQExpiry?"2px solid #1a3050":"2px solid transparent",
                      }}>
                        <span style={{fontSize:11,fontWeight:c.isQExpiry?600:400,color:c.isAnchor?"#38bdf8":isSpreadLeg?"#34d399":c.isQExpiry?"#7dd3fc":"#4a5d70",letterSpacing:"0.04em"}}>
                          {c.label}
                          {c.isAnchor&&<span style={{fontSize:6,marginLeft:3,color:"#38bdf8"}}>●</span>}
                          {c.isQExpiry&&!c.isAnchor&&<span style={{fontSize:6,marginLeft:3,color:"#7dd3fc55"}}>Q</span>}
                        </span>
                        <span style={{fontSize:12,fontWeight:600,color:c.isAnchor?"#38bdf8":"#d0dcea",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>${c.price.toFixed(3)}</span>
                        <span style={{textAlign:"center",fontSize:7,fontWeight:700,color:qc}}>{c.inAnchorYear?Q_SHORT[c.quarter]:"—"}</span>
                        <div style={{height:4,background:"#090d12",borderRadius:1,overflow:"hidden"}}>
                          <div style={{width:`${bw}%`,height:"100%",minWidth:2,borderRadius:1,
                            background:c.inAnchorYear?`linear-gradient(90deg,${qc}44,${qc})`:"linear-gradient(90deg,#1a2030,#2d3d50)"}}/>
                        </div>
                        <span style={{fontSize:9,color:qc,textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{c.effectiveRate.toFixed(2)}%</span>
                        <span style={{fontSize:10,fontWeight:500,textAlign:"right",fontVariantNumeric:"tabular-nums",color:c.isAnchor?"#475569":diff>=0?"#34d399":"#f87171"}}>
                          {c.isAnchor?"anchor":`${diff>=0?"+":""}${diff.toFixed(2)}%`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            <div style={{marginTop:16,borderTop:"1px solid #182030",paddingTop:9,display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:5,fontSize:8,color:"#182030",letterSpacing:"0.06em"}}>
              <span>F(T) = P_anchor x exp(r x dt) - piecewise quarterly rates - continuous compounding - Apr-26 to Dec-27</span>
              <span>Q = quarterly options expiry - anchor = Dec-26</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
