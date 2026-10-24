import { z } from 'zod';
import AiLog from '../models/AiLog.js';
import LeaveType from '../models/LeaveType.js';
import Employee from '../models/Employee.js';
import Department from '../models/Department.js';
import * as an from './analytics.service.js';
import { getBalance, countWorkingDays } from './leave.service.js';
import { getContext } from './attendance.service.js';
import { todayIn, weekdayOf } from '../utils/time.js';
import { HttpError } from '../utils/httpError.js';

const BASE = process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1'; // koi bhi OpenAI-compatible provider
const MODEL = process.env.AI_MODEL || 'llama-3.3-70b-versatile';
const TIMEOUT_MS = 15000, HOURLY_LIMIT = 20;
const FRIENDLY = 'AI assistant abhi available nahi hai. Thori der baad try karein ya normal screens use karein.';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const POLICY = `COMPANY POLICY (answer policy questions ONLY from these rules; otherwise say you do not know):
- Office start 09:00, grace 15 minutes (late after 09:15), half day if worked under 5 hours, weekend Saturday-Sunday (company settings may change this).
- One attendance record per employee per day; the server stamps the time. No check-out = missing_checkout. No record and no approved leave = absent.
- Leave quotas per year: annual 14, sick 8, casual 10, unpaid unlimited. Only working days count (weekends and public holidays are skipped). Overlapping requests or requests over balance are rejected. HR approves or rejects leave.
- Payroll: gross = 1.5 x basic (HRA 40%, medical 10%). Per day = gross / working days. Deduct absent days + unpaid leave days + 0.5 x half days. Joiners/leavers are prorated. Annual tax slab on gross x 12: up to 600k = 0; 5% to 1.2M; 30k + 15% to 2.4M; 210k + 25% to 3.6M; 510k + 35% above. HR drafts payroll, only Admin finalizes (locks) it.`;

/* ---------- LLM call (key sirf server par) ---------- */
async function llm(messages, { tools, json, deadline }) {
  if (!process.env.AI_API_KEY) throw new HttpError(503, 'AI is not configured on the server (AI_API_KEY missing). Use the normal screens.');
  const left = deadline - Date.now();
  if (left < 500) throw new Error('timeout');
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', signal: AbortSignal.timeout(left),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AI_API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.1, ...(tools ? { tools, tool_choice: 'auto' } : {}), ...(json ? { response_format: { type: 'json_object' } } : {}) }),
  });
  if (!res.ok) throw new Error(`AI provider error ${res.status}`);
  const msg = (await res.json()).choices?.[0]?.message;
  if (!msg) throw new Error('Empty AI response');
  return msg;
}

/* ---------- Rate limit + logging ---------- */
async function guardRate(user) {
  const n = await AiLog.countDocuments({ user: user._id, createdAt: { $gte: new Date(Date.now() - 36e5) } });
  if (n >= HOURLY_LIMIT) throw new HttpError(429, `AI limit reached (${HOURLY_LIMIT} requests per hour). Please try again later.`);
}
// Har call: limit check -> kaam -> log. Fail par friendly message.
async function run(user, kind, input, fn) {
  await guardRate(user);
  const t0 = Date.now(); const tools = [];
  try {
    const out = await fn(tools);
    await AiLog.create({ user: user._id, role: user.role, kind, input: String(input).slice(0, 500), output: JSON.stringify(out).slice(0, 1500), tools, ms: Date.now() - t0 });
    return { ...out, label: 'AI-generated' };
  } catch (e) {
    await AiLog.create({ user: user._id, role: user.role, kind, input: String(input).slice(0, 500), tools, ok: false, error: e.message, ms: Date.now() - t0 }).catch(() => {});
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, kind === 'smart_leave' ? 'AI could not read that. Please fill the leave form manually.' : FRIENDLY);
  }
}

