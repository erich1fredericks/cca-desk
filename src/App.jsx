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


// ─── Spread Builder + Blotter ─────────────────────────────────────────────────
const STRATEGIES = [
  { id:"Call Spread",    legs:(k1,k2,k3,qty,rows,F,T,r,vf)=>{
      const l1=rows.find(r=>r.K===k1), l2=rows.find(r=>r.K===k2);
      if(!l1||!l2) return null;
      const prem = l1.call - l2.call;
      const delta = l1.cDelta - l2.cDelta;
      const vega  = l1.vega  - l2.vega;
      const gamma = l1.gamma - l2.gamma;
      const maxProfit = (k2-k1) - prem;
      const maxLoss   = prem;
      return { legs:[
        {type:"Call",K:k1,pos:"+"+qty,price:l1.call,delta:l1.cDelta,vega:l1.vega},
        {type:"Call",K:k2,pos:"-"+qty,price:l2.call,delta:-l2.cDelta,vega:-l2.vega},
      ], netPrem:prem, delta, vega, gamma, maxProfit, maxLoss, breakeven:(k1+prem).toFixed(2) };
  }},
  { id:"Put Spread",     legs:(k1,k2,k3,qty,rows,F,T,r,vf)=>{
      const l1=rows.find(r=>r.K===k2), l2=rows.find(r=>r.K===k1);
      if(!l1||!l2) return null;
      const prem = l1.put - l2.put;
      const delta = l1.pDelta - l2.pDelta;
      const vega  = l1.vega  - l2.vega;
      const gamma = l1.gamma - l2.gamma;
      const maxProfit = (k2-k1) - prem;
      const maxLoss   = prem;
      return { legs:[
        {type:"Put",K:k2,pos:"+"+qty,price:l1.put,delta:l1.pDelta,vega:l1.vega},
        {type:"Put",K:k1,pos:"-"+qty,price:l2.put,delta:-l2.pDelta,vega:-l2.vega},
      ], netPrem:prem, delta, vega, gamma, maxProfit, maxLoss, breakeven:(k2-prem).toFixed(2) };
  }},
  { id:"Risk Reversal",  legs:(k1,k2,k3,qty,rows,F,T,r,vf)=>{
      const lp=rows.find(r=>r.K===k1), lc=rows.find(r=>r.K===k2);
      if(!lp||!lc) return null;
      const prem  = lc.call - lp.put;
      const delta = lc.cDelta - lp.pDelta;
      const vega  = lc.vega  - lp.vega;
      const gamma = lc.gamma - lp.gamma;
      return { legs:[
        {type:"Call",K:k2,pos:"+"+qty,price:lc.call,delta:lc.cDelta,vega:lc.vega},
        {type:"Put", K:k1,pos:"-"+qty,price:lp.put, delta:lp.pDelta,vega:lp.vega},
      ], netPrem:prem, delta, vega, gamma, maxProfit:"Unlimited", maxLoss:"Unlimited",
         breakeven:`${(k1-lp.put).toFixed(2)} / ${(k2+lc.call).toFixed(2)}` };
  }},
  { id:"Call Ratio",     legs:(k1,k2,k3,qty,rows,F,T,r,vf)=>{
      const l1=rows.find(r=>r.K===k1), l2=rows.find(r=>r.K===k2);
      if(!l1||!l2) return null;
      const prem  = l1.call - 2*l2.call;
      const delta = l1.cDelta - 2*l2.cDelta;
      const vega  = l1.vega  - 2*l2.vega;
      const gamma = l1.gamma - 2*l2.gamma;
      return { legs:[
        {type:"Call",K:k1,pos:"+"+qty,     price:l1.call,delta:l1.cDelta,vega:l1.vega},
        {type:"Call",K:k2,pos:"-"+(qty*2),price:l2.call,delta:-l2.cDelta*2,vega:-l2.vega*2},
      ], netPrem:prem, delta, vega, gamma, maxProfit:(k2-k1+prem).toFixed(2)+" at K"+k2, maxLoss:"Unlimited above",
         breakeven:(k1+prem>0?k1+prem:k1).toFixed(2) };
  }},
  { id:"Put Ratio",      legs:(k1,k2,k3,qty,rows,F,T,r,vf)=>{
      const l1=rows.find(r=>r.K===k2), l2=rows.find(r=>r.K===k1);
      if(!l1||!l2) return null;
      const prem  = l1.put - 2*l2.put;
      const delta = l1.pDelta - 2*l2.pDelta;
      const vega  = l1.vega  - 2*l2.vega;
      const gamma = l1.gamma - 2*l2.gamma;
      return { legs:[
        {type:"Put",K:k2,pos:"+"+qty,     price:l1.put,delta:l1.pDelta,vega:l1.vega},
        {type:"Put",K:k1,pos:"-"+(qty*2),price:l2.put,delta:-l2.pDelta*2,vega:-l2.vega*2},
      ], netPrem:prem, delta, vega, gamma, maxProfit:(k2-k1+prem).toFixed(2)+" at K"+k1, maxLoss:"Unlimited below",
         breakeven:(k2-prem>0?k2-prem:k2).toFixed(2) };
  }},
  { id:"Straddle",       legs:(k1,k2,k3,qty,rows,F,T,r,vf)=>{
      const l=rows.find(r=>r.K===k1);
      if(!l) return null;
      const prem  = l.call + l.put;
      const delta = l.cDelta + l.pDelta;
      const vega  = l.vega*2;
      const gamma = l.gamma*2;
      return { legs:[
        {type:"Call",K:k1,pos:"+"+qty,price:l.call,delta:l.cDelta,vega:l.vega},
        {type:"Put", K:k1,pos:"+"+qty,price:l.put, delta:l.pDelta,vega:l.vega},
      ], netPrem:prem, delta, vega, gamma, maxProfit:"Unlimited", maxLoss:prem,
         breakeven:`${(k1-prem).toFixed(2)} / ${(k1+prem).toFixed(2)}` };
  }},
  { id:"Strangle",       legs:(k1,k2,k3,qty,rows,F,T,r,vf)=>{
      const lp=rows.find(r=>r.K===k1), lc=rows.find(r=>r.K===k2);
      if(!lp||!lc) return null;
      const prem  = lc.call + lp.put;
      const delta = lc.cDelta + lp.pDelta;
      const vega  = lc.vega+lp.vega;
      const gamma = lc.gamma+lp.gamma;
      return { legs:[
        {type:"Put", K:k1,pos:"+"+qty,price:lp.put, delta:lp.pDelta,vega:lp.vega},
        {type:"Call",K:k2,pos:"+"+qty,price:lc.call,delta:lc.cDelta,vega:lc.vega},
      ], netPrem:prem, delta, vega, gamma, maxProfit:"Unlimited", maxLoss:prem,
         breakeven:`${(k1-prem).toFixed(2)} / ${(k2+prem).toFixed(2)}` };
  }},
  { id:"Butterfly",      legs:(k1,k2,k3,qty,rows,F,T,r,vf)=>{
      const l1=rows.find(r=>r.K===k1), l2=rows.find(r=>r.K===k2), l3=rows.find(r=>r.K===k3);
      if(!l1||!l2||!l3) return null;
      const prem  = l1.call - 2*l2.call + l3.call;
      const delta = l1.cDelta - 2*l2.cDelta + l3.cDelta;
      const vega  = l1.vega  - 2*l2.vega  + l3.vega;
      const gamma = l1.gamma - 2*l2.gamma + l3.gamma;
      return { legs:[
        {type:"Call",K:k1,pos:"+"+qty,     price:l1.call,delta:l1.cDelta,vega:l1.vega},
        {type:"Call",K:k2,pos:"-"+(qty*2),price:l2.call,delta:-l2.cDelta*2,vega:-l2.vega*2},
        {type:"Call",K:k3,pos:"+"+qty,     price:l3.call,delta:l3.cDelta,vega:l3.vega},
      ], netPrem:prem, delta, vega, gamma,
         maxProfit:(k2-k1-prem).toFixed(2)+" at K"+k2, maxLoss:prem,
         breakeven:`${(k1+prem).toFixed(2)} / ${(k3-prem).toFixed(2)}` };
  }},
];

