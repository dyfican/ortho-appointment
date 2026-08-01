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

// Summary
console.log('');
console.log('=== ' + pass + ' pass, ' + fail + ' fail ===');
console.log('');
process.exit(fail > 0 ? 1 : 0);