/* ---------- Tools: wahi services jo REST API use karti hai, user ke scope ke saath ---------- */
const isStaff = (u) => ['admin', 'hr'].includes(u.role);
const dateArgs = { from: { type: 'string', description: 'YYYY-MM-DD, default first day of this month' }, to: { type: 'string', description: 'YYYY-MM-DD, default today' } };
const fn = (name, description, properties = {}) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties } } });
const TOOLS = [
  fn('get_headcount', 'Number of active employees (optionally for one department).', { department: { type: 'string', description: 'department name' } }),
  fn('get_attendance_summary', 'Attendance totals and attendance rate / late % / absenteeism % for a date range.', { ...dateArgs, department: { type: 'string' } }),
  fn('get_late_comers', 'Employees ranked by number of late days in a date range.', { ...dateArgs, department: { type: 'string' }, limit: { type: 'number' } }),
  fn('get_leave_summary', 'Who is on leave on a date (default today), approved leave days by type, pending requests.', { date: { type: 'string', description: 'YYYY-MM-DD, default today' }, ...dateArgs, department: { type: 'string' } }),
  fn('get_my_leave_balance', "The current user's own leave balance (quota, used, pending, remaining) for this year."),
  fn('get_payroll_summary', 'Payroll run totals for a month (YYYY-MM, default latest). Employees get only their own payslip.', { month: { type: 'string' } }),
  fn('search_employees', 'Search employees by name/code/email, optionally by department. Admin/HR only.', { query: { type: 'string' }, department: { type: 'string' } }),
];
const DENIED = { error: 'This is not available for your role. Tell the user politely that you cannot share it.' };

async function execTool(user, name, a) {
  const staff = isStaff(user); const own = user.employeeId ? [String(user.employeeId)] : [];
  const scope = staff ? {} : { employeeIds: own };
  switch (name) {
    case 'get_headcount': return staff ? an.headcount({ department: a.department }) : DENIED;
    case 'get_attendance_summary': return an.attendanceSummary({ from: a.from, to: a.to, department: staff ? a.department : undefined, ...scope });
    case 'get_late_comers': return an.lateComers({ from: a.from, to: a.to, department: staff ? a.department : undefined, limit: Math.min(+a.limit || 5, 20), ...scope });
    case 'get_leave_summary': return an.leaveSummary({ date: a.date, from: a.from, to: a.to, department: staff ? a.department : undefined, ...scope });
    case 'get_my_leave_balance': {
      if (!user.employeeId) return { error: 'No employee profile linked to this login' };
      const { tz } = await getContext();
      return (await getBalance(user.employeeId, todayIn(tz).slice(0, 4))).map(b => ({ type: b.leaveType.name, quota: b.quota, used: b.used, pending: b.pending, remaining: b.remaining }));
    }
    case 'get_payroll_summary':
      if (staff) return an.payrollSummary({ month: a.month });
      return user.employeeId ? an.myPayslip(user.employeeId, a.month) : DENIED;
    case 'search_employees': {
      if (!staff) return DENIED;
      const f = {}; if (a.department) f.department = await an.resolveDepartment(a.department);
      if (a.query) { const rx = new RegExp(String(a.query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); f.$or = [{ name: rx }, { code: rx }, { email: rx }]; }
      const list = await Employee.find(f).limit(10).populate('department', 'name').populate('designation', 'name').lean();
      return list.map(e => ({ code: e.code, name: e.name, email: e.email, department: e.department?.name, designation: e.designation?.name, status: e.status, joinDate: e.joinDate, basicSalary: e.basicSalary }));
    }
    default: return { error: `Unknown tool ${name}` };
  }
}

async function systemPrompt(user) {
  const { tz } = await getContext(); const today = todayIn(tz);
  return `You are the HCM Lite assistant for ${user.name} (role: ${user.role}). Today is ${today} (${DAYS[weekdayOf(today)]}), timezone ${tz}.
RULES:
- Answer data questions ONLY from tool results. Never guess or invent numbers. If a tool errors or has no data, say so.
- The user may write English, Urdu or Roman Urdu / Hinglish: reply in the same language, briefly.
- Role scope: ${user.role === 'employee' ? 'this user is an Employee and may only see their OWN data and company policy. If they ask about another person\'s salary, attendance, leave or any company-wide numbers, politely refuse.' : user.role === 'hr' ? 'this user is HR: people-operations data only. Company settings, audit log and admin-only data are not available.' : 'this user is Admin: all company data.'}
- You never create, change or approve anything; you only explain.
- Use YYYY-MM-DD dates in tool calls. For "this month" use the defaults.
${POLICY}`;
}

const chatBody = z.object({ message: z.string().trim().min(1).max(500), history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(1500) })).max(10).default([]) });

