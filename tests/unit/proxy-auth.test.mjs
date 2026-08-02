import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkAuth, staffCanAccess, filterStaffFields, STAFF_READ_TABLES, STAFF_ALLOWED_COLUMNS } from '../../src/proxy-rules.mjs';

const ENV={ADMIN_KEY:'test-admin-key',STAFF_KEY:'test-staff-key'};

describe('代理鉴权',()=>{
  test('无key->401',()=>{const{isAdmin,isStaff}=checkAuth({},ENV);assert.equal(isAdmin,false);assert.equal(isStaff,false);});
  test('错误key->401',()=>{const{isAdmin}=checkAuth({'x-admin-key':'wrong'},ENV);assert.equal(isAdmin,false);});
  test('正确admin->通过',()=>{const{isAdmin}=checkAuth({'x-admin-key':'test-admin-key'},ENV);assert.equal(isAdmin,true);});
  test('正确staff->通过',()=>{const{isStaff}=checkAuth({'x-staff-key':'test-staff-key'},ENV);assert.equal(isStaff,true);});
});

describe('staff权限限制',()=>{
  test('GET appointments->允许',()=>assert.equal(staffCanAccess('GET','appointments'),true));
  test('GET checklists->允许',()=>assert.equal(staffCanAccess('GET','checklists'),true));
  test('GET patient_notices->拒绝',()=>assert.equal(staffCanAccess('GET','patient_notices'),false));
  test('PATCH checklists->允许',()=>assert.equal(staffCanAccess('PATCH','checklists'),true));
  test('PATCH appointments->拒绝',()=>assert.equal(staffCanAccess('PATCH','appointments'),false));
  test('POST任何表->拒绝',()=>assert.equal(staffCanAccess('POST','appointments'),false));
  test('DELETE任何表->拒绝',()=>assert.equal(staffCanAccess('DELETE','checklists'),false));
  test('PUT任何表->拒绝',()=>assert.equal(staffCanAccess('PUT','checklists'),false));
});

describe('staff字段白名单',()=>{
  test('只保留允许字段',()=>{
    const body={workflow_stage:'done',patient_card:'123',bonded:true,appointment_id:99};
    const cleaned=filterStaffFields(body);
    assert.deepEqual(cleaned,{workflow_stage:'done',bonded:true});
    assert.equal('patient_card' in cleaned,false);
    assert.equal('appointment_id' in cleaned,false);
  });
  test('空body->空结果',()=>assert.deepEqual(filterStaffFields({}),{}));
  test('全允许字段->全保留',()=>{
    const body={workflow_stage:'x',sent:true,received:false,bonded:false,status:'pending'};
    assert.deepEqual(filterStaffFields(body),body);
  });
});
