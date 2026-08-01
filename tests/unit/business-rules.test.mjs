import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// 规则1：完成/待办判定（铁律）
function isDone(r){return(!!r.bonded||r.status==='completed')&&r.status!=='cancel';}
function isTodo(r){return !r.bonded&&r.status!=='completed'&&r.status!=='cancel';}
function isInTransit(r){return !!r.sent&&!r.received&&r.status!=='cancel';}

describe('完成/待办判定',()=>{
  test('bonded=true->done',()=>assert.equal(isDone({bonded:true,status:'pending'}),true));
  test('completed->done',()=>assert.equal(isDone({bonded:false,status:'completed'}),true));
  test('cancel不是done',()=>assert.equal(isDone({bonded:true,status:'cancel'}),false));
  test('pending未bonded->todo',()=>assert.equal(isTodo({bonded:false,status:'pending'}),true));
  test('bonded不是todo',()=>assert.equal(isTodo({bonded:true,status:'pending'}),false));
  test('completed不是todo',()=>assert.equal(isTodo({bonded:false,status:'completed'}),false));
  test('cancel不是todo',()=>assert.equal(isTodo({bonded:false,status:'cancel'}),false));
  test('sent未received->在途',()=>assert.equal(isInTransit({sent:true,received:false,status:'pending'}),true));
  test('received不在途',()=>assert.equal(isInTransit({sent:true,received:true,status:'pending'}),false));
  test('cancel不在途',()=>assert.equal(isInTransit({sent:true,received:false,status:'cancel'}),false));
  test('铁律:患者提交后仍待办',()=>{const r={bonded:false,status:'pending'};assert.equal(isTodo(r),true);assert.equal(isDone(r),false);});
});
// 规则2：防重复预约（2026-08-01最终版）
function shouldBlock(existing,today){
  return existing.some(a=>a.date>today&&!['cancel','done','noshow'].includes(a.status));
}

describe('防重复预约',()=>{
  const T='2026-08-01';
  test('未来booked->拦截',()=>assert.equal(shouldBlock([{date:'2026-08-05',status:'booked'}],T),true));
  test('今天booked->放行',()=>assert.equal(shouldBlock([{date:'2026-08-01',status:'booked'}],T),false));
  test('过去booked->放行',()=>assert.equal(shouldBlock([{date:'2026-07-20',status:'booked'}],T),false));
  test('cancel->放行',()=>assert.equal(shouldBlock([{date:'2026-08-10',status:'cancel'}],T),false));
  test('done->放行',()=>assert.equal(shouldBlock([{date:'2026-08-10',status:'done'}],T),false));
  test('noshow->放行',()=>assert.equal(shouldBlock([{date:'2026-08-10',status:'noshow'}],T),false));
  test('混合:过期+未来active->拦截',()=>assert.equal(shouldBlock([{date:'2026-07-01',status:'booked'},{date:'2026-08-15',status:'booked'}],T),true));
  test('空->放行',()=>assert.equal(shouldBlock([],T),false));
});

// 规则3：复诊问题标记互斥
function computeIssueTags(selected){
  const specific=selected.filter(i=>i!=='正常复诊');
  return specific.length===0?'正常复诊':specific.join(',');
}

describe('复诊问题互斥',()=>{
  test('无选择->正常复诊',()=>assert.equal(computeIssueTags([]),'正常复诊'));
  test('选具体问题->不含正常',()=>assert.equal(computeIssueTags(['牙套脱落']),'牙套脱落'));
  test('多个->逗号拼接',()=>assert.equal(computeIssueTags(['牙套脱落','种植支抗植入']),'牙套脱落,种植支抗植入'));
  test('混选->只保留具体',()=>assert.equal(computeIssueTags(['正常复诊','钢丝滑动']),'钢丝滑动'));
});

// 规则4：拍照提醒（>90天）
function needsPhoto(last,now){
  if(!last)return false;
  return(now.getTime()-new Date(last).getTime())>90*24*3600*1000;
}

describe('拍照提醒',()=>{
  const NOW=new Date('2026-08-01T10:00:00Z');
  test('无记录->不提醒',()=>assert.equal(needsPhoto(null,NOW),false));
  test('89天->不提醒',()=>assert.equal(needsPhoto('2026-05-04T10:00:00Z',NOW),false));
  test('91天->提醒',()=>assert.equal(needsPhoto('2026-05-02T10:00:00Z',NOW),true));
  test('刚好90天->不提醒',()=>assert.equal(needsPhoto('2026-05-03T10:00:00Z',NOW),false));
});