const STRAT_NEEDS_K3 = ["Butterfly"];
const STRAT_COLORS = {
  "Call Spread":"#34d399","Put Spread":"#f87171","Risk Reversal":"#a78bfa",
  "Call Ratio":"#38bdf8","Put Ratio":"#fb923c","Straddle":"#fbbf24",
  "Strangle":"#e879f9","Butterfly":"#67e8f9"
};

function SpreadBuilder({rows,F,T,r,volFn,sStrat,setSStrat,sExpiry,setSExpiry,
  sK1,setSK1,sK2,setSK2,sK3,setSK3,sQty,setSQty,blotter,setBlotter,
  selectedExpiry,OPTIONS_EXPIRIES,MONTHS}) {

  const needsK3 = STRAT_NEEDS_K3.includes(sStrat);
  const stratDef = STRATEGIES.find(s=>s.id===sStrat);
  const preview  = useMemo(()=>{
    if(!stratDef) return null;
    return stratDef.legs(sK1,sK2,sK3,sQty,rows,F,T,r,volFn);
  },[sStrat,sK1,sK2,sK3,sQty,rows,F,T,r,volFn,stratDef]);

  function addToBlotter() {
    if(!preview) return;
    const id = Date.now();
    const time = new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
    setBlotter(b=>[...b,{
      id, time, strat:sStrat, expiry:sExpiry,
      k1:sK1, k2:sK2, k3:needsK3?sK3:null,
      qty:sQty, ...preview
    }]);
  }

  const totalNetPrem  = blotter.reduce((s,b)=>s+(typeof b.netPrem==="number"?b.netPrem:0),0);
  const totalDelta    = blotter.reduce((s,b)=>s+(typeof b.delta==="number"?b.delta:0),0);
  const totalVega     = blotter.reduce((s,b)=>s+(typeof b.vega==="number"?b.vega:0),0);

  const selColor = STRAT_COLORS[sStrat]||"#38bdf8";

  return (
    <div style={{marginTop:22}}>
      {/* ── Builder panel */}
      <div style={{background:"#0b0f18",border:"1px solid #182030",borderRadius:3,padding:"14px 16px",marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div style={{fontSize:8,letterSpacing:"0.14em",color:"#475569",textTransform:"uppercase"}}>
            Options Spread Builder
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            <span style={{fontSize:8,color:"#334155"}}>EXPIRY</span>
            <select value={sExpiry} onChange={e=>setSExpiry(e.target.value)}
              style={{background:"#070b10",border:"1px solid #182030",color:"#38bdf8",fontFamily:"'IBM Plex Mono',monospace",fontSize:10,padding:"3px 6px",borderRadius:2,outline:"none",cursor:"pointer"}}>
              {OPTIONS_EXPIRIES.map(e=>{
                const key=MONTHS[e.month].slice(0,3)+"-"+String(e.year).slice(2);
                return <option key={key} value={key}>{key}</option>;
              })}
            </select>
          </div>
        </div>

        {/* Strategy selector */}
        <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:14}}>
          {STRATEGIES.map(s=>(
            <button key={s.id} onClick={()=>setSStrat(s.id)}
              style={{padding:"4px 10px",fontSize:9,fontFamily:"'IBM Plex Mono',monospace",
                letterSpacing:"0.06em",borderRadius:2,cursor:"pointer",border:"1px solid",
                borderColor:sStrat===s.id?STRAT_COLORS[s.id]:"#182030",
                background:sStrat===s.id?"rgba(56,189,248,0.06)":"#070b10",
                color:sStrat===s.id?STRAT_COLORS[s.id]:"#475569",
                transition:"all 0.12s"}}>
              {s.id}
            </button>
          ))}
        </div>

        {/* Strike + qty selectors */}
        <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end",marginBottom:14}}>
          {[
            {label:sStrat==="Straddle"?"ATM Strike":sStrat==="Strangle"||sStrat==="Risk Reversal"?"Put Strike":"Lower Strike",
             val:sK1,set:setSK1},
            ...( sStrat!=="Straddle" ? [{
              label:sStrat==="Strangle"||sStrat==="Risk Reversal"?"Call Strike":"Upper Strike",
              val:sK2,set:setSK2}] : [] ),
            ...( needsK3 ? [{label:"Body Strike",val:sK3,set:setSK3}] : [] ),
          ].map(({label,val,set})=>(
            <div key={label}>
              <div style={{fontSize:8,color:"#334155",letterSpacing:"0.1em",marginBottom:4}}>{label}</div>
              <select value={val} onChange={e=>set(parseInt(e.target.value))}
                style={{background:"#070b10",border:`1px solid ${selColor}44`,color:selColor,
                  fontFamily:"'IBM Plex Mono',monospace",fontSize:14,fontWeight:600,
                  padding:"5px 8px",borderRadius:2,outline:"none",cursor:"pointer",width:72}}>
                {STRIKES.map(k=><option key={k} value={k}>{k}</option>)}
              </select>
            </div>
          ))}
          <div>
            <div style={{fontSize:8,color:"#334155",letterSpacing:"0.1em",marginBottom:4}}>QTY (lots)</div>
            <input type="number" min={1} step={1} value={sQty}
              onChange={e=>setSQty(Math.max(1,parseInt(e.target.value)||1))}
              style={{background:"#070b10",border:"1px solid #182030",color:"#d8e2ef",
                fontFamily:"'IBM Plex Mono',monospace",fontSize:14,fontWeight:600,
                padding:"5px 8px",borderRadius:2,outline:"none",width:72,textAlign:"right"}}/>
          </div>
        </div>

        {/* Preview */}
        {preview && (
          <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"stretch"}}>
            {/* Legs */}
            <div style={{background:"#070b10",border:"1px solid #182030",borderRadius:2,padding:"8px 12px",flex:1,minWidth:200}}>
              <div style={{fontSize:7,color:"#334155",letterSpacing:"0.1em",marginBottom:6}}>LEGS</div>
              {preview.legs.map((lg,i)=>(
                <div key={i} style={{display:"flex",gap:10,alignItems:"baseline",marginBottom:3}}>
                  <span style={{fontSize:9,fontWeight:600,color:selColor,minWidth:14}}>{lg.pos}</span>
                  <span style={{fontSize:10,color:"#94a3b8"}}>{lg.type} K={lg.K}</span>
                  <span style={{fontSize:10,color:"#d8e2ef",fontWeight:600}}>${lg.price.toFixed(3)}</span>
                  <span style={{fontSize:9,color:"#475569"}}>d={lg.delta.toFixed(3)}</span>
                </div>
              ))}
            </div>
            {/* Net premium */}
            <div style={{background:"#070b10",border:"1px solid #182030",borderRadius:2,padding:"8px 12px",minWidth:110}}>
              <div style={{fontSize:7,color:"#334155",letterSpacing:"0.1em",marginBottom:4}}>NET PREMIUM</div>
              <div style={{fontSize:20,fontWeight:600,color:preview.netPrem>=0?"#34d399":"#f87171",fontFamily:"'IBM Plex Mono',monospace"}}>
                {preview.netPrem>=0?"+":""}{typeof preview.netPrem==="number"?preview.netPrem.toFixed(3):preview.netPrem}
              </div>
              <div style={{fontSize:8,color:"#334155",marginTop:2}}>per lot</div>
            </div>
            {/* Greeks */}
            <div style={{background:"#070b10",border:"1px solid #182030",borderRadius:2,padding:"8px 12px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 14px",minWidth:160}}>
              {[
                ["Net Delta", typeof preview.delta==="number"?preview.delta.toFixed(3):preview.delta],
                ["Net Vega",  typeof preview.vega==="number"?preview.vega.toFixed(3):preview.vega],
                ["Net Gamma", typeof preview.gamma==="number"?preview.gamma.toFixed(4):preview.gamma],
                ["Breakeven", preview.breakeven],
              ].map(([k,v])=>(
                <div key={k}>
                  <div style={{fontSize:7,color:"#334155",letterSpacing:"0.08em"}}>{k}</div>
                  <div style={{fontSize:10,color:"#94a3b8",fontWeight:600}}>{v}</div>
                </div>
              ))}
            </div>
            {/* Max P&L */}
            <div style={{background:"#070b10",border:"1px solid #182030",borderRadius:2,padding:"8px 12px",minWidth:130}}>
              <div style={{fontSize:7,color:"#334155",letterSpacing:"0.1em",marginBottom:6}}>P&L PROFILE</div>
              <div style={{marginBottom:4}}>
                <div style={{fontSize:7,color:"#334155"}}>MAX PROFIT</div>
                <div style={{fontSize:11,color:"#34d399",fontWeight:600}}>
                  {typeof preview.maxProfit==="number"?`$${(preview.maxProfit*sQty).toFixed(2)}`:preview.maxProfit}
                </div>
              </div>
              <div>
                <div style={{fontSize:7,color:"#334155"}}>MAX LOSS</div>
                <div style={{fontSize:11,color:"#f87171",fontWeight:600}}>
                  {typeof preview.maxLoss==="number"?`$${(preview.maxLoss*sQty).toFixed(2)}`:preview.maxLoss}
                </div>
              </div>
            </div>
            {/* Add button */}
            <div style={{display:"flex",alignItems:"center"}}>
              <button onClick={addToBlotter}
                style={{background:selColor,border:"none",borderRadius:2,
                  color:"#070b10",fontFamily:"'IBM Plex Mono',monospace",fontSize:10,
                  fontWeight:700,letterSpacing:"0.1em",padding:"10px 16px",cursor:"pointer",
                  textTransform:"uppercase",whiteSpace:"nowrap"}}>
                + Add to Blotter
              </button>
            </div>
          </div>
        )}
        {!preview && (
          <div style={{padding:"12px 0",fontSize:9,color:"#1e2d3d",textAlign:"center"}}>
            Configure strikes to preview spread
          </div>
        )}
      </div>

      {/* ── Blotter table */}
      <div style={{background:"#0b0f18",border:"1px solid #182030",borderRadius:3,padding:"12px 16px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{display:"flex",alignItems:"baseline",gap:12}}>
            <span style={{fontSize:8,letterSpacing:"0.14em",color:"#475569",textTransform:"uppercase"}}>Trade Blotter</span>
            <span style={{fontSize:9,color:"#334155"}}>{blotter.length} entr{blotter.length===1?"y":"ies"}</span>
            {blotter.length>0&&(
              <span style={{fontSize:9,color:"#475569"}}>
                Net Prem: <span style={{color:totalNetPrem>=0?"#34d399":"#f87171",fontWeight:600}}>{totalNetPrem>=0?"+":""}{totalNetPrem.toFixed(3)}</span>
                &nbsp;|&nbsp;Net Delta: <span style={{color:"#38bdf8",fontWeight:600}}>{totalDelta.toFixed(3)}</span>
                &nbsp;|&nbsp;Net Vega: <span style={{color:"#a78bfa",fontWeight:600}}>{totalVega.toFixed(3)}</span>
              </span>
            )}
          </div>
          {blotter.length>0&&(
            <button onClick={()=>setBlotter([])}
              style={{fontSize:8,color:"#f87171",background:"transparent",border:"1px solid #f8717133",
                borderRadius:2,padding:"3px 10px",cursor:"pointer",fontFamily:"'IBM Plex Mono',monospace",
                letterSpacing:"0.08em"}}>
              CLEAR ALL
            </button>
          )}
        </div>

        {blotter.length===0 ? (
          <div style={{padding:"24px 0",textAlign:"center",fontSize:9,color:"#1a2840",letterSpacing:"0.08em"}}>
            No trades — add spreads above to build your blotter
          </div>
        ) : (
          <div style={{overflowX:"auto"}}>
            {/* Header */}
            <div style={{display:"grid",gridTemplateColumns:"52px 70px 90px 130px 80px 80px 80px 80px 110px 32px",
              gap:"0 6px",fontSize:7,color:"#2d3d50",letterSpacing:"0.1em",textTransform:"uppercase",
              padding:"3px 6px",borderBottom:"1px solid #182030",marginBottom:2,minWidth:720}}>
              <span>Time</span><span>Expiry</span><span>Strategy</span><span>Legs</span>
              <span style={{textAlign:"right"}}>Net Prem</span>
              <span style={{textAlign:"right"}}>Delta</span>
              <span style={{textAlign:"right"}}>Vega</span>
              <span style={{textAlign:"right"}}>Breakeven</span>
              <span style={{textAlign:"right"}}>P&L Max</span>
              <span/>
            </div>
            {blotter.map((b,i)=>{
              const sc=STRAT_COLORS[b.strat]||"#38bdf8";
              return (
                <div key={b.id} className="rh" style={{display:"grid",
                  gridTemplateColumns:"52px 70px 90px 130px 80px 80px 80px 80px 110px 32px",
                  gap:"0 6px",alignItems:"center",padding:"6px 6px",
                  borderBottom:"1px solid #0a0e14",minWidth:720,
                  background:i%2===0?"transparent":"rgba(255,255,255,0.01)"}}>
                  <span style={{fontSize:9,color:"#334155"}}>{b.time}</span>
                  <span style={{fontSize:9,color:"#38bdf8"}}>{b.expiry}</span>
                  <span style={{fontSize:9,fontWeight:600,color:sc}}>{b.strat}</span>
                  <span style={{fontSize:9,color:"#94a3b8"}}>
                    {b.legs.map(l=>`${l.pos} ${l.type} K${l.K}`).join(" / ")}
                  </span>
                  <span style={{fontSize:10,fontWeight:600,textAlign:"right",
                    color:typeof b.netPrem==="number"&&b.netPrem>=0?"#34d399":"#f87171",
                    fontVariantNumeric:"tabular-nums"}}>
                    {typeof b.netPrem==="number"?(b.netPrem>=0?"+":"")+b.netPrem.toFixed(3):b.netPrem}
                  </span>
                  <span style={{fontSize:9,textAlign:"right",color:"#38bdf8",fontVariantNumeric:"tabular-nums"}}>
                    {typeof b.delta==="number"?b.delta.toFixed(3):b.delta}
                  </span>
                  <span style={{fontSize:9,textAlign:"right",color:"#a78bfa",fontVariantNumeric:"tabular-nums"}}>
                    {typeof b.vega==="number"?b.vega.toFixed(3):b.vega}
                  </span>
                  <span style={{fontSize:9,textAlign:"right",color:"#94a3b8",fontVariantNumeric:"tabular-nums"}}>
                    {b.breakeven}
                  </span>
                  <span style={{fontSize:9,textAlign:"right",color:"#475569",fontVariantNumeric:"tabular-nums"}}>
                    <span style={{color:"#34d399"}}>{typeof b.maxProfit==="number"?"+$"+(b.maxProfit*b.qty).toFixed(0):b.maxProfit}</span>
                    {" / "}
                    <span style={{color:"#f87171"}}>{typeof b.maxLoss==="number"?"-$"+(b.maxLoss*b.qty).toFixed(0):b.maxLoss}</span>
                  </span>
                  <button onClick={()=>setBlotter(bl=>bl.filter(x=>x.id!==b.id))}
                    style={{fontSize:8,color:"#475569",background:"transparent",border:"none",
                      cursor:"pointer",padding:"2px 4px",fontFamily:"'IBM Plex Mono',monospace"}}>
                    x
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}


// ─── Pop-out Market View ───────────────────────────────────────────────────────
function PopoutChain() {
  const params = new URLSearchParams(window.location.search);
  const anchorPrice  = parseFloat(params.get("ap")||"30");
  const quarterRates = (params.get("qr")||"5.25,5,4.75,4.5").split(",").map(Number);
  const baseRate     = parseFloat(params.get("br")||"4.25");
  const atmVol       = parseFloat(params.get("av")||"0.35");
  const skew         = parseFloat(params.get("sk")||"-0.08");
  const convexity    = parseFloat(params.get("cv")||"0.20");
  const adjStr       = params.get("adj")||"";
  const perStrikeAdj = {};
  if(adjStr) adjStr.split(";").forEach(p=>{const [k,v]=p.split(":");perStrikeAdj[parseInt(k)]=parseFloat(v);});

  const [selExp, setSelExp] = useState(params.get("exp")||"Dec-26");

  const curve = useMemo(()=>buildForwardCurve(anchorPrice,quarterRates,baseRate),[]);
  const today = new Date();
  const expiryPriceMap = useMemo(()=>{
    const map={};
    curve.forEach(c=>{
      const key=MONTHS[c.month].slice(0,3)+"-"+String(c.year).slice(2);
      const expDate=new Date(c.year,c.month,15);
      const T=Math.max((expDate-today)/(365*24*3600*1000),0.003);
      map[key]={price:c.price,T};
    });
    return map;
  },[curve]);

  const activeExp = expiryPriceMap[selExp]||Object.values(expiryPriceMap)[0];
  const F = activeExp?.price??anchorPrice;
  const T = activeExp?.T??0.5;
  const r = baseRate/100;
  const volFn = (K)=>strikeVol(K,F,atmVol,skew,convexity,perStrikeAdj[K]);

  const rows = useMemo(()=>STRIKES.map(K=>{
    const s=volFn(K);
    return {K,s,
      call:bsCall(F,K,T,r,s), put:bsPut(F,K,T,r,s),
      cDelta:bsDelta(F,K,T,r,s,true), pDelta:bsDelta(F,K,T,r,s,false),
      gamma:bsGamma(F,K,T,r,s), vega:bsVega(F,K,T,r,s)
    };
  }),[F,T,r,selExp]);

  const [now,setNow] = useState(new Date());
  useEffect(()=>{const id=setInterval(()=>setNow(new Date()),60000);return()=>clearInterval(id);},[]);

  return (
    <div style={{minHeight:"100vh",background:"#070b10",color:"#d8e2ef",
      fontFamily:"'IBM Plex Mono','Courier New',monospace",padding:"16px 20px"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&display=swap');
        *{box-sizing:border-box;}
        .exp-po{cursor:pointer;padding:5px 12px;font-size:11px;font-family:'IBM Plex Mono',monospace;
          letter-spacing:0.06em;border-radius:2px;border:1px solid;transition:all 0.12s;
          display:flex;flex-direction:column;align-items:center;gap:1px;}
      `}</style>

      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,
        borderBottom:"1px solid #182030",paddingBottom:10}}>
        <div style={{display:"flex",alignItems:"baseline",gap:12}}>
          <span style={{fontSize:9,letterSpacing:"0.2em",color:"#2d3d50",textTransform:"uppercase"}}>CCA</span>
          <span style={{fontSize:18,fontWeight:700,color:"#f0f4fa",fontFamily:"'IBM Plex Mono',monospace"}}>
            Market View
          </span>
          <span style={{fontSize:9,color:"#1e2d3d",letterSpacing:"0.1em"}}>{selExp}</span>
        </div>
        <div style={{display:"flex",gap:18,alignItems:"baseline"}}>
          <span style={{fontSize:10,color:"#334155"}}>
            F <span style={{color:"#38bdf8",fontWeight:700,fontSize:15}}>${F.toFixed(2)}</span>
          </span>
          <span style={{fontSize:10,color:"#334155"}}>
            <span style={{color:"#34d399",fontWeight:600}}>{(T*365).toFixed(0)}d</span>
          </span>
          <span style={{fontSize:10,color:"#334155"}}>
            ATM <span style={{color:"#fb923c",fontWeight:600}}>{(atmVol*100).toFixed(1)}%</span>
          </span>
          <span style={{fontSize:10,color:"#334155"}}>
            skew <span style={{color:"#a78bfa",fontWeight:600}}>{skew>=0?"+":""}{(skew*100).toFixed(1)}%</span>
          </span>
          <span style={{fontSize:9,color:"#1e2d3d"}}>
            {now.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"})}
          </span>
        </div>
      </div>

      {/* Expiry selector */}
      <div style={{display:"flex",gap:6,marginBottom:16,flexWrap:"wrap"}}>
        {OPTIONS_EXPIRIES.map(e=>{
          const key=MONTHS[e.month].slice(0,3)+"-"+String(e.year).slice(2);
          const isSel=selExp===key;
          const cp=expiryPriceMap[key];
          return (
            <button key={key} className="exp-po" onClick={()=>setSelExp(key)} style={{
              borderColor:isSel?"#38bdf8":"#182030",
              background:isSel?"rgba(56,189,248,0.10)":"#0b0f18",
              color:isSel?"#38bdf8":"#475569",fontWeight:isSel?700:400,
            }}>
              <span>{key}</span>
              {cp&&<span style={{fontSize:10,color:isSel?"#7dd3fc":"#2d3d50",fontWeight:600}}>${cp.price.toFixed(2)}</span>}
            </button>
          );
        })}
      </div>

      {/* Chain */}
      <div style={{overflowX:"auto"}}>
        <div style={{minWidth:520}}>
          <div style={{display:"grid",gridTemplateColumns:"120px 3px 130px 100px 90px 3px 130px 100px 90px",
            padding:"6px 10px",borderBottom:"2px solid #1a2840",marginBottom:0}}>
            <div style={{display:"grid",gridTemplateColumns:"60px 56px"}}>
              <span style={{fontSize:8,color:"#2d3d50",letterSpacing:"0.14em",textTransform:"uppercase"}}>Strike</span>
              <span style={{fontSize:8,color:"#a78bfa44",letterSpacing:"0.1em",textTransform:"uppercase",textAlign:"center"}}>Vol%</span>
            </div>
            <span/>
            <span style={{fontSize:9,color:"#34d399",letterSpacing:"0.12em",textTransform:"uppercase",textAlign:"right",fontWeight:700}}>CALL</span>
            <span style={{fontSize:8,color:"#34d39988",textTransform:"uppercase",textAlign:"right"}}>Delta</span>
            <span style={{fontSize:8,color:"#34d39944",textTransform:"uppercase",textAlign:"right"}}>Vega</span>
            <span/>
            <span style={{fontSize:9,color:"#f87171",letterSpacing:"0.12em",textTransform:"uppercase",textAlign:"right",fontWeight:700}}>PUT</span>
            <span style={{fontSize:8,color:"#f8717188",textTransform:"uppercase",textAlign:"right"}}>Delta</span>
            <span style={{fontSize:8,color:"#f8717144",textTransform:"uppercase",textAlign:"right"}}>Vega</span>
          </div>

          {rows.map((row,idx)=>{
            const isATM  = Math.abs(row.K-F)<0.5;
            const isNear = Math.abs(row.K-F)<2;
            const cItm   = row.K<F, pItm=row.K>F;
            return (
              <div key={row.K} style={{
                display:"grid",
                gridTemplateColumns:"120px 3px 130px 100px 90px 3px 130px 100px 90px",
                padding:isATM?"11px 10px":"5px 10px",
                borderBottom:"1px solid",
                borderBottomColor:isNear?"#141e2c":"#0b0e14",
                background:isATM?"rgba(56,189,248,0.08)":idx%2===0?"transparent":"rgba(255,255,255,0.007)",
                borderLeft:isATM?"3px solid #38bdf8":"3px solid transparent",
                alignItems:"center",
                transition:"background 0.1s",
              }}>
                <div style={{display:"grid",gridTemplateColumns:"60px 56px",alignItems:"center"}}>
                  <span style={{
                    fontSize:isATM?17:14,fontWeight:isATM?800:cItm||pItm?600:400,
                    color:isATM?"#38bdf8":cItm?"#94a3b8":pItm?"#94a3b8":"#3a4d5e",
                    fontVariantNumeric:"tabular-nums"
                  }}>
                    {row.K}
                  </span>
                  <span style={{fontSize:9,color:"#a78bfa55",textAlign:"center",fontVariantNumeric:"tabular-nums"}}>
                    {(row.s*100).toFixed(1)}
                  </span>
                </div>
                <div style={{width:1,background:"#182030",alignSelf:"stretch",margin:"2px 6px"}}/>
                <div style={{textAlign:"right",paddingRight:10}}>
                  <span style={{
                    fontSize:isATM?17:14,fontWeight:isATM?700:600,
                    color:row.call<0.005?"#1a2535":cItm?"#34d399":isATM?"#7dd3fc":"#2d4a5e",
                    fontVariantNumeric:"tabular-nums"
                  }}>
                    {row.call<0.005?"—":row.call.toFixed(2)}
                  </span>
                </div>
                <span style={{fontSize:isATM?12:11,color:cItm?"#34d39988":"#1e3045",textAlign:"right",fontVariantNumeric:"tabular-nums",paddingRight:6}}>
                  {row.cDelta.toFixed(2)}
                </span>
                <span style={{fontSize:9,color:"#162030",textAlign:"right",paddingRight:8,fontVariantNumeric:"tabular-nums"}}>
                  {row.vega.toFixed(2)}
                </span>
                <div style={{width:1,background:"#182030",alignSelf:"stretch",margin:"2px 6px"}}/>
                <div style={{textAlign:"right",paddingRight:10}}>
                  <span style={{
                    fontSize:isATM?17:14,fontWeight:isATM?700:600,
                    color:row.put<0.005?"#1a2535":pItm?"#f87171":isATM?"#fca5a5":"#2d4a5e",
                    fontVariantNumeric:"tabular-nums"
                  }}>
                    {row.put<0.005?"—":row.put.toFixed(2)}
                  </span>
                </div>
                <span style={{fontSize:isATM?12:11,color:pItm?"#f8717188":"#1e3045",textAlign:"right",fontVariantNumeric:"tabular-nums",paddingRight:6}}>
                  {row.pDelta.toFixed(2)}
                </span>
                <span style={{fontSize:9,color:"#162030",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>
                  {row.vega.toFixed(2)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{marginTop:10,display:"flex",justifyContent:"space-between",fontSize:8,color:"#182030"}}>
        <span>BS Futures Options - CCA Desk</span>
        <span>ITM calls ▶ green   ITM puts ▶ red   ATM ▶ highlighted row</span>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function CCADesk() {
  // ── Detect pop-out mode ──────────────────────────────────────────────────────
  const isPopout = new URLSearchParams(window.location.search).get("popout")==="1";
  if(isPopout) return <PopoutChain/>;

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

  // ── Options spread blotter
  const [blotter,setBlotter]               = useState([]);
  const [sStrat,setSStrat]                 = useState("Call Spread");
  const [sExpiry,setSExpiry]               = useState("Dec-26");
  const [sK1,setSK1]                       = useState(28);
  const [sK2,setSK2]                       = useState(30);
  const [sK3,setSK3]                       = useState(32);
  const [sQty,setSQty]                     = useState(100);

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
      <div style={{display:"flex",borderBottom:"1px solid #182030",marginBottom:18,gap:0,flexWrap:"wrap"}}>
        {[
          {label:"Market View",badge:"LIVE"},
          {label:"Blotter View",badge:blotter.length>0?String(blotter.length):null},
          {label:"Options Chain",badge:null},
          {label:"Vol Surface",badge:null},
          {label:"Futures Curve",badge:null},
        ].map(({label,badge},i)=>(
          <button key={label} className={`tab-btn${tab===i?" on":""}`} onClick={()=>setTab(i)}
            style={{position:"relative"}}>
            {label}
            {badge&&<span style={{
              position:"absolute",top:2,right:2,fontSize:6,fontWeight:700,
              background:i===1?"#34d399":i===0?"#38bdf8":"transparent",
              color:i===0||i===1?"#070b10":"#38bdf8",
              padding:"1px 4px",borderRadius:8,letterSpacing:"0.05em"
            }}>{badge}</span>}
          </button>
        ))}
      </div>


      {/* ════════════ MARKET VIEW TAB (read-only clean chain) ════════════ */}
      {tab===0 && (
        <div>
          {/* Compact expiry bar */}
          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:18,flexWrap:"wrap"}}>
            {OPTIONS_EXPIRIES.map(e=>{
              const key=`${MONTHS[e.month].slice(0,3)}-${String(e.year).slice(2)}`;
              const isSel=selectedExpiry===key;
              const cp=expiryPriceMap[key];
              return (
                <button key={key} onClick={()=>setSelectedExpiry(key)} style={{
                  padding:"6px 14px",fontFamily:"'IBM Plex Mono',monospace",
                  fontSize:11,fontWeight:isSel?700:400,letterSpacing:"0.06em",
                  borderRadius:2,cursor:"pointer",border:"1px solid",
                  borderColor:isSel?"#38bdf8":"#182030",
                  background:isSel?"rgba(56,189,248,0.10)":"#0b0f18",
                  color:isSel?"#38bdf8":"#475569",transition:"all 0.12s",
                  display:"flex",flexDirection:"column",alignItems:"center",gap:2,
                }}>
                  <span>{key}</span>
                  {cp&&<span style={{fontSize:10,color:isSel?"#7dd3fc":"#334155",fontWeight:600}}>${cp.price.toFixed(2)}</span>}
                </button>
              );
            })}
            <div style={{marginLeft:"auto",display:"flex",gap:16,alignItems:"center"}}>
              <span style={{fontSize:10,color:"#334155"}}>F <span style={{color:"#38bdf8",fontWeight:700,fontSize:14}}>${F.toFixed(2)}</span></span>
              <span style={{fontSize:10,color:"#334155"}}>T <span style={{color:"#34d399",fontWeight:600}}>{(T*365).toFixed(0)}d</span></span>
              <span style={{fontSize:10,color:"#334155"}}>ATM vol <span style={{color:"#fb923c",fontWeight:600}}>{(atmVol*100).toFixed(1)}%</span></span>
              <span style={{fontSize:10,color:"#334155"}}>skew <span style={{color:"#a78bfa",fontWeight:600}}>{skew>=0?"+":""}{(skew*100).toFixed(1)}%</span></span>
              <button onClick={()=>{
                const adjStr=STRIKES.filter(k=>perStrikeAdj[k]!==0).map(k=>k+":"+perStrikeAdj[k]).join(";");
                const p=new URLSearchParams({
                  popout:"1",
                  ap:anchorPrice,
                  qr:quarterRates.join(","),
                  br:baseRate,
                  av:atmVol,
                  sk:skew,
                  cv:convexity,
                  exp:selectedExpiry,
                  ...(adjStr?{adj:adjStr}:{})
                });
                window.open("?"+p.toString(),"_blank","width=900,height=820,toolbar=0,menubar=0,location=0");
              }} style={{
                background:"transparent",border:"1px solid #38bdf844",borderRadius:2,
                color:"#38bdf8",fontFamily:"'IBM Plex Mono',monospace",fontSize:9,
                padding:"4px 10px",cursor:"pointer",letterSpacing:"0.1em",
                display:"flex",alignItems:"center",gap:5,transition:"all 0.15s",
              }}
              onMouseEnter={e=>{e.currentTarget.style.background="rgba(56,189,248,0.08)";e.currentTarget.style.borderColor="#38bdf8";}}
              onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.borderColor="#38bdf844";}}>
                <span style={{fontSize:11}}>⤢</span> POP OUT
              </button>
            </div>
          </div>

          {/* Clean read-only chain */}
          <div style={{overflowX:"auto"}}>
            <div style={{minWidth:560}}>
              {/* Header row */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 3px 120px 90px 80px 3px 120px 90px 80px",
                gap:"0 0",padding:"8px 12px",borderBottom:"2px solid #182030",marginBottom:0}}>
                <div style={{display:"grid",gridTemplateColumns:"60px 60px",gap:0}}>
                  <span style={{fontSize:9,color:"#334155",letterSpacing:"0.12em",textTransform:"uppercase"}}>Strike</span>
                  <span style={{fontSize:9,color:"#a78bfa66",letterSpacing:"0.1em",textTransform:"uppercase",textAlign:"center"}}>Vol</span>
                </div>
                <span/>
                <span style={{fontSize:9,color:"#34d399",letterSpacing:"0.12em",textTransform:"uppercase",textAlign:"right",fontWeight:600}}>CALL</span>
                <span style={{fontSize:9,color:"#34d39988",letterSpacing:"0.1em",textTransform:"uppercase",textAlign:"right"}}>Delta</span>
                <span style={{fontSize:9,color:"#34d39966",letterSpacing:"0.1em",textTransform:"uppercase",textAlign:"right"}}>Vega</span>
                <span/>
                <span style={{fontSize:9,color:"#f87171",letterSpacing:"0.12em",textTransform:"uppercase",textAlign:"right",fontWeight:600}}>PUT</span>
                <span style={{fontSize:9,color:"#f8717188",letterSpacing:"0.1em",textTransform:"uppercase",textAlign:"right"}}>Delta</span>
                <span style={{fontSize:9,color:"#f8717166",letterSpacing:"0.1em",textTransform:"uppercase",textAlign:"right"}}>Vega</span>
              </div>

              {rows.map((row,idx)=>{
                const isATM   = Math.abs(row.K-F)<0.5;
                const isNear  = Math.abs(row.K-F)<1.5;
                const callItm = row.K<F;
                const putItm  = row.K>F;
                const isEven  = idx%2===0;
                return (
                  <div key={row.K} style={{
                    display:"grid",
                    gridTemplateColumns:"1fr 3px 120px 90px 80px 3px 120px 90px 80px",
                    gap:"0 0",
                    padding:isATM?"10px 12px":"6px 12px",
                    borderBottom:isATM?"none":"1px solid",
                    borderBottomColor:isNear?"#182030":"#0d1117",
                    borderTop:isATM?"2px solid #38bdf822":"none",
                    borderBottomWidth:isATM?2:1,
                    borderTopColor:isATM?"#38bdf822":"transparent",
                    background:isATM?"rgba(56,189,248,0.07)":isEven?"transparent":"rgba(255,255,255,0.008)",
                    alignItems:"center",
                  }}>
                    {/* Strike + vol */}
                    <div style={{display:"grid",gridTemplateColumns:"60px 60px",gap:0,alignItems:"center"}}>
                      <span style={{
                        fontSize:isATM?15:13,fontWeight:isATM?800:callItm||putItm?600:400,
                        color:isATM?"#38bdf8":callItm?"#94a3b8":putItm?"#94a3b8":"#4a5d70",
                        fontVariantNumeric:"tabular-nums",letterSpacing:"0.02em"
                      }}>
                        {isATM&&<span style={{fontSize:7,marginRight:3,color:"#38bdf8"}}>▶</span>}
                        {row.K}
                      </span>
                      <span style={{fontSize:9,color:"#a78bfa77",textAlign:"center",fontVariantNumeric:"tabular-nums"}}>
                        {(row.s*100).toFixed(1)}
                      </span>
                    </div>

                    {/* Vertical divider */}
                    <div style={{width:1,background:"#182030",alignSelf:"stretch",margin:"2px 8px"}}/>

                    {/* Call */}
                    <div style={{textAlign:"right",paddingRight:8}}>
                      <span style={{
                        fontSize:isATM?15:13,fontWeight:isATM?700:600,
                        color:row.call<0.005?"#1e2d3d":callItm?"#34d399":isATM?"#7dd3fc":"#4a6070",
                        fontVariantNumeric:"tabular-nums"
                      }}>
                        {row.call<0.005?"—":row.call.toFixed(2)}
                      </span>
                    </div>
                    <span style={{fontSize:isATM?11:10,color:callItm?"#34d39999":"#2d4055",textAlign:"right",fontVariantNumeric:"tabular-nums",paddingRight:4}}>
                      {row.cDelta.toFixed(2)}
                    </span>
                    <span style={{fontSize:9,color:"#1e3050",textAlign:"right",paddingRight:8,fontVariantNumeric:"tabular-nums"}}>
                      {row.vega.toFixed(2)}
                    </span>

                    {/* Vertical divider */}
                    <div style={{width:1,background:"#182030",alignSelf:"stretch",margin:"2px 8px"}}/>

                    {/* Put */}
                    <div style={{textAlign:"right",paddingRight:8}}>
                      <span style={{
                        fontSize:isATM?15:13,fontWeight:isATM?700:600,
                        color:row.put<0.005?"#1e2d3d":putItm?"#f87171":isATM?"#fca5a5":"#4a6070",
                        fontVariantNumeric:"tabular-nums"
                      }}>
                        {row.put<0.005?"—":row.put.toFixed(2)}
                      </span>
                    </div>
                    <span style={{fontSize:isATM?11:10,color:putItm?"#f8717199":"#2d4055",textAlign:"right",fontVariantNumeric:"tabular-nums",paddingRight:4}}>
                      {row.pDelta.toFixed(2)}
                    </span>
                    <span style={{fontSize:9,color:"#1e3050",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>
                      {row.vega.toFixed(2)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{marginTop:12,display:"flex",justifyContent:"space-between",fontSize:8,color:"#182030",letterSpacing:"0.06em"}}>
            <span>Read-only view - edit vol params in Options Chain tab</span>
            <span>▶ = ATM  |  ITM calls green  |  ITM puts red</span>
          </div>
        </div>
      )}

      {/* ════════════ BLOTTER VIEW TAB ════════════ */}
      {tab===1 && (
        <div>
          {blotter.length===0 ? (
            <div style={{textAlign:"center",padding:"60px 0",color:"#1e2d3d"}}>
              <div style={{fontSize:32,marginBottom:12,opacity:0.3}}>◈</div>
              <div style={{fontSize:11,letterSpacing:"0.12em",color:"#2d3d50"}}>No trades in blotter</div>
              <div style={{fontSize:9,color:"#182030",marginTop:6}}>Add spreads from the Options Chain tab</div>
            </div>
          ) : (
            <div>
              {/* Summary bar */}
              <div style={{display:"flex",gap:0,marginBottom:20,background:"#0b0f18",border:"1px solid #182030",borderRadius:3,overflow:"hidden"}}>
                {[
                  {label:"Trades",val:blotter.length,color:"#94a3b8",fmt:v=>v},
                  {label:"Net Premium",val:blotter.reduce((s,b)=>s+(typeof b.netPrem==="number"?b.netPrem:0),0),color:blotter.reduce((s,b)=>s+(typeof b.netPrem==="number"?b.netPrem:0),0)>=0?"#34d399":"#f87171",fmt:v=>(v>=0?"+":"")+v.toFixed(3)},
                  {label:"Net Delta",val:blotter.reduce((s,b)=>s+(typeof b.delta==="number"?b.delta:0),0),color:"#38bdf8",fmt:v=>(v>=0?"+":"")+v.toFixed(3)},
                  {label:"Net Vega",val:blotter.reduce((s,b)=>s+(typeof b.vega==="number"?b.vega:0),0),color:"#a78bfa",fmt:v=>(v>=0?"+":"")+v.toFixed(3)},
                  {label:"Net Gamma",val:blotter.reduce((s,b)=>s+(typeof b.gamma==="number"?b.gamma:0),0),color:"#fb923c",fmt:v=>(v>=0?"+":"")+v.toFixed(4)},
                ].map(({label,val,color,fmt},i)=>(
                  <div key={label} style={{flex:1,padding:"14px 18px",borderRight:i<4?"1px solid #182030":"none"}}>
                    <div style={{fontSize:8,color:"#334155",letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:5}}>{label}</div>
                    <div style={{fontSize:20,fontWeight:700,color,fontFamily:"'IBM Plex Mono',monospace",fontVariantNumeric:"tabular-nums"}}>{fmt(val)}</div>
                  </div>
                ))}
              </div>

              {/* Trade cards */}
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {blotter.map((b,idx)=>{
                  const sc=STRAT_COLORS[b.strat]||"#38bdf8";
                  return (
                    <div key={b.id} style={{
                      background:"#0b0f18",border:`1px solid #182030`,borderRadius:3,
                      borderLeft:`3px solid ${sc}`,padding:"12px 16px",
                      display:"grid",gridTemplateColumns:"auto 1fr auto",gap:"0 20px",alignItems:"start"
                    }}>
                      {/* Left: strategy + time */}
                      <div style={{minWidth:120}}>
                        <div style={{fontSize:13,fontWeight:700,color:sc,marginBottom:3,letterSpacing:"0.02em"}}>{b.strat}</div>
                        <div style={{fontSize:9,color:"#38bdf8",marginBottom:2}}>{b.expiry}</div>
                        <div style={{fontSize:8,color:"#334155"}}>{b.time}</div>
                        <div style={{fontSize:9,color:"#475569",marginTop:6}}>
                          {b.legs.map((l,i)=>(
                            <div key={i} style={{marginBottom:2}}>
                              <span style={{color:l.pos.startsWith("+")?sc:"#f87171",fontWeight:600,marginRight:4}}>{l.pos}</span>
                              <span style={{color:"#94a3b8"}}>{l.type} K{l.K}</span>
                              <span style={{color:"#475569",marginLeft:6}}>${l.price.toFixed(3)}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Middle: key metrics */}
                      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:"0 12px"}}>
                        {[
                          {label:"Net Prem",val:b.netPrem,color:typeof b.netPrem==="number"&&b.netPrem>=0?"#34d399":"#f87171",fmt:v=>typeof v==="number"?(v>=0?"+":"")+v.toFixed(3):v},
                          {label:"Delta",val:b.delta,color:"#38bdf8",fmt:v=>typeof v==="number"?(v>=0?"+":"")+v.toFixed(3):v},
                          {label:"Vega",val:b.vega,color:"#a78bfa",fmt:v=>typeof v==="number"?(v>=0?"+":"")+v.toFixed(3):v},
                          {label:"Breakeven",val:b.breakeven,color:"#94a3b8",fmt:v=>v},
                          {label:"Qty",val:b.qty,color:"#d8e2ef",fmt:v=>v+" lots"},
                        ].map(({label,val,color,fmt})=>(
                          <div key={label}>
                            <div style={{fontSize:7,color:"#334155",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:3}}>{label}</div>
                            <div style={{fontSize:12,fontWeight:600,color,fontVariantNumeric:"tabular-nums"}}>{fmt(val)}</div>
                          </div>
                        ))}
                        <div style={{gridColumn:"1/-1",marginTop:8,paddingTop:8,borderTop:"1px solid #182030",display:"flex",gap:16}}>
                          <div>
                            <span style={{fontSize:7,color:"#334155",marginRight:6}}>MAX PROFIT</span>
                            <span style={{fontSize:10,color:"#34d399",fontWeight:600}}>
                              {typeof b.maxProfit==="number"?"+$"+(b.maxProfit*b.qty).toFixed(2):b.maxProfit}
                            </span>
                          </div>
                          <div>
                            <span style={{fontSize:7,color:"#334155",marginRight:6}}>MAX LOSS</span>
                            <span style={{fontSize:10,color:"#f87171",fontWeight:600}}>
                              {typeof b.maxLoss==="number"?"-$"+(b.maxLoss*b.qty).toFixed(2):b.maxLoss}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Right: remove */}
                      <button onClick={()=>setBlotter(bl=>bl.filter(x=>x.id!==b.id))}
                        style={{background:"transparent",border:"1px solid #182030",borderRadius:2,
                          color:"#334155",fontFamily:"'IBM Plex Mono',monospace",fontSize:8,
                          padding:"3px 8px",cursor:"pointer",letterSpacing:"0.08em",
                          transition:"all 0.12s"}}
                        onMouseEnter={e=>{e.target.style.borderColor="#f87171";e.target.style.color="#f87171";}}
                        onMouseLeave={e=>{e.target.style.borderColor="#182030";e.target.style.color="#334155";}}>
                        REMOVE
                      </button>
                    </div>
                  );
                })}
              </div>

              <div style={{marginTop:14,display:"flex",justifyContent:"flex-end"}}>
                <button onClick={()=>setBlotter([])}
                  style={{fontSize:8,color:"#f87171",background:"transparent",border:"1px solid #f8717133",
                    borderRadius:2,padding:"5px 14px",cursor:"pointer",fontFamily:"'IBM Plex Mono',monospace",
                    letterSpacing:"0.1em"}}>
                  CLEAR ALL TRADES
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════════ OPTIONS CHAIN ════════════ */}
      {tab===2 && (
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
            <span>BS FUTURES OPTIONS - sigma(K)=ATMvol + Skew x ln(K/F) + Convexity x ln(K/F)^2 + adj</span>
            <span>ATM highlighted - ITM=green - OTM=dim - adj=per-strike pp override</span>
          </div>

          {/* ════ SPREAD BUILDER ════ */}
          <SpreadBuilder
            rows={rows} F={F} T={T} r={r} volFn={volFn}
            sStrat={sStrat} setSStrat={setSStrat}
            sExpiry={sExpiry} setSExpiry={setSExpiry}
            sK1={sK1} setSK1={setSK1}
            sK2={sK2} setSK2={setSK2}
            sK3={sK3} setSK3={setSK3}
            sQty={sQty} setSQty={setSQty}
            blotter={blotter} setBlotter={setBlotter}
            selectedExpiry={selectedExpiry}
            OPTIONS_EXPIRIES={OPTIONS_EXPIRIES}
            MONTHS={MONTHS}
          />
        </div>
      )}

      {/* ════════════ VOL SURFACE TAB ════════════ */}
      {tab===3 && (
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
      {tab===4 && (
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
