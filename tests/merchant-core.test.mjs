import test from "node:test";
import assert from "node:assert/strict";
import { emptyMerchantDb, handleMerchantAction } from "../merchant-core.mjs";

const admin = { id: "admin", username: "admin", role: "admin" };
const employee = { id: "employee", username: "employee", role: "employee" };

test("merchant imports deduplicate phones and exports are audited for employees", () => {
  const db = emptyMerchantDb();
  let sequence = 0;
  const run = (path, method, user = admin, body = {}) => handleMerchantAction(db, {
    path, method, user, body, uid: (prefix) => `${prefix}_${++sequence}`,
    now: () => "2026-10-13T08:00:00.000Z"
  });

  assert.equal(run("/api/merchant/industries", "POST", admin, { name: "汽修" }).status, 201);
  const industryId = db.industries[0].id;
  assert.throws(() => run("/api/merchant/industries", "GET", employee), { status: 403 });
  assert.throws(() => run("/api/merchant/imports", "POST", employee, { items: [] }), { status: 403 });

  const first = run("/api/merchant/imports", "POST", admin, { items: [{
    fileName: "first.xlsx", province: "四川省", city: "成都市", industryId, invalidRows: 1,
    records: [
      { name: "甲", phone: "+86 13800000000", address: "四川省成都市一号" },
      { name: "乙", phone: "13800000000", address: "四川省成都市二号" },
      { name: "丙", phone: "13900000000", address: "四川省成都市三号" }
    ]
  }] });
  assert.equal(first.data.results[0].importedRows, 2);
  assert.equal(first.data.results[0].duplicateRows, 1);
  assert.equal(first.data.results[0].invalidRows, 1);
  assert.equal(run("/api/merchant/overview", "GET", employee).data.totalRecords, 2);

  const filters = { province: "四川省", city: "成都市", industryId };
  const exported = run("/api/merchant/export", "POST", employee, { filters });
  assert.equal(exported.data.rows.length, 2);
  assert.equal(exported.data.record.username, "employee");
  assert.equal(exported.audit.action, "merchant_export");
  assert.equal(run("/api/merchant/exports", "GET", employee).data.exportRecords.length, 1);
  assert.throws(() => run(`/api/merchant/industries/${industryId}`, "DELETE"), /已有导入记录/);

  assert.throws(() => run(`/api/merchant/imports/${db.imports[0].id}`, "DELETE", employee), { status: 403 });
  const removed = run(`/api/merchant/imports/${db.imports[0].id}`, "DELETE");
  assert.equal(removed.data.deletedRows, 2);
  assert.equal(run("/api/merchant/overview", "GET", employee).data.totalRecords, 0);
});