export function chat(user, body) {
  const { message, history } = chatBody.parse(body);
  return run(user, 'chat', message, async (usedTools) => {
    const deadline = Date.now() + TIMEOUT_MS;
    const messages = [{ role: 'system', content: await systemPrompt(user) }, ...history.slice(-6), { role: 'user', content: message }];
    for (let i = 0; i < 4; i++) {
      const m = await llm(messages, { tools: TOOLS, deadline });
      if (!m.tool_calls?.length) return { answer: (m.content || '').trim() || 'Mujhe iska jawab nahi mila.', tools: usedTools };
      messages.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
      for (const c of m.tool_calls) {
        let result;
        try { result = await execTool(user, c.function.name, JSON.parse(c.function.arguments || '{}')); }
        catch (e) { result = { error: e.message }; }
        usedTools.push(c.function.name);
        messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result).slice(0, 6000) });
      }
    }
    throw new Error('Too many tool rounds');
  });
}

/* ---------- Dashboard summary: sirf server ke KPI numbers se ---------- */
export function summarize(user, filters) {
  return run(user, 'summary', JSON.stringify(filters), async () => {
    const kpi = await an.companyDashboard(filters);
    if (user.role === 'admin') kpi.admin = await an.adminExtras(filters);
    const m = await llm([
      { role: 'system', content: 'You write dashboard insights for an HR team. Use ONLY the numbers in the JSON. Output 3 to 5 short bullet points starting with "- ". No invented numbers, no advice beyond the data. If a value is 0 or empty, say there is not enough data.' },
      { role: 'user', content: JSON.stringify(kpi).slice(0, 12000) }], { deadline: Date.now() + TIMEOUT_MS });
    return { summary: (m.content || '').trim(), filters: kpi.filters };
  });
}

/* ---------- Smart leave: sentence -> validated JSON -> pre-filled form (kuch save nahi hota) ---------- */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(d => !Number.isNaN(Date.parse(d)));
export function smartLeave(user, text) {
  const input = z.string().trim().min(3).max(300).parse(text);
  if (!user.employeeId) throw new HttpError(403, 'No employee profile linked to this login');
  return run(user, 'smart_leave', input, async () => {
    const types = await LeaveType.find().lean();
    if (!types.length) throw new HttpError(422, 'No leave types are set up yet');
    const { tz } = await getContext(); const today = todayIn(tz);
    const cal = Array.from({ length: 21 }, (_, i) => { const d = an.addDays(today, i); return `${d} ${DAYS[weekdayOf(d)]}`; }).join('\n');
    const codes = types.map(t => t.code);
    const schema = z.object({ type: z.enum(codes), start: isoDate, end: isoDate, reason: z.string().trim().min(3).max(300) }).refine(v => v.end >= v.start && v.start >= today, 'bad dates');
    const sys = `Convert the employee's leave request into JSON {"type","start","end","reason"}. Today is ${today} (${DAYS[weekdayOf(today)]}).
type must be one of: ${types.map(t => `${t.code} (${t.name})`).join(', ')}. Pick sick for illness, casual for personal/family events (weddings), annual for vacation/travel, unpaid only if they say unpaid.
Dates are YYYY-MM-DD, start <= end, never in the past. Use this calendar (date weekday) to resolve relative days:
${cal}
"next <weekday>" = the first such weekday after today. "kal" = tomorrow, "parso" = day after tomorrow, "agle hafte" = next week. Roman Urdu is possible ("kal", "parso", "agle hafte"). reason = short English phrase from the text. Return ONLY JSON.`;
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      const deadline = Date.now() + TIMEOUT_MS;
      const m = await llm([{ role: 'system', content: sys }, { role: 'user', content: input }], { json: true, deadline });
      try {
        const v = schema.parse(JSON.parse((m.content || '').match(/\{[\s\S]*\}/)?.[0] || ''));
        const t = types.find(x => x.code === v.type);
        const days = await countWorkingDays(v.start, v.end).catch(() => null);
        return { form: { leaveType: String(t._id), startDate: v.start, endDate: v.end, reason: v.reason }, typeName: t.name, days };
      } catch (e) { last = e; }
    }
    throw new HttpError(422, 'AI could not read that. Please fill the leave form manually.');
  });
}
