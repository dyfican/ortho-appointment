const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;

function check(name, fn) {
  try {
    if (fn() === false) throw new Error('returned false');
    console.log('  [OK] ' + name);
    pass++;
  } catch (e) {
    console.log('  [X]  ' + name + ' -- ' + e.message);
    fail++;
  }
}

console.log('');
console.log('=== pre-deploy check ===');
console.log('');

// 1. Required files
const FILES = ['index.html','admin.html','sw.js','manifest-patient.webmanifest','manifest-admin.webmanifest','icon-192.png','icon-512.png','package.json'];
FILES.forEach(f => check('file: ' + f, () => fs.existsSync(path.join(ROOT, f))));

// 2. Proxy syntax
check('proxy JS syntax', () => {
  execSync('node --check ' + JSON.stringify(path.join(ROOT, 'functions', 'api', 'sb', '[[path]].js')), {stdio:'pipe'});
  return true;
});

// 3. Patient-side key functions
const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
['submitBooking','checkPhotoReminder','openRegistration'].forEach(fn => check('index.html: ' + fn, () => idx.includes(fn)));

// 4. Admin-side key functions
const adm = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
['renderTodoBoard','markPhotoTaken','renderApptDayList','loadData'].forEach(fn => check('admin.html: ' + fn, () => adm.includes(fn)));

// 5. Iron rule: patient must not write completed
check('iron: index.html no status=completed write', () => {
  return !/status[\\s]*[:=][\\s]*['\'']completed/.test(idx);
});

// 6. package.json valid
check('package.json valid JSON', () => { JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')); return true; });

// 7. SW 自动更新机制在位（2026-08-29：根治"用户设备停留在旧版"事故）
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
check('sw.js CACHE 版本号格式', () => /const CACHE = 'ortho-shell-v\d+'/.test(sw));
check('两端 SW 自动更新注册', () => idx.includes('updateViaCache') && adm.includes('updateViaCache') && idx.includes('controllerchange') && adm.includes('controllerchange'));
// 软提醒：页面有改动但 sw.js 没动 => 可能忘 bump 版本号（老客户端不会自动更新）
// 覆盖两种场景：①工作区未提交改动 ②最近一次提交改了页面却没动 sw.js（部署链路工作区永远干净）
try {
  const dirty = execSync('git status --porcelain', { cwd: ROOT, stdio: 'pipe' }).toString();
  const lastCommit = execSync('git diff --name-only HEAD~1 HEAD', { cwd: ROOT, stdio: 'pipe' }).toString();
  const pageChanged = /index\.html|admin\.html/.test(dirty) || /index\.html|admin\.html/.test(lastCommit);
  const swChanged = /sw\.js/.test(dirty) || /sw\.js/.test(lastCommit);
  if (pageChanged && !swChanged) {
    console.log('  [!]  提醒：页面有改动但 sw.js 未 bump，老客户端不会自动更新');
  }
} catch (e) { /* git 不可用或提交数不足时忽略 */ }

// Summary
console.log('');
console.log('=== ' + pass + ' pass, ' + fail + ' fail ===');
console.log('');
process.exit(fail > 0 ? 1 : 0);
