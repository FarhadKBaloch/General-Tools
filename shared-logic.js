// AUTO-EXTRACTED from sprout-scout.html. Do not edit by hand.
// Regenerate with: node build-shared.js
// Keeping these in one place means the Slack bot and the dashboard
// can never disagree about a threshold.

const RH_WET=90;          // threshold %

const COVER_ON_MONTH = 9,  COVER_ON_DAY = 25;   // Oct 25: plastic goes back on
const COVER_OFF_MONTH = 4, COVER_OFF_DAY = 10;  // May 10: plastic comes off
function isCovered(date){
  if(!date) return null;                        // unknown: caller decides
  const m=date.getMonth(), d=date.getDate();
  if(m > COVER_ON_MONTH || (m===COVER_ON_MONTH && d>=COVER_ON_DAY)) return true;   // late Oct-Dec
  if(m < COVER_OFF_MONTH || (m===COVER_OFF_MONTH && d<COVER_OFF_DAY)) return true;  // Jan-early May
  return false;
}

const GH_MIN_TEMP = 68;   // indoor daytime baseline while COVERED, °F
function houseTemp(f){
  if(f.tmax==null) return null;
  // Only lift to the indoor baseline when the plastic is actually on.
  const covered = isCovered(f.date);
  if(covered===false) return f.tmax;            // open house: outdoor temp is real
  return Math.max(f.tmax, GH_MIN_TEMP);
}

function houseRH(f){
  if(f.rh==null) return null;
  const covered = isCovered(f.date);
  if(covered===false) return f.rh;              // open house: outdoor humidity is real
  return f.tmax!=null && f.tmax < GH_MIN_TEMP ? Math.max(f.rh, 60) : f.rh;
}

function lightTransmitRange(date){
  return isCovered(date)===false ? [1,1] : [GH_TRANSMIT_LO, GH_TRANSMIT_HI];
}

const DRY_HOLD = 3;   // hours it must remain dry to count as "dried"
function dryingInfo(hrs, wet){
  if(!hrs.length) return {dryHour:null, staysWet:false, reWets:false, rainHours:0, lastWetHour:null, dayDryHours:0};
  const rainHours = hrs.filter(x=>x.rain!=null && x.rain>0).length;
  let lastWetHour=null;
  hrs.forEach((x,i)=>{ if(wet[i]) lastWetHour=x.hour; });
  // walk forward for the first hour that begins a sustained dry stretch
  let dryHour=null;
  for(let i=0;i<hrs.length;i++){
    if(wet[i]) continue;
    let hold=0, j=i;
    while(j<hrs.length && !wet[j]){ hold++; j++; }
    const runsToEndOfDay = (j>=hrs.length);
    if(hold>=DRY_HOLD || runsToEndOfDay){
      // only meaningful if some wetness preceded it
      if(wet.slice(0,i).some(Boolean)){ dryHour=hrs[i].hour; }
      break;
    }
  }
  // Count daytime dry hours (6am-8pm). Evening dew returning is normal and does
  // not mean the day never dried; a day with almost no daytime drying does.
  let dayDry=0;
  for(let i=0;i<hrs.length;i++){
    if(hrs[i].hour>=6 && hrs[i].hour<=20 && !wet[i]) dayDry++;
  }
  const staysWet = dayDry < DRY_HOLD;      // fewer than 3 dry daytime hours
  if(staysWet) dryHour=null;
  // Does it re-wet after drying? (rain returning, or dew closing back in early)
  let reWets=false;
  if(dryHour!=null){
    const di=hrs.findIndex(x=>x.hour===dryHour);
    reWets = wet.slice(di).some((w,k)=> w && hrs[di+k].hour<=18);  // evening dew after 6pm is normal
  }
  return {dryHour, staysWet, reWets, rainHours, lastWetHour, dayDryHours:dayDry};
}

const DISEASES=[
  {name:'Botrytis (gray mold)', wet:8,  tmin:55, tmax:75,
   note:'Needs a film of moisture ~8 to 12 h with RH 85%+ at 55 to 75°F.',
   src:'UMass / Penn State Extension',
   act:'Heat and vent 2 to 3 times per hour after sunset and at sunrise; space plants and clear spent flowers.'},
  {name:'Downy mildew',         wet:6,  tmin:50, tmax:75,
   note:'Spores germinate and infect within ~6 to 12 h of free water at 50 to 75°F.',
   src:'UC IPM / UConn Extension',
   act:'Scout leaf undersides early in the day; avoid overhead irrigation and late-day watering.'},
  {name:'Basil downy mildew',   wet:4,  tmin:41, tmax:86,
   note:'Only ~4 h of leaf wetness needed to infect; optimum near 68°F.',
   src:'UConn Extension',
   act:'Highest priority for your 3" basil: water early, maximize airflow, scout undersides.'}
];

