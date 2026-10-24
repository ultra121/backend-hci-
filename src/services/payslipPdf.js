import PDFDocument from 'pdfkit';

const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function sendPayslipPdf(res, { slip, run, company }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const safe = String(slip.employeeCode).replace(/[^\w-]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="payslip-${safe}-${slip.month}.pdf"`);
  doc.pipe(res);

  doc.fontSize(20).text(company, { align: 'center' });
  doc.fontSize(13).fillColor('#444').text(`Payslip for ${slip.month}`, { align: 'center' });
  if (run.status !== 'finalized') doc.fillColor('#dc2626').fontSize(11).text('DRAFT - not final', { align: 'center' });
  doc.fillColor('black').moveDown();

  const line = (a, b, bold = false) => {
    const y = doc.y; doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(11);
    doc.text(a, 60, y, { width: 280 }); doc.text(b, 340, y, { width: 200, align: 'right' }); doc.moveDown(0.4);
  };
  const head = (t) => { doc.moveDown(0.6).font('Helvetica-Bold').fontSize(12).fillColor('#0f9d8a').text(t, 50); doc.fillColor('black').moveDown(0.3); };

  head('Employee');
  line('Name', slip.employeeName); line('Employee code', slip.employeeCode);
  line('Department', slip.department || '-'); line('Designation', slip.designation || '-'); line('Joining date', slip.joinDate);

  head('Earnings');
  line('Basic salary', money(slip.basic)); line('House rent allowance (40%)', money(slip.hra));
  line('Medical allowance (10%)', money(slip.medical)); line('Monthly gross', money(slip.gross), true);
  line(`Earned gross (${slip.employedDays} of ${slip.workingDays} working days)`, money(slip.earned));

  head('Attendance summary');
  line('Working days in month', String(slip.workingDays)); line('Absent days', String(slip.absentDays));
  line('Unpaid leave days', String(slip.unpaidDays)); line('Half days', String(slip.halfDays));
  line('Deductible days', String(slip.deductionDays)); line('Per day rate', money(slip.perDay));

  head('Deductions');
  line('Absence / unpaid / half-day deduction', money(slip.deduction)); line('Income tax', money(slip.tax));

  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(14);
  const y = doc.y; doc.text('NET PAY', 60, y); doc.text(money(slip.net), 340, y, { width: 200, align: 'right' });
  doc.moveDown(2).font('Helvetica').fontSize(9).fillColor('#64748b').text('Computer generated payslip. Tax slab is illustrative.', 50, doc.y, { align: 'center', width: 495 });
  doc.end();
}
