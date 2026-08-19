import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Observable } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { messageFor } from '../../core/http-error';
import {
  DetailReport,
  StoreLocation,
  ReportFilters,
  ReportKind,
  Store,
  SummaryReport,
} from '../../core/models';

type AnyReport = SummaryReport | DetailReport;

const KINDS: { kind: ReportKind; label: string }[] = [
  { kind: 'SUMMARY', label: 'Inventory Summary With Value' },
  { kind: 'DETAIL', label: 'Inventory Detail With Value' },
  { kind: 'SOLD', label: 'Items Sold' },
];

/**
 * Reporting.
 *
 * Not in the store user's nav — the route guard and the API both refuse them too, so
 * hiding the tab is a courtesy rather than the control.
 *
 * The screen shows the SAME numbers the PDF and CSV carry, because all three come
 * from one call to the same endpoint. Print uses the browser's own dialog against a
 * print stylesheet; there is no second layout to keep in step.
 */
@Component({
  selector: 'app-reports',
  imports: [DatePipe, FormsModule],
  template: `
    <main class="container">
      <section class="card">
        <h2>Reports</h2>

        <div class="filters no-print">
          <label class="f">
            Report
            <select name="rp-kind" [ngModel]="kind()" (ngModelChange)="setKind($event)">
              @for (k of kinds; track k.kind) {
                <option [ngValue]="k.kind">{{ k.label }}</option>
              }
            </select>
          </label>

          @if (isCompanyAdmin) {
            <label class="f">
              Store
              <select name="rp-store" [ngModel]="storeId()" (ngModelChange)="setStore($event)">
                <option [ngValue]="null">All stores</option>
                @for (s of stores(); track s.id) {
                  <option [ngValue]="s.id">{{ s.name }}</option>
                }
              </select>
            </label>
          }

          <label class="f">
            Location
            <select
              name="rp-location"
              [ngModel]="locationId()"
              (ngModelChange)="locationId.set($event)"
            >
              <option [ngValue]="null">All locations</option>
              @for (l of locations(); track l.id) {
                <option [ngValue]="l.id">{{ l.name }}</option>
              }
            </select>
          </label>

          <!-- Only the sold report is bounded by dates, so the inputs appear with it
               rather than sitting empty and unexplained on the other two. -->
          @if (kind() === 'SOLD') {
            <label class="f">
              From
              <input type="date" name="rp-from" [(ngModel)]="fromDate" />
            </label>
            <label class="f">
              To
              <input type="date" name="rp-to" [(ngModel)]="toDate" />
            </label>
          }

          <div class="f-actions">
            <button type="button" (click)="run()" [disabled]="loading()">
              {{ loading() ? 'Running…' : 'Run' }}
            </button>
            <button type="button" class="ghost" (click)="clear()">Clear</button>
          </div>

          <!-- Right-aligned: these act on a report that already exists, so they are
               disabled until one does. -->
          <div class="f-actions right">
            <button type="button" class="ghost" (click)="print()" [disabled]="!report()">
              Print
            </button>
            <button
              type="button"
              class="ghost"
              (click)="download('pdf')"
              [disabled]="!report() || busy()"
            >
              PDF
            </button>
            <button
              type="button"
              class="ghost"
              (click)="download('csv')"
              [disabled]="!report() || busy()"
            >
              CSV
            </button>
            <button type="button" class="ghost" (click)="openEmail()" [disabled]="!report()">
              Email
            </button>
          </div>
        </div>

        @if (error()) {
          <p class="error no-print">{{ error() }}</p>
        }
        @if (notice()) {
          <p class="notice no-print">{{ notice() }}</p>
        }

        @if (report(); as r) {
          <div class="report-head">
            <h3>{{ r.meta.title }}</h3>
            <div class="scope">
              <span>{{ r.meta.companyName }}</span>
              <span>Store: {{ r.meta.storeName ?? 'All stores' }}</span>
              @if (r.meta.locationName) {
                <span>Location: {{ r.meta.locationName }}</span>
              }
              @if (r.meta.from && r.meta.to) {
                <span>Sold {{ r.meta.from }} → {{ r.meta.to }}</span>
              }
              <span>Print date: {{ r.meta.generatedAt | date: 'mediumDate' }}</span>
            </div>
          </div>

          @if (summary(); as s) {
            @if (s.rows.length === 0) {
              <p class="muted">Nothing on hand for that scope.</p>
            } @else {
              <div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Product</th>
                      <th class="num">Weight (lb)</th>
                      <th class="num">Cases</th>
                      <th class="num">Pieces</th>
                      <th class="num">Avg wt</th>
                      <th class="num">Avg $/lb</th>
                      <th class="num">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of s.rows; track row.productId + row.trackingType) {
                      <tr>
                        <td>{{ row.sku }}</td>
                        <td>
                          {{ row.name }}
                          @if (row.trackingType === 'QUANTITY') {
                            <span class="tag">shelf</span>
                          }
                        </td>
                        <td class="num">{{ num(row.weightLbs) }}</td>
                        <td class="num">{{ row.cases ?? '—' }}</td>
                        <td class="num">{{ row.pieces }}</td>
                        <td class="num">{{ num(row.avgWeightLbs) }}</td>
                        <td class="num">{{ money(row.avgPricePerLb) }}</td>
                        <td class="num">{{ money(row.value) }}</td>
                      </tr>
                    }
                  </tbody>
                  <tfoot>
                    <tr>
                      <th colspan="2">Total</th>
                      <th class="num">{{ num(s.totals.weightLbs) }}</th>
                      <th class="num">{{ s.totals.cases }}</th>
                      <th class="num">{{ s.totals.pieces }}</th>
                      <th></th>
                      <th></th>
                      <th class="num">{{ money(s.totals.value) }}</th>
                    </tr>
                  </tfoot>
                </table>
              </div>
            }
          }

          @if (detail(); as d) {
            @if (d.groups.length === 0) {
              <p class="muted">
                {{
                  kind() === 'SOLD'
                    ? 'Nothing sold in that range.'
                    : 'Nothing on hand for that scope.'
                }}
              </p>
            } @else {
              @for (g of d.groups; track g.productId) {
                <div class="group">
                  <h4>{{ g.sku }} — {{ g.name }}</h4>
                  <div class="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Serial</th>
                          <th>Case</th>
                          <th class="num">Weight (lb)</th>
                          <th>Location</th>
                          <th>{{ kind() === 'SOLD' ? 'Sold' : 'Received' }}</th>
                          <th class="num">$/lb</th>
                          <th class="num">Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (u of g.units; track u.serial) {
                          <tr>
                            <td>{{ u.serial }}</td>
                            <td class="muted">{{ u.caseSerial ?? '—' }}</td>
                            <td class="num">{{ num(u.weightLbs) }}</td>
                            <td class="muted">{{ u.locationName ?? '—' }}</td>
                            <td class="muted">
                              {{
                                (kind() === 'SOLD' ? u.soldAt : u.receivedAt)
                                  | date: 'mediumDate'
                              }}
                            </td>
                            <td class="num">{{ money(u.pricePerLb) }}</td>
                            <td class="num">{{ money(u.value) }}</td>
                          </tr>
                        }
                      </tbody>
                      <tfoot>
                        <tr>
                          <th colspan="2">{{ g.subtotal.pieces }} piece(s)</th>
                          <th class="num">{{ num(g.subtotal.weightLbs) }}</th>
                          <th colspan="3"></th>
                          <th class="num">{{ money(g.subtotal.value) }}</th>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              }
              <div class="grand">
                <span>Total — {{ d.totals.pieces }} piece(s)</span>
                <span>{{ num(d.totals.weightLbs) }} lb</span>
                <span>{{ money(d.totals.value) }}</span>
              </div>
            }
          }
        } @else if (!loading()) {
          <p class="muted">Choose a report and press Run.</p>
        }
      </section>

      @if (emailOpen()) {
        <div class="overlay no-print" (click)="closeEmail()">
          <div class="modal" (click)="$event.stopPropagation()">
            <h3>Email this report</h3>
            <label class="field">
              Recipients
              <input
                type="text"
                name="rp-to"
                placeholder="owner@example.com, accountant@example.com"
                [(ngModel)]="recipientsRaw"
              />
              <small class="muted">Separate several with commas. Up to ten.</small>
            </label>
            <fieldset class="formats">
              <legend>Attach</legend>
              <label><input type="checkbox" [(ngModel)]="wantPdf" name="rp-pdf" /> PDF</label>
              <label><input type="checkbox" [(ngModel)]="wantCsv" name="rp-csv" /> CSV</label>
            </fieldset>
            <label class="field">
              Note (optional)
              <textarea name="rp-msg" rows="3" [(ngModel)]="emailMessage"></textarea>
            </label>
            @if (emailError()) {
              <p class="error">{{ emailError() }}</p>
            }
            <div class="modal-actions">
              <button type="button" class="ghost" (click)="closeEmail()">Cancel</button>
              <button type="button" (click)="send()" [disabled]="sending()">
                {{ sending() ? 'Sending…' : 'Send' }}
              </button>
            </div>
          </div>
        </div>
      }
    </main>
  `,
  styles: [
    `
      .container {
        max-width: 1100px;
        margin: 0 auto;
        padding: 1rem;
      }
      .card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 1rem 1.25rem;
      }
      h2 {
        margin: 0 0 0.85rem;
        font-size: 1.05rem;
      }
      input,
      select,
      textarea {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
        font-family: inherit;
      }
      .filters {
        display: flex;
        align-items: flex-end;
        gap: 0.75rem;
        flex-wrap: wrap;
        margin: 0.85rem 0 1rem;
      }
      .f {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        font-size: 0.75rem;
        color: var(--muted);
      }
      .f-actions {
        display: flex;
        gap: 0.4rem;
      }
      .f-actions.right {
        margin-left: auto;
      }
      .filters input,
      .filters select,
      .filters .f-actions button {
        height: 2.25rem;
        box-sizing: border-box;
      }
      .filters .f-actions button {
        padding: 0 0.75rem;
        font-size: 0.85rem;
        font-family: inherit;
        border-radius: 8px;
      }
      .report-head {
        margin: 0 0 0.75rem;
      }
      .report-head h3 {
        margin: 0 0 0.25rem;
        font-size: 1rem;
      }
      .scope {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        font-size: 0.8rem;
        color: var(--muted);
      }
      .group {
        margin: 0 0 1rem;
      }
      .group h4 {
        margin: 0 0 0.35rem;
        font-size: 0.9rem;
      }
      .table-scroll {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.9rem;
      }
      th,
      td {
        text-align: left;
        padding: 0.45rem 0.5rem;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      th {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted);
      }
      tfoot th {
        text-transform: none;
        font-size: 0.85rem;
        color: var(--text);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .muted {
        color: var(--muted);
      }
      .tag {
        margin-left: 0.35rem;
        padding: 0.05rem 0.35rem;
        border: 1px solid var(--border);
        border-radius: 999px;
        font-size: 0.7rem;
        color: var(--muted);
      }
      .grand {
        display: flex;
        gap: 1.5rem;
        justify-content: flex-end;
        padding: 0.5rem 0.5rem 0;
        font-weight: 600;
        font-size: 0.9rem;
      }
      .error {
        color: #b42318;
        font-size: 0.85rem;
      }
      .notice {
        color: var(--accent);
        font-size: 0.85rem;
      }
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(17, 24, 39, 0.45);
        display: grid;
        place-items: center;
        padding: 1rem;
      }
      .modal {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 1.25rem;
        width: min(460px, 100%);
      }
      .modal h3 {
        margin: 0 0 0.75rem;
        font-size: 1rem;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        margin: 0 0 0.75rem;
        font-size: 0.8rem;
        color: var(--muted);
      }
      .formats {
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.5rem 0.75rem;
        margin: 0 0 0.75rem;
        font-size: 0.85rem;
      }
      .formats legend {
        font-size: 0.75rem;
        color: var(--muted);
      }
      .formats label {
        margin-right: 1rem;
      }
      .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
      }

      /* Print: the report and nothing else. Filters, buttons and the shell are
         chrome for choosing a report, not part of it. */
      @media print {
        .no-print {
          display: none !important;
        }
        .container {
          max-width: none;
          padding: 0;
        }
        .card {
          border: 0;
          padding: 0;
        }
        .table-scroll {
          overflow: visible;
        }
        /* Never split a product's block across a page if it fits on one. */
        .group {
          break-inside: avoid;
        }
        thead {
          display: table-header-group;
        }
      }
    `,
  ],
})
export class ReportsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  readonly kinds = KINDS;
  readonly isCompanyAdmin = this.auth.isCompanyAdmin();

  readonly kind = signal<ReportKind>('SUMMARY');
  readonly storeId = signal<number | null>(null);
  readonly locationId = signal<number | null>(null);
  fromDate = '';
  toDate = '';

  readonly stores = signal<Store[]>([]);
  readonly locations = signal<StoreLocation[]>([]);

  readonly report = signal<AnyReport | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  // Narrowing for the template: one of these is non-null, never both.
  readonly summary = computed<SummaryReport | null>(() => {
    const r = this.report();
    return r && 'rows' in r ? r : null;
  });
  readonly detail = computed<DetailReport | null>(() => {
    const r = this.report();
    return r && 'groups' in r ? r : null;
  });

  readonly emailOpen = signal(false);
  readonly sending = signal(false);
  readonly emailError = signal<string | null>(null);
  recipientsRaw = '';
  emailMessage = '';
  wantPdf = true;
  wantCsv = true;

  ngOnInit(): void {
    if (this.isCompanyAdmin) {
      this.api.listStores().subscribe({
        next: (s) => this.stores.set(s),
        error: () => this.stores.set([]),
      });
    }
    this.loadLocations();
  }

  private filters(): ReportFilters {
    const f: ReportFilters = {};
    if (this.storeId() != null) f.storeId = this.storeId()!;
    if (this.locationId() != null) f.locationId = this.locationId()!;
    if (this.kind() === 'SOLD') {
      if (this.fromDate) f.from = this.fromDate;
      if (this.toDate) f.to = this.toDate;
    }
    return f;
  }

  setKind(k: ReportKind): void {
    this.kind.set(k);
    // The old rows describe a different report; leaving them on screen under a new
    // title is the kind of thing people print by mistake.
    this.report.set(null);
    this.notice.set(null);
    this.error.set(null);
  }

  setStore(id: number | null): void {
    this.storeId.set(id);
    this.locationId.set(null);
    this.report.set(null);
    this.loadLocations();
  }

  private loadLocations(): void {
    this.api.listLocations(this.storeId() ?? undefined).subscribe({
      next: (l) => this.locations.set(l.filter((x) => x.isActive)),
      error: () => this.locations.set([]),
    });
  }

  clear(): void {
    this.storeId.set(null);
    this.locationId.set(null);
    this.fromDate = '';
    this.toDate = '';
    this.report.set(null);
    this.error.set(null);
    this.notice.set(null);
    this.loadLocations();
  }

  run(): void {
    if (this.kind() === 'SOLD' && (!this.fromDate || !this.toDate)) {
      this.error.set('Items Sold needs both a From and a To date.');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.notice.set(null);
    const f = this.filters();
    // Typed as one Observable: a union of Observable<Summary> | Observable<Detail>
    // has two incompatible subscribe overloads and cannot be called.
    const call: Observable<AnyReport> =
      this.kind() === 'SUMMARY'
        ? this.api.inventorySummaryReport(f)
        : this.kind() === 'DETAIL'
          ? this.api.inventoryDetailReport(f)
          : this.api.itemsSoldReport(f);
    call.subscribe({
      next: (r) => {
        this.report.set(r);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(messageFor(e));
        this.report.set(null);
        this.loading.set(false);
      },
    });
  }

  print(): void {
    window.print();
  }

  /**
   * Fetch the file and save it under the name the server chose.
   *
   * Not a plain link: every API call carries a bearer token that a navigation
   * cannot, so the bytes are fetched and then handed to a temporary anchor.
   */
  download(format: 'pdf' | 'csv'): void {
    this.busy.set(true);
    this.error.set(null);
    this.api.downloadReport(this.kind(), this.filters(), format).subscribe({
      next: (res) => {
        const blob = res.body;
        if (!blob) {
          this.error.set('The server returned an empty file.');
          this.busy.set(false);
          return;
        }
        const disp = res.headers.get('Content-Disposition') ?? '';
        const match = /filename="([^"]+)"/.exec(disp);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = match?.[1] ?? `report.${format}`;
        a.click();
        // Revoked on the next tick: released immediately, Safari can cancel the save.
        setTimeout(() => URL.revokeObjectURL(url), 0);
        this.busy.set(false);
      },
      error: (e) => {
        this.error.set(messageFor(e));
        this.busy.set(false);
      },
    });
  }

  openEmail(): void {
    this.emailError.set(null);
    this.emailOpen.set(true);
  }

  closeEmail(): void {
    this.emailOpen.set(false);
  }

  send(): void {
    const recipients = this.recipientsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (recipients.length === 0) {
      this.emailError.set('Enter at least one email address.');
      return;
    }
    const formats: ('pdf' | 'csv')[] = [];
    if (this.wantPdf) formats.push('pdf');
    if (this.wantCsv) formats.push('csv');
    if (formats.length === 0) {
      this.emailError.set('Attach at least one of PDF or CSV.');
      return;
    }

    this.sending.set(true);
    this.emailError.set(null);
    this.api
      .emailReport({
        kind: this.kind(),
        recipients,
        formats,
        message: this.emailMessage.trim() || undefined,
        ...this.filters(),
      })
      .subscribe({
        next: (res) => {
          this.sending.set(false);
          if (!res.ok) {
            // The server answers 200 with ok:false so the reason can be shown here
            // rather than as a failed request.
            this.emailError.set(res.error ?? 'The email could not be sent.');
            return;
          }
          this.emailOpen.set(false);
          this.recipientsRaw = '';
          this.emailMessage = '';
          this.notice.set(
            `Sent to ${recipients.join(', ')} — ${res.attached.join(', ')}`,
          );
        },
        error: (e) => {
          this.sending.set(false);
          this.emailError.set(messageFor(e));
        },
      });
  }

  /** A dash where nothing was measured, matching the PDF and the CSV. */
  num(n: number | null): string {
    if (n == null) return '—';
    return n.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  money(n: number | null): string {
    if (n == null) return '—';
    return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
  }
}