function diseaseRisk(d){
  if(d.lwdRun==null||d.wetTemp==null) return [];
  return DISEASES.filter(x=> d.lwdRun>=x.wet && d.wetTemp>=x.tmin && d.wetTemp<=x.tmax);
}

const GDD_BASE=50;

function gddFor(tmax,tmin){
  if(tmax==null||tmin==null) return null;
  return Math.max(0, ((tmax+tmin)/2) - GDD_BASE);
}

const PESTS=[
  {name:'Spider mites (two-spotted)', key:'tssm',
   // Ohio is humid: daily-MEAN RH rarely falls below 60, so a strict dry test
   // almost never fired here despite mites being a serious local pest. Relaxed
   // to below-average humidity for the region, or any hot day regardless of RH.
   test:f=>{ const t=houseTemp(f), r=houseRH(f);
     return t!=null && (t>=85 || (t>=80 && (r==null || r<68))); },
   why:'Hot, dry conditions drive rapid mite reproduction; a generation can close in 5-7 days and populations double quickly in heat.',
   src:'UMD / OSU Extension',
   act:'Check leaf undersides on the warmest, driest benches. Raising humidity and syringing foliage slows them.'},
  {name:'Aphids', key:'aphid',
   test:f=>{ const t=houseTemp(f); return t!=null && t>=70 && t<92; },
   why:'Development speeds up markedly once daytime temperatures reach about 70F, and females bear live young, so colonies build fast.',
   src:'MSU / UConn Extension',
   act:'Inspect new growth and leaf undersides on soft-growth crops; look for honeydew and shed skins.'},
  {name:'Thrips', key:'thrips',
   test:f=>{ const t=houseTemp(f); return t!=null && t>=75; },
   why:'Warm conditions accelerate the thrips life cycle and adults move readily between crops.',
   src:'Rutgers Extension',
   act:'Tap flowers over white paper and check blue sticky cards; thrips hide in flowers and growing points.'},
  {name:'Fungus gnats', key:'gnat',
   test:f=>{ const r=houseRH(f);
     return (r!=null && r>=75) || (f.rain!=null && f.rain>=0.2); },
   why:'Persistently damp media and high humidity favor larval development at the media surface.',
   src:'Rutgers Extension',
   act:'Check the media surface and use yellow cards near the pot line; let the surface dry between waterings.'},
  // Meadow spittlebug is ONE generation per year, but two very different stages.
  // Nymphs make the froth (mid-Apr to mid-Jun); adults then feed for months and
  // females return in Sep-Oct to lay eggs. Millcreek growers report seeing them
  // Jun-Sep, which is the adult stage. Splitting these keeps the advice correct:
  // froth is a cosmetic sales problem, adults are a scouting note.
  {name:'Meadow spittlebug (nymphs)', key:'spittlebug',
   test:f=>{
     if(!f.date) return false;                         // seasonal pest: no date, no call
     const m=f.date.getMonth(), day=f.date.getDate();  // 3=Apr, 4=May, 5=Jun
     if(m<3 || m>5) return false;
     if(m===3 && day<15) return false;                 // before mid-April: eggs not yet hatched
     if(m===5 && day>20) return false;                 // after ~Jun 20: nymphs have molted to adults
     // Ohio normal highs run 57F (mid-Apr) to 81F (early Jun).
     return f.tmax!=null && f.tmax>=55 && f.tmax<=86 && (f.rh==null || f.rh>=55);
   },
   why:'Nymphs feed inside frothy spittle masses on stems from late April through early June, maturing in about five to eight weeks. This is the stage that produces the visible froth and the only stage that causes meaningful feeding damage.',
   src:'UMN / Nursery Management / Ohio extension',
   act:'Check stems and leaf sheaths on Achillea, Coreopsis, Phlox, Potentilla and Boltonia first. Damage is largely cosmetic, but customers object to the froth during peak spring sales. A gloved hand or a forceful jet of water removes it; treat only above a few per square foot.'},
  {name:'Meadow spittlebug (adults)', key:'spittlebug_adult',
   test:f=>{
     if(!f.date) return false;
     const m=f.date.getMonth(), day=f.date.getDate();  // 5=Jun, 9=Oct
     if(m<5 || m>9) return false;                      // Jun through Oct
     if(m===5 && day<15) return false;                 // adults appear from about mid-June
     // Adults are mobile and tolerate a wider range than nymphs; no humidity test.
     return f.tmax!=null && f.tmax>=60;
   },
   why:'After the froth disappears, adults keep feeding for up to six months and stay in the crop through summer, with females returning in September and October to lay overwintering eggs. Adults do not make spittle, jump when disturbed, and cause little direct damage.',
   src:'UC IPM / UMN Extension / Crop Protection Network',
   act:'Nothing usually needs treating at this stage. Worth noting where you see them: adults now mark where eggs will be laid this fall, which is where froth will appear next April. Clearing weedy grass and debris around those beds reduces next spring\u2019s nymphs.'},
  {name:'Whitefly', key:'whitefly',
   test:f=>{ const t=houseTemp(f), r=houseRH(f);
     return t!=null && t>=75 && r!=null && r>=60; },
   why:'Warm, humid conditions shorten the whitefly cycle and support continuous generations.',
   src:'Extension IPM guidance',
   act:'Flip leaves on soft growth and watch yellow cards; look for nymphs on leaf undersides.'}
];

