import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStatus } from '../src/services/attendance.service.js';
import { annualTax, salaryParts } from '../src/services/payroll.service.js';
import { roll } from '../src/services/analytics.service.js';

const settings = { officeStart: '09:00', graceMinutes: 15, halfDayHours: 5 };
const at = (hhmm) => new Date(`2026-10-26T${hhmm}:00+05:00`);
const c = (i, o, today = '2026-10-26') => computeStatus({ checkIn: at(i), checkOut: o ? at(o) : null, date: '2026-10-26', settings, tz: 'Asia/Karachi', today });

test('attendance: 09:15 is on time, 09:16 is late', () => {
  assert.equal(c('09:15', '18:00').status, 'present');
  assert.equal(c('09:16', '18:00').status, 'late');
});
test('attendance: under 5 hours = half_day', () => assert.equal(c('09:00', '13:30').status, 'half_day'));
test('attendance: no checkout on a past day = missing_checkout', () => assert.equal(c('09:00', null, '2026-10-27').status, 'missing_checkout'));

test('payroll: gross = 1.5 x basic', () => assert.equal(salaryParts(100000).gross, 150000));
test('payroll: tax slabs', () => {
  assert.equal(annualTax(600000), 0);
  assert.equal(annualTax(1200000), 30000);
  assert.equal(annualTax(2400000), 210000);
  assert.equal(annualTax(4000000), 510000 + 400000 * 0.35);
});

test('analytics: attendance rate excludes on_leave, counts half day as 0.5', () => {
  const x = roll([{ present: 8, late: 1, half: 2, missing: 0, onLeave: 5, absent: 1 }]);
  assert.equal(x.attendanceRate, 83.3); // (8+1+0.5*2) / (11 records + 1 absent)
  assert.equal(x.latePct, 11.1);      // 1 / (8+1)
});
