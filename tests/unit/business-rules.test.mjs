import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDone, isTodo, isInTransit, shouldBlockDuplicate, computeIssueTags, needsPhotoReminder, encodePatientLink, decodePatientLink, isValidCard, slotCutoffReason, AM_CUTOFF_HOUR, PM_CUTOFF_HOUR, TOMORROW_AM_CUTOFF_HOUR, LONG_OP_LABELS, LONG_OP_MINUTES, advisoryLevel, isLongOp } from '../../src/rules.mjs';

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

describe('防重复预约',()=>{
  const T='2026-08-01';
  test('未来booked->拦截',()=>assert.equal(shouldBlockDuplicate([{date:'2026-08-05',status:'booked'}],T),true));
  test('今天booked->放行',()=>assert.equal(shouldBlockDuplicate([{date:'2026-08-01',status:'booked'}],T),false));
  test('过去booked->放行',()=>assert.equal(shouldBlockDuplicate([{date:'2026-07-20',status:'booked'}],T),false));
  test('cancel->放行',()=>assert.equal(shouldBlockDuplicate([{date:'2026-08-10',status:'cancel'}],T),false));
  test('done->放行',()=>assert.equal(shouldBlockDuplicate([{date:'2026-08-10',status:'done'}],T),false));
  test('noshow->放行',()=>assert.equal(shouldBlockDuplicate([{date:'2026-08-10',status:'noshow'}],T),false));
  test('混合:过期+未来active->拦截',()=>assert.equal(shouldBlockDuplicate([{date:'2026-07-01',status:'booked'},{date:'2026-08-15',status:'booked'}],T),true));
  test('空->放行',()=>assert.equal(shouldBlockDuplicate([],T),false));
});

describe('复诊问题互斥',()=>{
  test('无选择->正常复诊',()=>assert.equal(computeIssueTags([]),'正常复诊'));
  test('选具体问题->不含正常',()=>assert.equal(computeIssueTags(['牙套脱落']),'牙套脱落'));
  test('多个->逗号拼接',()=>assert.equal(computeIssueTags(['牙套脱落','种植支抗植入']),'牙套脱落,种植支抗植入'));
  test('混选->只保留具体',()=>assert.equal(computeIssueTags(['正常复诊','钢丝滑动']),'钢丝滑动'));
});

describe('拍照提醒',()=>{
  const NOW=new Date('2026-08-01T10:00:00Z');
  test('无记录->不提醒',()=>assert.equal(needsPhotoReminder(null,NOW),false));
  test('89天->不提醒',()=>assert.equal(needsPhotoReminder('2026-05-04T10:00:00Z',NOW),false));
  test('91天->提醒',()=>assert.equal(needsPhotoReminder('2026-05-02T10:00:00Z',NOW),true));
  test('刚好90天->不提醒',()=>assert.equal(needsPhotoReminder('2026-05-03T10:00:00Z',NOW),false));
});

