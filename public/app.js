const state={shipments:[],summary:null,stages:[],docs:{},users:[],selectedId:null,selected:null,timeline:[],filters:{search:'',stage:'',risk:''},pipelineStage:'',user:{name:'Local Admin',email:'local@recykal.test',role:'admin'}};
const $=id=>document.getElementById(id);const money=new Intl.NumberFormat('en-IN',{maximumFractionDigits:0});
function shortMoney(v){const n=Number(v||0);if(n>=1e7)return`₹${(n/1e7).toFixed(1)} Cr`;if(n>=1e5)return`₹${(n/1e5).toFixed(1)} L`;return`₹${money.format(n)}`}
function today(){return new Date().toISOString().slice(0,10)}function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}function title(v){return String(v||'').replace(/[-_]/g,' ').replace(/\b\w/g,m=>m.toUpperCase())}
async function api(path,opt){const r=await fetch(path,{headers:{'Content-Type':'application/json'},...opt});if(!r.ok)throw new Error(await r.text());return r.json()}
const DOC_GROUPS=[{label:'Deal',keys:['buyerPO']},{label:'Dispatch',keys:['vehImages','lrCopy','weighslip','invoice','ewaybill']},{label:'Transit & Delivery',keys:['tracking','pod','podDoc']},{label:'QC / DN',keys:['qcReport','dn']},{label:'Payment',keys:['paymentAdvice','utr']}];
const DOC_STATES=[['missing','Missing'],['pending','Pending'],['ok','OK'],['na','NA']];
const REASON_GROUPS={
  mm:[['buyer_po_not_shared','Buyer: PO not shared'],['po_terms_mismatch','Buyer/Seller: PO terms mismatch'],['party_confirmation_pending','Buyer/Seller: deal confirmation pending'],['commercial_terms_pending','Commercial: rate, qty or payment terms open']],
  predispatch:[['seller_dispatch_docs_pending','Seller: dispatch docs not shared'],['vehicle_lr_pending','Transporter: vehicle image/LR pending'],['seller_weighslip_pending','Seller: weighslip pending'],['invoice_ewaybill_pending','Seller: invoice or E-way bill pending'],['dispatch_not_confirmed','Seller/Transporter: dispatch not confirmed']],
  intransit:[['tracking_not_available','Transporter: tracking/ETA not available'],['vehicle_delayed','Transporter: vehicle delayed'],['fastag_sim_issue','Tracking: FASTag/SIM issue'],['route_hold_issue','Logistics: route hold or unloading slot issue']],
  reached:[['gate_entry_pending','Buyer: gate entry pending'],['unloading_pending','Buyer: unloading pending'],['pod_not_shared','Buyer: signed POD/unloading slip not shared'],['receipt_confirmation_pending','Buyer: receipt confirmation pending']],
  qc:[['qc_report_pending','Buyer: QC report pending'],['qty_weight_mismatch','Commercial: quantity/weight mismatch'],['quality_dispute','Buyer/Seller: quality dispute'],['dn_pending','Buyer: debit note pending'],['acceptance_pending','Buyer: final acceptance pending']],
  completed:[['payment_proof_upload_pending','Finance/Party: payment proof or UTR not uploaded'],['mip_closure_pending','MIP: transaction closure pending'],['audit_docs_pending','Audit: closure docs incomplete']],
  rejected:[['rejection_reason_pending','Ops: rejection reason pending'],['replacement_pending','Sales/Ops: replacement transaction pending']],
  common:[['payment_not_released','Buyer/Finance: payment not released'],['payment_done_system_upload_pending','Party: payment done but not uploaded in system'],['mip_upload_pending','Ops: docs available but MIP upload pending'],['mip_verification_pending','MIP: uploaded but verification pending'],['poc_not_responding','POC: not responding'],['internal_verification_pending','Ops: internal verification pending'],['other','Other: explain in remarks']]
};function docChip(s){const d=s.docStats;if(!d||!d.required)return'<span class="docchip na">no docs</span>';const cls=!d.missing&&!d.pending?'ok':d.missing?'bad':'warn';return`<span class="docchip ${cls}" title="OK ${d.ok} · Pending ${d.pending} · Missing ${d.missing} · NA ${d.na}">${d.verified}/${d.required} docs</span>`}
async function loadBootstrap(email){const d=await api('/api/bootstrap?user='+encodeURIComponent(email||'local@recykal.test'));Object.assign(state,{shipments:d.shipments,summary:d.summary,stages:d.stages,docs:d.docs,users:d.users||[],user:d.user||state.user});localStorage.setItem('ompUser',state.user.email);$('userName').textContent=state.user.role==='admin'?'All shipments':state.user.name;if($('userSelect'))$('userSelect').innerHTML=state.users.map(u=>`<option value="${u.email}" ${u.email===state.user.email?'selected':''}>${u.name} · ${u.role}</option>`).join('')}
async function init(){await loadBootstrap(localStorage.getItem('ompUser')||'local@recykal.test');setup();const first=ranked(filtered())[0]||state.shipments[0];if(first)await selectShipment(first.shipmentId,false);renderAll()}
function setView(view){document.querySelectorAll('.view-tab').forEach(x=>x.classList.toggle('active',x.dataset.view===view));document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));const el=$('view-'+view);if(el)el.classList.add('active')}
function setup(){if($('stageFilter'))$('stageFilter').innerHTML='<option value="">All stages</option>'+state.stages.map(s=>`<option value="${s.key}">${s.label}</option>`).join('');$('searchInput')&&($('searchInput').oninput=e=>{state.filters.search=e.target.value.toLowerCase();renderAll()});$('stageFilter')&&($('stageFilter').onchange=e=>{state.filters.stage=e.target.value;renderAll()});$('riskFilter')&&($('riskFilter').onchange=e=>{state.filters.risk=e.target.value;renderAll()});$('userSelect')&&($('userSelect').onchange=async e=>{state.selectedId=null;state.selected=null;state.pipelineStage='';await loadBootstrap(e.target.value);const first=ranked(filtered())[0]||state.shipments[0];if(first)await selectShipment(first.shipmentId,false);renderAll()});$('resetPipeline')&&($('resetPipeline').onclick=()=>{state.pipelineStage='';renderFunnel(state.shipments);renderPipelineList()});document.querySelectorAll('.view-tab').forEach(b=>b.onclick=()=>setView(b.dataset.view))}
function filtered(){return state.shipments.filter(s=>{const hay=[s.shipmentId,s.orderId,s.buyer,s.seller,s.owner,s.srPoc,s.brPoc,s.material,s.vertical].join(' ').toLowerCase();if(state.filters.search&&!hay.includes(state.filters.search))return false;if(state.filters.stage&&s.funnel!==state.filters.stage)return false;if(state.filters.risk==='needs'&&!needs(s))return false;if(state.filters.risk==='docs'&&!s.missingDocs.length)return false;if(state.filters.risk==='overdue'&&s.paymentRisk!=='overdue')return false;if(state.filters.risk==='unassigned'&&s.controlPoc)return false;return true})}
function isDue(s){return s.followUp&&s.followUp.dueDate&&s.followUp.dueDate<=today()&&s.funnel!=='completed'&&s.funnel!=='rejected'}function needs(s){if(s.funnel==='completed'||s.funnel==='rejected')return false;return!!(isDue(s)||!s.controlPoc||s.missingDocs.length||['overdue','pending','partial'].includes(s.paymentRisk)||s.funnel==='qc')}function score(s){let v=0;if(isDue(s))v+=70;if(!s.controlPoc)v+=50;if(s.paymentRisk==='overdue')v+=45;if(s.paymentRisk==='partial')v+=24;if(s.paymentRisk==='pending')v+=18;v+=s.missingDocs.length*12;if(s.funnel==='qc')v+=22;if(s.funnel==='reached')v+=12;return v}function ranked(rows){return[...rows].sort((a,b)=>score(b)-score(a))}
function renderAll(){const rows=filtered();renderKpis(state.shipments);renderList(rows);renderSelected();renderFunnel(state.shipments);renderToday(state.shipments);renderActions(state.shipments);renderTable(rows);renderPipelineList();renderAssociateStats()}
function flowSeg(list){return`<div class="flowbar">${list.map(s=>s.n?`<span class="seg ${s.cls}" style="flex:${s.n}" title="${s.label}: ${s.n}"></span>`:'').join('')}</div>`}
function renderKpis(rows){
  const completed=rows.filter(s=>s.funnel==='completed');
  const dueList=rows.filter(isDue);
  const payShip=rows.filter(s=>Number(s.balance||0)>1&&s.funnel!=='rejected');
  const paySum=payShip.reduce((a,s)=>a+Math.max(0,Number(s.balance||0)),0);
  const blocked=rows.filter(needs);
  const total=rows.length||1;
  const cards=[
    {tone:'today',icon:'TD',key:'To Clear Today',value:dueList.length,meta:'follow-ups due',note:dueList.length?'Open and close today':'No follow-ups due',pct:Math.min(100,Math.round(dueList.length/total*100))},
    {tone:'block',icon:'BL',key:'Blocked Cases',value:blocked.length,meta:'needs intervention',note:'Docs, owner, payment, QC/DN',pct:Math.min(100,Math.round(blocked.length/total*100))},
    {tone:'money',icon:'₹',key:'Payment Pending',value:shortMoney(paySum),meta:`${payShip.length} shipments`,note:'Balance open in shipment scope',pct:Math.min(100,Math.round(payShip.length/total*100))},
    {tone:'done',icon:'CL',key:'Completed',value:completed.length,meta:`${Math.round(completed.length/total*100)}% closure`,note:'Closed and audit-ready',pct:Math.min(100,Math.round(completed.length/total*100))}
  ];
  $('kpis').innerHTML=cards.map(c=>`<article class="metric-card ${c.tone}"><div class="metric-top"><span class="metric-icon">${c.icon}</span><span class="metric-meta">${c.meta}</span></div><div class="metric-value">${c.value}</div><div class="metric-key">${c.key}</div><p>${c.note}</p><div class="metric-track"><span style="width:${c.pct}%"></span></div></article>`).join('')
}
function renderList(rows){if(!$('shipmentList'))return;const sorted=ranked(rows);$('listCount').textContent=`${sorted.length} records`;$('shipmentList').innerHTML=sorted.map(shipmentCard).join('')||'<p class="sub">No shipments match filters.</p>';document.querySelectorAll('.shipment-item').forEach(el=>el.onclick=()=>selectShipment(el.dataset.id,true))}
function shipmentCard(s){const r=actionReason(s);return`<button class="shipment-item ${s.shipmentId===state.selectedId?'active':''}" data-id="${s.shipmentId}"><div class="shipment-top"><span class="shipment-id">${s.shipmentId}</span>${stagePill(s)}</div><div class="shipment-title">${esc(s.buyer||'-')}</div><div class="tiny-row">${paymentPill(s)} ${docChip(s)} ${s.followUp?`<span class="badge info">FU ${s.followUp.dueDate}</span>`:''} ${needs(s)?`<span class="badge ${r.kind}">${r.short}</span>`:''}</div>${payMini(s)}</button>`}
async function selectShipment(id,rerender=true){const d=await api(`/api/shipments/${encodeURIComponent(id)}?user=${encodeURIComponent(state.user.email)}`);state.selectedId=id;state.selected=d.shipment;state.timeline=d.timeline||[];if(rerender)renderAll()}
async function openInCrm(id){await selectShipment(id,false);setView('crm');renderAll()}
function renderSelected(){
  const s=state.selected;if(!$('selectedCard'))return;
  if(!s){$('selectedCard').innerHTML='<div class="empty-state"><h2>No shipment selected</h2></div>';return}
  const r=actionReason(s);
  $('selectedCard').innerHTML=`<div class="selected-head"><div><div class="badge info">${esc(s.stageLabel)}</div><h2>${s.shipmentId}</h2><div class="selected-sub">${esc(s.seller)} → ${esc(s.buyer)}</div>${payMini(s,true)}</div><div class="head-actions">${s.followUp?`<span class="badge ${isDue(s)?'bad':'info'}">Follow-up ${s.followUp.dueDate}</span>`:''}${paymentPill(s)}</div></div>
  <div class="detail-grid">${detail('Owner',s.owner||'Unassigned')}${detail('Stage',s.stageLabel)}${detail('Paid',shortMoney(s.paidAmount))}${detail('Balance',shortMoney(s.balance))}${detail('Net Payable',shortMoney(s.netPayable||s.total))}${detail('Follow-up',s.followUp?.dueDate||'Not set')}</div>
  <div class="crm-grid">
    <div class="section-box"><div class="section-title"><h3>Update Stage / Remarks</h3><span class="badge ${r.kind}">${r.short}</span></div><div class="section-body">
      <div class="form-row"><select id="stageUpdate">${state.stages.map(st=>`<option value="${st.key}" ${st.key===s.funnel?'selected':''}>${st.label}</option>`).join('')}</select><button class="primary-btn" id="saveStage">Save</button></div>
      <select id="stageReason" class="reason-select">${reasonOptions(s.funnel)}</select>
      <textarea id="stageNote" placeholder="Remarks: what happened, who was contacted, and next expected action"></textarea>
      <div class="form-row"><input id="ownerUpdate" value="${esc(s.controlPoc||'')}" placeholder="Owner"/><button class="secondary-btn" id="saveOwner">Owner</button></div>
    </div></div>
    <div class="section-box"><div class="section-title"><h3>Follow-up</h3><span class="badge ${s.followUp?isDue(s)?'bad':'info':'warn'}">${s.followUp?s.followUp.dueDate:'not set'}</span></div><div class="section-body">
      <div class="follow-grid"><input id="followupDate" type="date" value="${s.followUp?.dueDate||today()}"/><select id="followupStatus"><option value="open">Open / schedule</option><option value="done">Mark done</option></select><button class="primary-btn" id="saveFollowup">Save</button></div>
      <textarea id="followupNote" placeholder="Follow-up remarks: call outcome, commitment date, dependency"></textarea>
    </div></div>
    ${docGate(s)}
    <div class="section-box"><div class="section-title"><h3>Timeline</h3><span class="badge info">${state.timeline.length}</span></div><div class="section-body"><div class="timeline">${state.timeline.map(eventHtml).join('')||'<p class="sub">No updates yet.</p>'}</div><div class="form-row"><input id="generalNote" placeholder="Add remark"/><button class="secondary-btn" id="saveNote">Add</button></div></div></div>
  </div>`;
  $('saveStage').onclick=saveStage;$('saveOwner').onclick=saveOwner;$('saveNote').onclick=saveNote;$('saveFollowup').onclick=saveFollowup;$('stageUpdate').onchange=()=>{$('stageReason').innerHTML=reasonOptions($('stageUpdate').value)};document.querySelectorAll('.doc-select').forEach(x=>x.onchange=()=>saveDoc(x.dataset.key,x.value))
}
function reasonOptions(stage){
  const rows=[['','Select stuck reason'],...(REASON_GROUPS[stage]||[]),...REASON_GROUPS.common];
  return rows.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')
}
function reasonNote(reasonId,note){const label=(REASONS.find(r=>r[0]===reasonId)||[])[1]||'';return [label&&reasonId?`Reason: ${label}`:'',note||''].filter(Boolean).join(' | ')}
function detail(l,v){return`<div class="detail"><span>${l}</span><b>${esc(v||'-')}</b></div>`}
function docRow(i){return`<div class="doc-row ${i.req?'req':'opt'} v-${i.val}"><label class="doc-name" for="doc-${i.k}">${i.req?'<i class="reqdot">&#9679;</i>':''}${esc(i.label)}</label><select class="doc-select ${i.val}" id="doc-${i.k}" data-key="${i.k}">${DOC_STATES.map(([v,l])=>`<option value="${v}" ${v===i.val?'selected':''}>${l}</option>`).join('')}</select></div>`}
function docGate(s){const d=s.docStats||{required:0,verified:0,ok:0,pending:0,missing:0,na:0,pct:100};const req=new Set(s.requiredDocs||[]);
  const groups=DOC_GROUPS.map(g=>{const items=g.keys.map(k=>({k,label:state.docs[k]||k,val:s.docs[k]||'missing',req:req.has(k)}));const gReq=items.filter(i=>i.req);const gVer=gReq.filter(i=>i.val==='ok'||i.val==='na').length;return{...g,items,gReqN:gReq.length,gVer}}).filter(g=>g.items.length);
  const rowsHtml=groups.map(g=>`<div class="doc-group"><div class="dg-head"><span>${g.label}</span>${g.gReqN?`<em class="${g.gVer===g.gReqN?'ok':'pend'}">${g.gVer}/${g.gReqN}</em>`:'<em class="opt">later</em>'}</div>${g.items.map(docRow).join('')}</div>`).join('');
  const rcls=d.missing?'bad':d.pending?'warn':'ok';
  return`<div class="section-box docgate"><div class="section-title"><h3>Document Verification</h3><span class="doc-ratio ${rcls}">${d.verified}<i>/${d.required}</i> verified</span></div><div class="section-body"><div class="docv-summary"><div class="docv-bar ${rcls}"><span style="width:${d.pct}%"></span></div><div class="docv-legend"><span class="dl ok">${d.ok} OK</span><span class="dl pend">${d.pending} pending</span><span class="dl miss">${d.missing} missing</span><span class="dl na">${d.na} NA</span></div></div><div class="doc-groups">${rowsHtml}</div><p class="docv-note"><i class="reqdot">&#9679;</i> Required to clear <b>${esc(s.stageLabel)}</b>. Tap to verify &mdash; status only, no file upload.</p></div></div>`}
