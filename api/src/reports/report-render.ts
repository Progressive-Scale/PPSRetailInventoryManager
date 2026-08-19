import PDFDocument from 'pdfkit';
import {
  AnyReport,
  DetailReport,
  ReportMeta,
  SummaryReport,
} from './dto/reports.dto';

/**
 * Turning a report into something you can file or hand to somebody.
 *
 * Both formats read the SAME objects the JSON endpoint returns, so the screen, the
 * PDF and the spreadsheet cannot disagree about a total. That was the point of
 * computing rows and totals in the service rather than while drawing.
 *
 * pdfkit, deliberately, not a headless browser: this is a page of tables, and
 * Chromium is a few hundred megabytes and a process lifecycle to babysit inside a
 * single Railway service. The cost of pdfkit is doing the column layout by hand.
 */

const isSummary = (r: AnyReport): r is SummaryReport =>
  (r as SummaryReport).rows !== undefined;

// ---- shared formatting ---------------------------------------------------

function money(n: number | null): string {
  if (n == null) return '';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function qty(n: number | null, dp = 2): string {
  if (n == null) return '';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/** A dash, not a zero. Nothing was measured; that is different from measuring nothing. */
const DASH = '—';

function dateOnly(iso: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

/** Header lines shared by both formats, so the two never describe different scopes. */
function scopeLines(meta: ReportMeta): string[] {
  const lines = [meta.companyName];
  lines.push(`Store: ${meta.storeName ?? 'All stores'}`);
  if (meta.locationName) lines.push(`Location: ${meta.locationName}`);
  if (meta.from && meta.to) lines.push(`Sold between ${meta.from} and ${meta.to}`);
  return lines;
}

// ---- CSV ----------------------------------------------------------------

/**
 * One flat row per line, because a spreadsheet is for sorting and summing — the
 * grouped, indented shape that reads well on paper is exactly what makes a CSV
 * awkward to pivot. The product columns repeat on every row for that reason.
 */
function csvCell(v: string | number | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  // Quote if it could otherwise break the row, and double any embedded quote.
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(',');
}

export function toCsv(report: AnyReport): string {
  const meta = report.meta;
  const out: string[] = [];

  // A bare grid would lose which store, which cooler, and when — the reader opens
  // this weeks later with no idea what it covers.
  out.push(csvRow([meta.title]));
  for (const l of scopeLines(meta)) out.push(csvRow([l]));
  out.push(csvRow([`Generated ${meta.generatedAt}`]));
  out.push('');

  if (isSummary(report)) {
    out.push(
      csvRow([
        'SKU',
        'Product',
        'Tracking',
        'Weight (lb)',
        'Cases',
        'Pieces',
        'Avg weight (lb)',
        'Avg $/lb',
        'Value',
      ]),
    );
    for (const r of report.rows) {
      out.push(
        csvRow([
          r.sku,
          r.name,
          r.trackingType,
          r.weightLbs,
          r.cases,
          r.pieces,
          r.avgWeightLbs,
          r.avgPricePerLb,
          r.value,
        ]),
      );
    }
    out.push('');
    out.push(
      csvRow([
        'TOTAL',
        '',
        '',
        report.totals.weightLbs,
        report.totals.cases,
        report.totals.pieces,
        '',
        '',
        report.totals.value,
      ]),
    );
  } else {
    const d = report as DetailReport;
    const soldReport = meta.kind === 'SOLD';
    out.push(
      csvRow([
        'SKU',
        'Product',
        'Serial',
        'Case serial',
        'Weight (lb)',
        'Location',
        soldReport ? 'Sold' : 'Received',
        '$/lb',
        'Value',
      ]),
    );
    for (const g of d.groups) {
      for (const u of g.units) {
        out.push(
          csvRow([
            g.sku,
            g.name,
            u.serial,
            u.caseSerial,
            u.weightLbs,
            u.locationName,
            dateOnly(soldReport ? u.soldAt : u.receivedAt),
            u.pricePerLb,
            u.value,
          ]),
        );
      }
      // Subtotal inline, labelled, so a filter on the SKU column still shows it.
      out.push(
        csvRow([
          g.sku,
          `${g.name} — subtotal`,
          '',
          '',
          g.subtotal.weightLbs,
          '',
          '',
          '',
          g.subtotal.value,
        ]),
      );
    }
    out.push('');
    out.push(
      csvRow([
        'TOTAL',
        '',
        '',
        '',
        d.totals.weightLbs,
        '',
        '',
        '',
        d.totals.value,
      ]),
    );
  }

  // CRLF: these get opened in Excel on Windows, which is the whole point of the format.
  return out.join('\r\n') + '\r\n';
}

// ---- PDF ----------------------------------------------------------------

interface Col {
  label: string;
  width: number;
  align?: 'left' | 'right';
}

const MARGIN = 36;
const PAGE_WIDTH = 792; // Letter, landscape — these tables do not fit portrait.
const PAGE_HEIGHT = 612;
const BODY_BOTTOM = PAGE_HEIGHT - MARGIN - 24; // room for the footer

const SUMMARY_COLS: Col[] = [
  { label: 'SKU', width: 110 },
  { label: 'Product', width: 210 },
  { label: 'Weight (lb)', width: 80, align: 'right' },
  { label: 'Cases', width: 50, align: 'right' },
  { label: 'Pieces', width: 50, align: 'right' },
  { label: 'Avg wt', width: 60, align: 'right' },
  { label: 'Avg $/lb', width: 60, align: 'right' },
  { label: 'Value', width: 90, align: 'right' },
];

const DETAIL_COLS: Col[] = [
  { label: 'Serial', width: 140 },
  { label: 'Case', width: 110 },
  { label: 'Weight (lb)', width: 75, align: 'right' },
  { label: 'Location', width: 150 },
  { label: 'Date', width: 75 },
  { label: '$/lb', width: 60, align: 'right' },
  { label: 'Value', width: 90, align: 'right' },
];

export function toPdf(report: AnyReport): Promise<Buffer> {
  const doc = new PDFDocument({
    size: [PAGE_WIDTH, PAGE_HEIGHT],
    margin: MARGIN,
    // bufferPages is what makes "Page 1 of 4" possible: the total is unknown until
    // the last row is drawn, so the footers are written in a second pass at the end.
    bufferPages: true,
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const meta = report.meta;
  const cols = isSummary(report) ? SUMMARY_COLS : DETAIL_COLS;

  const drawHeader = () => {
    doc.font('Helvetica-Bold').fontSize(14).text(meta.title, MARGIN, MARGIN);
    doc.font('Helvetica').fontSize(9);
    const right = `Print Date  ${dateOnly(meta.generatedAt)}`;
    doc.text(right, PAGE_WIDTH - MARGIN - 150, MARGIN + 2, {
      width: 150,
      align: 'right',
    });
    let y = MARGIN + 20;
    for (const l of scopeLines(meta)) {
      doc.text(l, MARGIN, y);
      y += 12;
    }
    return y + 6;
  };

  const drawColumnHeads = (y: number) => {
    doc.font('Helvetica-Bold').fontSize(8);
    let x = MARGIN;
    for (const c of cols) {
      doc.text(c.label, x, y, { width: c.width, align: c.align ?? 'left' });
      x += c.width;
    }
    const bottom = y + 12;
    doc
      .moveTo(MARGIN, bottom)
      .lineTo(PAGE_WIDTH - MARGIN, bottom)
      .lineWidth(0.5)
      .stroke();
    doc.font('Helvetica').fontSize(8);
    return bottom + 4;
  };

  const row = (y: number, cells: string[], bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    let x = MARGIN;
    cells.forEach((cell, i) => {
      const c = cols[i];
      doc.text(cell, x, y, {
        width: c.width - 4,
        align: c.align ?? 'left',
        lineBreak: false,
        ellipsis: true,
      });
      x += c.width;
    });
    return y + 12;
  };

  let y = drawHeader();
  y = drawColumnHeads(y);

  /** Start a new page when the next line would cross the footer. */
  const ensure = (needed: number) => {
    if (y + needed <= BODY_BOTTOM) return;
    doc.addPage();
    y = drawHeader();
    y = drawColumnHeads(y);
  };

  if (isSummary(report)) {
    for (const r of report.rows) {
      ensure(14);
      y = row(y, [
        r.sku,
        r.name,
        r.weightLbs == null ? DASH : qty(r.weightLbs),
        r.cases == null ? DASH : String(r.cases),
        String(r.pieces),
        r.avgWeightLbs == null ? DASH : qty(r.avgWeightLbs),
        r.avgPricePerLb == null ? DASH : money(r.avgPricePerLb),
        money(r.value),
      ]);
    }
    ensure(26);
    y += 4;
    doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y).stroke();
    y += 4;
    y = row(
      y,
      [
        'TOTAL',
        '',
        report.totals.weightLbs == null ? DASH : qty(report.totals.weightLbs),
        String(report.totals.cases),
        String(report.totals.pieces),
        '',
        '',
        money(report.totals.value),
      ],
      true,
    );
  } else {
    const d = report as DetailReport;
    const soldReport = meta.kind === 'SOLD';
    for (const g of d.groups) {
      // Keep a product's heading with at least its first row, so a group never
      // starts as a lone title at the bottom of a page.
      ensure(40);
      doc.font('Helvetica-Bold').fontSize(9);
      doc.text(`${g.sku} — ${g.name}`, MARGIN, y, {
        width: PAGE_WIDTH - MARGIN * 2,
        lineBreak: false,
        ellipsis: true,
      });
      y += 14;

      for (const u of g.units) {
        ensure(14);
        y = row(y, [
          u.serial,
          u.caseSerial ?? '',
          u.weightLbs == null ? DASH : qty(u.weightLbs),
          u.locationName ?? '',
          dateOnly(soldReport ? u.soldAt : u.receivedAt),
          u.pricePerLb == null ? DASH : money(u.pricePerLb),
          money(u.value),
        ]);
      }

      ensure(16);
      y = row(
        y,
        [
          `${g.subtotal.pieces} piece(s)`,
          '',
          g.subtotal.weightLbs == null ? DASH : qty(g.subtotal.weightLbs),
          '',
          '',
          '',
          money(g.subtotal.value),
        ],
        true,
      );
      y += 6;
    }
    ensure(26);
    doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y).stroke();
    y += 4;
    y = row(
      y,
      [
        `TOTAL — ${d.totals.pieces} piece(s)`,
        '',
        d.totals.weightLbs == null ? DASH : qty(d.totals.weightLbs),
        '',
        '',
        '',
        money(d.totals.value),
      ],
      true,
    );
  }

  // Second pass for the footers, now that the page count is known.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.font('Helvetica').fontSize(8);
    doc.text(
      `${meta.companyName} — ${meta.title}`,
      MARGIN,
      PAGE_HEIGHT - MARGIN - 10,
      { width: 400 },
    );
    doc.text(
      `Page ${i + 1} of ${range.count}`,
      PAGE_WIDTH - MARGIN - 150,
      PAGE_HEIGHT - MARGIN - 10,
      { width: 150, align: 'right' },
    );
  }

  doc.end();
  return done;
}

/** `inventory-summary-2026-08-19.pdf` — sorts by date and says what it is. */
export function fileName(report: AnyReport, ext: 'pdf' | 'csv'): string {
  const slug = report.meta.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `${slug}-${dateOnly(report.meta.generatedAt)}.${ext}`;
}