describe('专属预约链接',()=>{
  test('编码解码往返',()=>{
    const s=encodePatientLink('张三','131123456789012','25');
    const d=decodePatientLink(s);
    assert.equal(d.n,'张三');
    assert.equal(d.c,'131123456789012');
    assert.equal(d.a,'25');
  });
  test('链接字符串URL安全(无+/=)',()=>{
    const s=encodePatientLink('测试患者','131999999999999','8');
    assert.equal(/[+/=]/.test(s),false);
  });
  test('非法字符串->null',()=>assert.equal(decodePatientLink('!!!garbage!!!'),null));
  test('缺卡号->null',()=>{
    const s=btoa(unescape(encodeURIComponent(JSON.stringify({n:'x'})))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    assert.equal(decodePatientLink(s),null);
  });
});

describe('链接解码安全',()=>{
  test('姓名非字符串->规范化为空串',()=>{
    const s=encodePatientLink(123,'131123456789012','25');
    const d=decodePatientLink(s);
    assert.equal(d.n,'');
    assert.equal(d.c,'131123456789012');
  });
  test('卡号非字符串->null',()=>{
    const j=JSON.stringify({n:'x',c:12345});
    const s=btoa(unescape(encodeURIComponent(j))).replace(/[+]/g,'-').replace(/[/]/g,'_').replace(/=+$/,'');
    assert.equal(decodePatientLink(s),null);
  });
});

describe('卡号校验(13或H开头共15位)',()=>{
  test('135开头15位->通过(新开放的号段)',()=>assert.equal(isValidCard('135123456789012'),true));
  test('131开头15位->仍通过',()=>assert.equal(isValidCard('131123456789012'),true));
  test('13开头含字母->拒绝',()=>assert.equal(isValidCard('13A123456789012'),false));
  test('H00开头15位->通过(原格式仍可用)',()=>assert.equal(isValidCard('H00ABC123456789'),true));
  test('H开头纯数字15位->通过',()=>assert.equal(isValidCard('H12345678901234'),true));
  test('小写h开头15位->通过',()=>assert.equal(isValidCard('habcdef12345678'),true));
  test('H开头只有14位->拒绝',()=>assert.equal(isValidCard('H00ABC12345678'),false));
  test('14开头15位->拒绝',()=>assert.equal(isValidCard('145123456789012'),false));
  test('13开头14位->拒绝',()=>assert.equal(isValidCard('13512345678901'),false));
  test('13开头16位->拒绝',()=>assert.equal(isValidCard('1351234567890123'),false));
  test('H开头含符号->拒绝',()=>assert.equal(isValidCard('H00ABC12345678!'),false));
  test('空/null->拒绝',()=>{assert.equal(isValidCard(''),false);assert.equal(isValidCard(null),false);});
});

describe('挂号截止(当日上午11:00/下午16:00)',()=>{
  const now=(h,m)=>new Date(2026,7,29,h,m||0,0,0);
  const D=(d)=>new Date(2026,7,d,0,0,0,0);
  test('10:30约当日上午->可约',()=>assert.equal(slotCutoffReason(D(29),'am',now(10,30)),null));
  test('11:00整约当日上午->截止',()=>assert.ok(slotCutoffReason(D(29),'am',now(11,0))));
  test('12:30约当日上午->截止(患者误操作案例)',()=>assert.ok(slotCutoffReason(D(29),'am',now(12,30))));
  test('14:00约当日上午->截止(患者误操作案例)',()=>assert.ok(slotCutoffReason(D(29),'am',now(14))));
  test('15:30约当日下午->可约',()=>assert.equal(slotCutoffReason(D(29),'pm',now(15,30)),null));
  test('16:00整约当日下午->截止',()=>assert.ok(slotCutoffReason(D(29),'pm',now(16))));
  test('10:30约明日上午->可约',()=>assert.equal(slotCutoffReason(D(30),'am',now(10,30)),null));
  test('17:30约明日上午->不可约(原17点规则保留)',()=>assert.ok(slotCutoffReason(D(30),'am',now(17,30))));
  test('17:30约明日下午->可约',()=>assert.equal(slotCutoffReason(D(30),'pm',now(17,30)),null));
  test('17:30约后天上午->可约',()=>assert.equal(slotCutoffReason(D(31),'am',now(17,30)),null));
  test('11:30约后天->不受当日截止影响',()=>assert.equal(slotCutoffReason(D(31),'am',now(11,30)),null));
});

// 页面里内联了一份规则副本（纯静态页无法 import）。抠出页面函数与 src/rules.mjs 逐例比对，防改漏。
// 铁律：取数和断言必须写在 test() 里——describe 回调体抛错时 node:test 依旧 "# fail 0" 且退出码 0，
//       会静默退化成"0 个用例全绿"。
function extractPageBlock(src, head) {
  const i = src.indexOf(head);
  if (i < 0) throw new Error('页面里找不到 ' + head);
  const start = src.indexOf('{', i);
  let d = 0;
  for (let k = start; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error(head + ' 花括号不配对');
}
const extractPageFn = (src, name) => extractPageBlock(src, 'function ' + name + '(');
const pageTitle = () => readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const adminText = () => readFileSync(new URL('../../admin.html', import.meta.url), 'utf8');

function pageConstants() {
  const html = pageTitle();
  const num = n => { const m = html.match(new RegExp('const ' + n + '\\s*=\\s*(\\d+)')); if (!m) throw new Error('缺常量 ' + n); return Number(m[1]); };
  const arr = n => { const m = html.match(new RegExp('const ' + n + ' = \\[([^\\]]*)\\]')); if (!m) throw new Error('缺常量 ' + n);
    return m[1].split(',').map(x => x.trim()).filter(Boolean).map(x => x.replace(/^['\x22]|['\x22]$/g, '')); };
  const objKeys = n => { const m = html.match(new RegExp('const ' + n + ' = \\{([\\s\\S]*?)\\n    \\}')); if (!m) throw new Error('缺常量 ' + n);
    return [...m[1].matchAll(/'([^']+)'\s*:/g)].map(x => x[1]); };
  const tip = html.match(/const CROWD_QUIET_TIP/);
  if (tip) throw new Error('CROWD_QUIET_TIP 已废弃，应改用可点日期按钮');
  return { am: num('AM_CUTOFF_HOUR'), pm: num('PM_CUTOFF_HOUR'), tm: num('TOMORROW_AM_CUTOFF_HOUR'),
    minutes: num('LONG_OP_MINUTES'), longOps: arr('LONG_OPS'),
    peak: objKeys('CROWD_PEAK'), quiet: objKeys('CROWD_QUIET') };
}

function pageSlotFn() {
  const c = pageConstants();
  const html = pageTitle();
  return new Function('AM_CUTOFF_HOUR', 'PM_CUTOFF_HOUR', 'TOMORROW_AM_CUTOFF_HOUR',
    extractPageFn(html, 'slotCutoffReason') + '; return slotCutoffReason;')(c.am, c.pm, c.tm);
}
function pageCardFn() { return new Function(extractPageFn(pageTitle(), 'isValidCard') + '; return isValidCard;')(); }
function pageAdvisoryFn() { return new Function(extractPageFn(pageTitle(), 'advisoryLevel') + '; return advisoryLevel;')(); }
function pageIsLongFn() { return new Function('LONG_OPS', extractPageFn(pageTitle(), 'isLongOp') + '; return isLongOp;')(pageConstants().longOps); }
function pageMergeFn(vp) { return new Function('visitPurpose', extractPageFn(pageTitle(), 'mergePurposeIntoTags') + '; return mergePurposeIntoTags;')(vp); }
// 医生端卡号内联在提交逻辑里；抠出的表达式本身就是"合法"判定，不能再取反
function adminCardValid() {
  const m = adminText().match(/if \(!\((.+?)\)\) \{ showToast\('自费卡号格式有误/);
  if (!m) throw new Error('医生端卡号校验语句结构变了，测试需同步更新');
  return new Function('card', 'return (' + m[1] + ');');
}

const DRIFT_CARDS = ['131123456789012','135123456789012','145123456789012','13A123456789012',
  'H00ABC123456789','H12345678901234','habcdef12345678','H00ABC12345678',
  '13512345678901','1351234567890123','', null];
const dnow = (h, m) => new Date(2026, 7, 29, h, m || 0, 0, 0);
const dday = (d) => new Date(2026, 7, d, 0, 0, 0, 0);

describe('页面副本与规则层一致性',()=>{
  test('地基：页面常量与函数都抠得出来',()=>{
    const c = pageConstants();
    assert.equal(typeof pageSlotFn(), 'function');
    assert.equal(typeof pageCardFn(), 'function');
    assert.equal(typeof pageAdvisoryFn(), 'function');
    assert.ok(c.peak.length && c.quiet.length && c.longOps.length);
  });
  test('截止小时数与长操作时长两端一致',()=>{
    const c = pageConstants();
    assert.equal(c.am, AM_CUTOFF_HOUR);
    assert.equal(c.pm, PM_CUTOFF_HOUR);
    assert.equal(c.tm, TOMORROW_AM_CUTOFF_HOUR);
    assert.equal(c.minutes, LONG_OP_MINUTES);
  });
  test('医生端卡号校验行为与规则层一致',()=>{
    const ok = adminCardValid();
    assert.equal(ok('131123456789012'), true, '取反逻辑可疑：合法卡被判为不合法');
    for (const c of DRIFT_CARDS) assert.equal(ok(c), isValidCard(c), '医生端卡号判定不一致: ' + JSON.stringify(c));
  });
  for (const c of DRIFT_CARDS) {
    test('卡号 ' + JSON.stringify(c) + ' 两端一致', () => {
      assert.equal(pageCardFn()(c), isValidCard(c));
    });
  }
  for (const d of [29, 30, 31]) {
    for (const s of ['am', 'pm']) {
      for (const t of [[9,0],[10,30],[11,0],[12,30],[14,0],[15,30],[16,0],[17,30]]) {
        test(d + '日' + s + ' @' + t[0] + ':' + String(t[1]).padStart(2,'0') + ' 两端一致', () => {
          const p = pageSlotFn();
          assert.equal(p(dday(d), s, dnow(t[0], t[1])), slotCutoffReason(dday(d), s, dnow(t[0], t[1])));
        });
      }
    }
  }
});

describe('这次要做与建议槽',()=>{
  const STATES = [
    [{ cutoff: true,  longOp: true,  peak: true,  }, 'block'],
    [{ cutoff: true,  longOp: false, peak: false, }, 'block'],
    [{ cutoff: false, longOp: true,  peak: true,  }, 'warm'],
    [{ cutoff: false, longOp: true,  peak: false, }, 'good'],
    [{ cutoff: false, longOp: false, peak: true,  }, 'warm'],
    [{ cutoff: false, longOp: false, peak: false, }, 'none'],
  ];
  for (const [st, want] of STATES) {
    test('优先级 ' + JSON.stringify(st) + ' => ' + want, () => {
      assert.equal(advisoryLevel(st), want);
      assert.equal(pageAdvisoryFn()(st), want, '页面与规则层优先级不一致');
    });
  }
  test('长操作名单一致，初诊不算长操作', () => {
    assert.deepEqual(pageConstants().longOps, LONG_OP_LABELS);
    assert.equal(pageIsLongFn()('拆托槽'), true);
    assert.equal(pageIsLongFn()('粘接托槽'), true);
    assert.equal(pageIsLongFn()('隐形首次佩戴'), true);
    assert.equal(pageIsLongFn()('初诊'), false, '段医生明确：初诊不算长操作，不该催他改期');
    assert.equal(pageIsLongFn()('常规复诊'), false);
    assert.equal(isLongOp('初诊'), false);
  });
  test('高峰与冷门场次不重叠', () => {
    const c = pageConstants();
    assert.deepEqual(c.peak.slice().sort(), ['4am', '5pm', '6am']);
    assert.deepEqual(c.quiet.slice().sort(), ['2am', '2pm', '4pm', '5am']);
    assert.equal(c.peak.filter(k => c.quiet.indexOf(k) >= 0).length, 0);
  });
  test('提示只有一个槽，旧的两条提示已彻底移除', () => {
    const html = pageTitle();
    assert.ok(html.includes('id="advisoryBar"'), '缺建议槽');
    for (const gone of ['crowdNote', 'deadlineWarning', 'warnTexts', 'CROWD_QUIET_TIP']) {
      assert.equal(html.indexOf(gone), -1, '旧提示残留：' + gone);
    }
    assert.equal(html.split('renderAdvisory(date, ds);').length - 1, 1, '选日期处应恰好调用一次建议槽');
  });
  test('长操作改期提示自带可点的冷门日期，不是只劝一句', () => {
    const body = extractPageFn(pageTitle(), 'renderAdvisory');
    const html = pageTitle();
    assert.ok(body.includes('quietDayHTML()'), 'P1 没接出路');
    assert.ok(html.includes('class="advisory " + level') || html.includes("bar.className = 'advisory ' + level"), '颜色没跟随优先级');
    assert.ok(html.includes('function quietDayChoices(limitN)') && html.includes('pickQuietDay'), '冷门日期不可点');
    assert.ok(html.includes('getSlotCount(d, c[0]) >= c[2]'), '冷门日期没排除已满的');
  });
  test('混合日（上午忙下午空）当场给改选半天，不自相矛盾', () => {
    const html = pageTitle();
    const qmap = {}; pageConstants().quiet.forEach(k => { qmap[k] = 1; });
    const alt = new Function('CROWD_QUIET', extractPageFn(html, 'quietSlotLabels') + '; return quietSlotLabels;')(qmap);
    // 周四：上午高峰、下午清闲 => 应给出"下午"
    assert.deepEqual(alt({ getDay: () => 4 }, { am: { enabled: true }, pm: { enabled: true } }), ['下午']);
    // 周六：只有上午忙，没有空闲半天 => 只能推别的日期
    assert.deepEqual(alt({ getDay: () => 6 }, { am: { enabled: true }, pm: { enabled: true } }), []);
    // 停诊的半天不算出路
    assert.deepEqual(alt({ getDay: () => 4 }, { am: { enabled: true }, pm: { enabled: false } }), []);
    const body = extractPageFn(html, 'renderAdvisory');
    assert.ok(body.includes('建议挑'), '长操作遇混合日没给改选半天');
    assert.ok(body.includes('可以挑那个时段'), '普通提醒遇混合日没给改选半天');
    assert.ok(body.includes('peak.slice(-2)'), '没说清是这天的上午还是下午忙');
  });
  test('文案利他不吓人：无绝对人数、无到院时刻、无威胁措辞', () => {
    const body = extractPageFn(pageTitle(), 'renderAdvisory');
    assert.ok(!/\d+\s*人/.test(body), '文案出现绝对人数（系统外客流未入表，必然低估）');
    assert.ok(!/\d{1,2}:\d{2}/.test(body), '文案出现具体到院时刻');
    assert.ok(!/看不完|被压缩|请勿|禁止/.test(body), '出现训斥/威胁式措辞');
    assert.ok(body.includes('医生能做得更精细') && body.includes('做得从容'), '未用段医生定稿的利他措辞');
    assert.ok(body.includes('带本读物和零食'), '高峰场次缺了那句人情味提醒');
    assert.ok(body.includes('到院后再取号') || pageTitle().includes('到院后再取号'), '缺取号引导');
  });
  test('长操作会带给医生端（进 issue_tags）', () => {
    assert.equal(pageMergeFn('')('正常复诊'), '正常复诊');
    assert.equal(pageMergeFn('常规复诊')('正常复诊'), '正常复诊', '常规复诊不该污染标签');
    assert.equal(pageMergeFn('初诊')('正常复诊'), '正常复诊', '初诊不是长操作，不该进标签');
    assert.equal(pageMergeFn('拆托槽')('正常复诊'), '拆托槽');
    assert.equal(pageMergeFn('拆托槽')('钢丝滑动'), '钢丝滑动,拆托槽');
    assert.equal(pageMergeFn('拆托槽')('钢丝滑动,拆托槽'), '钢丝滑动,拆托槽', '重复叠加会出现两个同样标签');
  });
});