function renderFunnel(rows){
  const count={};state.stages.forEach(s=>count[s.key]=0);rows.forEach(s=>count[s.funnel]=(count[s.funnel]||0)+1);
  const max=Math.max(...Object.values(count),1);
  const html=state.stages.map((st,i)=>`<button class="stage-card process-step ${state.pipelineStage===st.key?'active':''}" data-stage="${st.key}"><div class="process-pin"><span>${i+1}</span></div><div class="stage-num">${count[st.key]||0}</div><div class="stage-name">${st.label}</div><div class="stage-sub">${stageHelp(st.key)}</div><div class="stage-bar-wrap"><div class="stage-bar" style="width:${((count[st.key]||0)/max)*100}%"></div></div></button>`).join('');
  if($('funnel'))$('funnel').innerHTML=html;if($('funnelFull'))$('funnelFull').innerHTML=html;
  document.querySelectorAll('.stage-card').forEach(x=>x.onclick=()=>{state.pipelineStage=x.dataset.stage;renderFunnel(state.shipments);renderPipelineList();if(x.closest('#funnel'))setView('pipeline')})
}
function stageHelp(key){return {mm:'Buyer PO / match lock',predispatch:'seller docs before truck',intransit:'tracking and ETA',reached:'gate-in / POD',qc:'QC and DN closure',completed:'payment and audit clear',rejected:'cancelled / rejected'}[key]||'process step'}
function renderPipelineList(){if(!$('pipelineList'))return;const rows=ranked(state.pipelineStage?state.shipments.filter(s=>s.funnel===state.pipelineStage):state.shipments);const label=state.pipelineStage?(state.stages.find(s=>s.key===state.pipelineStage)?.label||title(state.pipelineStage)):'All Shipments';$('pipelineListTitle').textContent=`${label} (${rows.length})`;$('pipelineList').innerHTML=rows.map(s=>`<button class="pipeline-item" data-id="${s.shipmentId}"><div class="pipe-main"><b>${s.shipmentId}</b><p>${esc(s.buyer||'-')}</p>${payMini(s)}</div><div class="pipe-side">${stagePill(s)} ${docChip(s)} ${paymentPill(s)}</div></button>`).join('')||'<p class="sub">No shipments in this stage.</p>';document.querySelectorAll('.pipeline-item').forEach(x=>x.onclick=()=>openInCrm(x.dataset.id))}
function renderToday(rows){const html=ranked(rows.filter(isDue)).slice(0,8).map(s=>`<button class="action-card" data-id="${s.shipmentId}"><div class="action-top"><b>${s.shipmentId}</b><span class="badge bad">Due</span></div><h3>${esc(s.followUp.note||'Follow-up due')}</h3><p>${esc(s.buyer||'-')}</p><p class="sub">${esc(s.owner||'Unassigned')} · ${esc(s.stageLabel)}</p>${payMini(s)}</button>`).join('')||'<p class="sub">No follow-ups due today.</p>';['todayList','todayListFull'].forEach(id=>$(id)&&($(id).innerHTML=html));document.querySelectorAll('#todayList .action-card,#todayListFull .action-card').forEach(x=>x.onclick=()=>openInCrm(x.dataset.id))}
function renderActions(rows){const html=ranked(rows.filter(needs)).slice(0,8).map(s=>{const r=actionReason(s);return`<button class="action-card" data-id="${s.shipmentId}"><div class="action-top"><b>${s.shipmentId}</b><span class="badge ${r.kind}">${r.short}</span></div><h3>${r.title}</h3><p>${r.body}</p><p class="sub">${esc(s.owner||'Unassigned')} · ${esc(s.stageLabel)}</p>${payMini(s)}</button>`}).join('')||'<p class="sub">No open blockers.</p>';['actionList','actionListFull'].forEach(id=>$(id)&&($(id).innerHTML=html));document.querySelectorAll('#actionList .action-card,#actionListFull .action-card').forEach(x=>x.onclick=()=>openInCrm(x.dataset.id))}
function renderTable(rows){if(!$('shipmentsTable'))return;$('shipmentsTable').innerHTML=ranked(rows).map(s=>`<tr data-id="${s.shipmentId}"><td><div class="strong">${s.shipmentId}</div><div class="sub">${s.orderId||''}</div></td><td><div class="strong">${esc(s.buyer||'-')}</div><div class="sub">${esc(s.seller||'-')}</div></td><td>${stagePill(s)}</td><td>${esc(s.owner||'Unassigned')}</td><td>${docPill(s)}</td><td>${paymentPill(s)} <span class="sub">${shortMoney(s.balance)}</span></td></tr>`).join('');document.querySelectorAll('tbody tr').forEach(x=>x.onclick=()=>openInCrm(x.dataset.id))}
function avg(nums){const clean=nums.filter(n=>Number.isFinite(n)&&n>=0);return clean.length?Math.round(clean.reduce((a,b)=>a+b,0)/clean.length):0}
function renderAssociateStats(){
  if(!$('associateStats'))return;
  const rows=state.shipments;
  const completed=rows.filter(s=>s.funnel==='completed');
  const open=rows.filter(s=>s.funnel!=='completed'&&s.funnel!=='rejected');
  const pending=rows.reduce((a,s)=>a+Math.max(0,Number(s.balance||0)),0);
  const avgCompletion=avg(completed.map(s=>Number(s.dispatchAge||0)));
  const avgOpenAge=avg(open.map(s=>Number(s.dispatchAge||0)));
  const stageRows=state.stages.map(st=>{
    const list=rows.filter(s=>s.funnel===st.key);
    return {label:st.label,count:list.length,age:avg(list.map(s=>Number(s.dispatchAge||0)))};
  }).filter(x=>x.count>0);
  $('associateStats').innerHTML=`<div class="associate-stats">
    <div class="assoc-metric"><span>Total shipments</span><b>${rows.length}</b></div>
    <div class="assoc-metric"><span>Open</span><b>${open.length}</b></div>
    <div class="assoc-metric"><span>Completed</span><b>${completed.length}</b></div>
    <div class="assoc-metric"><span>Pending payment</span><b>${shortMoney(pending)}</b></div>
    <div class="assoc-metric"><span>Avg completion</span><b>${avgCompletion}d</b></div>
    <div class="assoc-metric"><span>Avg open age</span><b>${avgOpenAge}d</b></div>
  </div><div class="dwell-list">${stageRows.map(s=>`<div class="dwell-row"><span>${s.label}</span><b>${s.count} shipments</b><em>${s.age}d avg dwell</em></div>`).join('')||'<p class="sub">No active stage data.</p>'}</div><p class="sub dwell-note">Note: dwell is currently approximated from dispatch age because historical stage timestamps are not available in source data yet. Once stage updates are used in CRM, this becomes exact.</p>`;
}
function actionReason(s){if(isDue(s))return{kind:'bad',short:'Today',title:'Follow-up due',body:`Due on ${s.followUp.dueDate}. Update remark after action.`};if(!s.controlPoc)return{kind:'purple',short:'Owner',title:'Assign owner',body:'Control POC is blank.'};if(s.paymentRisk==='overdue')return{kind:'bad',short:'Payment',title:'Payment follow-up',body:`${shortMoney(s.balance)} balance open.`};if(s.missingDocs.length)return{kind:'warn',short:'Docs',title:'Docs pending',body:`Pending: ${s.missingDocs.map(k=>state.docs[k]||k).slice(0,3).join(', ')}`};if(s.funnel==='qc')return{kind:'info',short:'QC/DN',title:'QC/DN closure',body:'QC or debit note closure required.'};if(s.paymentRisk==='partial')return{kind:'bad',short:'Partial',title:'Partial payment',body:`${shortMoney(s.balance)} balance open.`};return{kind:'info',short:'Track',title:'Track update',body:'Keep next action updated.'}}
function payMini(s,big){const paid=Math.max(0,Number(s.paidAmount||0));const bal=Math.max(0,Number(s.balance||0));let net=Number(s.netPayable||s.total||0);if(!(net>0))net=paid+bal;const pct=net>0?Math.max(0,Math.min(100,Math.round(paid/net*100))):(bal>0?0:100);const cls=s.paymentRisk==='overdue'?'over':s.paymentDerived==='paid'?'done':(s.paymentDerived==='partial'||s.paymentRisk==='partial')?'part':'pend';return`<div class="paymini ${cls}${big?' big':''}"><div class="pm-row"><span class="pm-paid">Paid ${shortMoney(paid)}</span><span class="pm-bal">Bal ${shortMoney(bal)}</span></div><div class="pm-bar"><span style="width:${pct}%"></span></div></div>`}
function stagePill(s){const cls=s.funnel==='completed'?'ok':s.funnel==='rejected'?'bad':s.funnel==='qc'?'info':'warn';return`<span class="pill ${cls}">${esc(s.stageLabel)}</span>`}function docPill(s){return(!s.requiredDocs.length||!s.missingDocs.length)?'<span class="pill ok">Docs clear</span>':`<span class="pill warn">${s.missingDocs.length} docs</span>`}function paymentPill(s){if(s.paymentDerived==='paid')return'<span class="pill ok">Paid</span>';if(s.paymentRisk==='overdue')return'<span class="pill bad">Overdue</span>';if(s.paymentDerived==='partial')return'<span class="pill warn">Partial</span>';return`<span class="pill info">${title(s.paymentDerived||'pending')}</span>`}
function eventHtml(e){let main=e.type==='doc'?`${state.docs[e.key]||e.key} → ${title(e.value)}`:`${title(e.type)} → ${esc(e.value)}`;if(e.type==='followup')main=e.status==='done'?'Follow-up done':`Follow-up set → ${esc(e.dueDate)}`;return`<div class="event"><div class="event-top"><span>${esc(e.actor||'User')}</span><span>${new Date(e.createdAt).toLocaleString()}</span></div><div class="event-main">${main}</div>${e.note?`<div class="event-note">${esc(e.note)}</div>`:''}</div>`}
async function saveStage(){await postUpdate({type:'stage',value:$('stageUpdate').value,note:reasonNote($('stageReason').value,$('stageNote').value)})}
async function saveOwner(){const value=$('ownerUpdate').value.trim();if(value)await postUpdate({type:'owner',value,note:'Owner updated'})}
async function saveNote(){const value=$('generalNote').value.trim();if(value)await postUpdate({type:'note',value,note:'Remark'})}
async function saveDoc(key,value){await postUpdate({type:'doc',key,value,note:`${state.docs[key]||key} status updated`})}
async function saveFollowup(){const done=$('followupStatus').value==='done';await postUpdate({type:'followup',value:done?'done':'scheduled',dueDate:done?today():$('followupDate').value,note:$('followupNote').value||(done?'Follow-up completed':''),status:done?'done':'open'})}async function postUpdate(payload){await api('/api/updates',{method:'POST',body:JSON.stringify({shipmentId:state.selectedId,actor:state.user.name,actorEmail:state.user.email,...payload})});const boot=await api('/api/bootstrap?user='+encodeURIComponent(state.user.email));state.shipments=boot.shipments;state.summary=boot.summary;await selectShipment(state.selectedId,false);renderAll();toast('Saved')}
function toast(msg){const el=document.createElement('div');el.className='toast';el.textContent=msg;$('toastWrap').appendChild(el);setTimeout(()=>el.remove(),1800)}
init().catch(e=>{document.body.innerHTML=`<pre style="padding:24px">${esc(e.message)}</pre>`});