function pestRisk(f){ return PESTS.filter(p=>{ try{ return p.test(f); }catch(e){ return false; } }); }

function diseaseRisk(d){
  if(d.lwdRun==null||d.wetTemp==null) return [];
  return DISEASES.filter(x=> d.lwdRun>=x.wet && d.wetTemp>=x.tmin && d.wetTemp<=x.tmax);
}

const DLI_PER_MJ = 1.96;

const GH_TRANSMIT_LO = 0.50, GH_TRANSMIT_HI = 0.65;

function dliFrom(radMJ){ return radMJ==null?null:radMJ*DLI_PER_MJ; }
function dliInside(dli){
  if(dli==null) return null;
  return {lo:dli*GH_TRANSMIT_LO, hi:dli*GH_TRANSMIT_HI};
}

function dliVerdict(insideMid){
  if(insideMid==null) return null;
  if(insideMid<5)  return {lvl:'low',  label:'Very low',  note:'Below propagation minimums. Expect stretch, weak roots and slow finishing if this persists.'};
  if(insideMid<10) return {lvl:'low',  label:'Low',       note:'Under the ~10 mol target for quality young plants. Watch for stretching and delayed rooting.'};
  if(insideMid<15) return {lvl:'ok',   label:'Adequate',  note:'In the general target band for transplant quality and compact growth.'};
  if(insideMid<25) return {lvl:'good', label:'Good',      note:'Strong light for finishing quality: thicker stems, better branching.'};
  return {lvl:'high', label:'Very high', note:'High light. Watch for stress and faster drying; shade or whitewash may be warranted.'};
}

const LAG_MODEL = {
  'dead':            {lo:2, hi:14, mid:5,  why:'Cold, heat or water injury usually blackens and collapses days after the event, and older tissue can take longer still.'},
  'diseased':        {lo:5, hi:12, mid:8,  why:'Latent period between infection and visible symptoms; the downy mildew cycle from infection to sporulation typically runs 7-10 days.'},
  'poor quality':    {lo:7, hi:28, mid:14, why:'Low light or stress shows up as stretch and weak growth over weeks, not days.'},
  'overgrown/old':   {lo:14,hi:42, mid:21, why:'A missed sell window reflects conditions weeks earlier that pushed or held the crop.'},
  'pest damage':     {lo:5, hi:21, mid:10, why:'Populations must build before feeding damage becomes cull-worthy.'},
  'over watered':    {lo:3, hi:14, mid:7,  why:'Root damage precedes visible wilt and decline above ground.'},
  'broken':          {lo:0, hi:1,  mid:0,  why:'Physical damage is recorded when it happens.'},
  'overstocked':     {lo:0, hi:0,  mid:0,  why:'A planning decision, not a weather response.'},
  'potting plug loss':{lo:0,hi:3,  mid:1,  why:'Traced to plug quality or transplant handling rather than weather.'}
};

function lagFor(reason){
  const k=String(reason||'').toLowerCase();
  return LAG_MODEL[k] || {lo:0,hi:7,mid:3,why:'General lag between a weather event and a cull decision.'};
}

module.exports = { RH_WET, DRY_HOLD, dryingInfo, DISEASES, diseaseRisk,
  isCovered, lightTransmitRange, COVER_ON_MONTH, COVER_OFF_MONTH, houseTemp, houseRH, GH_MIN_TEMP,
  GDD_BASE, gddFor, PESTS, pestRisk, DLI_PER_MJ, GH_TRANSMIT_LO, GH_TRANSMIT_HI,
  dliFrom, dliVerdict, LAG_MODEL, lagFor };
