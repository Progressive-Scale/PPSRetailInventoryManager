import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import { Store, StoreLocation } from '../../core/models';

type SortField = 'name' | 'kind' | 'active';

@Component({
  selector: 'app-locations',
  imports: [FormsModule],
  template: `
    <section class="card">
      <div class="section-head">
        <h2>Locations</h2>
        <div class="head-controls">
          @if (isCompanyAdmin && stores().length > 1) {
            <label class="inline">
              Store
              <select [ngModel]="storeId()" (ngModelChange)="onStore($event)" name="loc-store">
                @for (s of stores(); track s.id) {
                  <option [ngValue]="s.id">{{ s.name }}</option>
                }
              </select>
            </label>
          }
          @if (isCompanyAdmin) {
            <button (click)="openAdd()" [disabled]="storeId() == null">Add location</button>
          }
          <button (click)="reload()" class="ghost" [disabled]="loading()">Refresh</button>
        </div>
      </div>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else {
        <div class="table-scroll" [class.busy]="saving()">
          <table>
            <thead>
              <tr>
                <th class="sortable col-name" (click)="sort('name')">Name<span class="arrow">{{ icon('name') }}</span></th>
                <th class="sortable col-type" (click)="sort('kind')">Type<span class="arrow">{{ icon('kind') }}</span></th>
                <th class="sortable col-status" (click)="sort('active')">Status<span class="arrow">{{ icon('active') }}</span></th>
                @if (isCompanyAdmin) {
                  <th class="actions col-actions"></th>
                }
              </tr>
            </thead>
            <tbody>
              @for (loc of displayLocations(); track loc.id) {
                <tr>
                  <td class="name-cell">
                    @if (editId() === loc.id) {
                      <input class="cell-input" name="edit-name" [(ngModel)]="editName" />
                      @if (loc.kind !== 'CUSTOM') {
                        <div class="sys-tip" role="note">
                          This is a system location — you can rename it, but the Backroom and
                          On Floor can't be deactivated or removed.
                        </div>
                      }
                    } @else {
                      {{ loc.name }}
                    }
                  </td>
                  <td>
                    <span class="kind-badge" [class]="'k-' + loc.kind">{{ kindLabel(loc.kind) }}</span>
                  </td>
                  <td>
                    @if (editId() === loc.id && loc.kind === 'CUSTOM') {
                      <select class="cell-input" name="edit-active" [(ngModel)]="editActive">
                        <option [ngValue]="true">Active</option>
                        <option [ngValue]="false">Inactive</option>
                      </select>
                    } @else {
                      <span class="muted">{{ loc.isActive ? 'Active' : 'Inactive' }}</span>
                    }
                  </td>
                  @if (isCompanyAdmin) {
                    <td class="actions">
                      @if (editId() === loc.id) {
                        <button class="sm" (click)="save(loc)" [disabled]="saving()">Save</button>
                        <button class="sm ghost" (click)="editId.set(null)">Cancel</button>
                        @if (loc.kind === 'CUSTOM') {
                          <button class="sm danger" (click)="remove(loc)" [disabled]="saving()">Delete</button>
                        }
                      } @else {
                        <button class="sm ghost" (click)="startEdit(loc)">Edit</button>
                      }
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>

      }

      @if (showAdd()) {
        <div class="overlay" (click)="closeAdd()">
          <div class="modal" (click)="$event.stopPropagation()">
            <h3>Add location</h3>
            @if (addError()) {
              <p class="error">{{ addError() }}</p>
            }
            <form class="stacked" (ngSubmit)="create()">
              <label>
                Name
                <input name="a-name" [(ngModel)]="newName" placeholder="e.g. Aisle 3" autofocus />
              </label>
              <label>
                Status
                <select name="a-active" [(ngModel)]="newActive">
                  <option [ngValue]="true">Active</option>
                  <option [ngValue]="false">Inactive</option>
                </select>
              </label>
              <div class="modal-actions">
                <button type="submit" [disabled]="saving() || !newName.trim()">Create</button>
                <button type="button" class="ghost" (click)="closeAdd()">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      }
    </section>
  `,
  styles: [
    `
      .card {
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--surface);
        padding: 1.25rem;
      }
      .section-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
        margin-bottom: 0.5rem;
      }
      h2 {
        margin: 0;
        font-size: 1.05rem;
      }
      .head-controls {
        display: flex;
        align-items: flex-end;
        gap: 0.6rem;
      }
      .inline {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        font-size: 0.75rem;
        color: var(--muted);
      }
      .name-cell {
        position: relative;
      }
      .sys-tip {
        position: absolute;
        left: 0.6rem;
        top: calc(100% - 2px);
        z-index: 5;
        width: 240px;
        max-width: 70vw;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.14);
        padding: 0.5rem 0.6rem;
        font-size: 0.75rem;
        line-height: 1.35;
        color: var(--muted);
      }
      .sys-tip::before {
        content: '';
        position: absolute;
        top: -5px;
        left: 16px;
        width: 9px;
        height: 9px;
        background: var(--surface);
        border-left: 1px solid var(--border);
        border-top: 1px solid var(--border);
        transform: rotate(45deg);
      }
      .table-scroll {
        overflow-x: auto;
        transition: opacity 0.12s ease;
      }
      .table-scroll.busy {
        opacity: 0.55;
        pointer-events: none;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.9rem;
        table-layout: fixed;
      }
      th,
      td {
        text-align: left;
        padding: 0.5rem 0.6rem;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      /* Fixed widths so entering edit mode never reflows the columns. */
      .col-name {
        width: 42%;
      }
      .col-type {
        width: 16%;
      }
      .col-status {
        width: 18%;
      }
      .col-actions {
        width: 24%;
      }
      td.actions,
      th.actions {
        text-align: right;
        white-space: nowrap;
      }
      th.sortable {
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
      }
      th.sortable:hover {
        color: var(--brand, var(--accent));
      }
      .arrow {
        display: inline-block;
        width: 1em;
        color: var(--brand, var(--accent));
      }
      input,
      select {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
      }
      .cell-input {
        width: 100%;
        max-width: none;
        box-sizing: border-box;
      }
      .kind-badge {
        display: inline-block;
        font-size: 0.7rem;
        font-weight: 600;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        border: 1px solid transparent;
      }
      .k-BACKROOM {
        background: #eff4ff;
        color: #1d4ed8;
        border-color: #c7d7fe;
      }
      .k-ONFLOOR {
        background: #ecfdf3;
        color: #067647;
        border-color: #abefc6;
      }
      .k-CUSTOM {
        background: #f4f4f5;
        color: #52525b;
        border-color: #e4e4e7;
      }
      .muted {
        color: var(--muted);
      }
      .error {
        color: #b42318;
        font-size: 0.85rem;
      }
      button.sm {
        padding: 0.3rem 0.55rem;
        font-size: 0.8rem;
        margin-left: 0.25rem;
      }
      button.danger {
        color: #b42318;
      }
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: 4rem 1rem;
        z-index: 80;
      }
      .modal {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        width: 100%;
        max-width: 380px;
        padding: 1.25rem;
      }
      .modal h3 {
        margin: 0 0 0.75rem;
        font-size: 1rem;
      }
      .stacked {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      .stacked label {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.8rem;
        color: var(--muted);
      }
      .modal-actions {
        display: flex;
        gap: 0.5rem;
        margin-top: 0.5rem;
      }
    `,
  ],
})
export class LocationsComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);

  readonly isCompanyAdmin = this.auth.user()?.role === 'COMPANY_ADMIN';

  readonly stores = signal<Store[]>([]);
  readonly storeId = signal<number | null>(this.auth.user()?.storeId ?? null);
  readonly locations = signal<StoreLocation[]>([]);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly editId = signal<number | null>(null);
  editName = '';
  editActive = true;

  // Add-location modal.
  readonly showAdd = signal(false);
  readonly addError = signal<string | null>(null);
  newName = '';
  newActive = true;

  // Client-side sort (the list is small — no round-trip needed).
  readonly sortField = signal<SortField | null>(null);
  readonly sortDir = signal<'asc' | 'desc'>('asc');

  private static readonly KIND_ORDER: Record<string, number> = {
    BACKROOM: 0,
    ONFLOOR: 1,
    CUSTOM: 2,
  };

  readonly displayLocations = computed(() => {
    const field = this.sortField();
    const list = [...this.locations()];
    if (!field) return list; // server order (sortOrder, id)
    const dir = this.sortDir() === 'asc' ? 1 : -1;
    return list.sort((a, b) => {
      let cmp = 0;
      if (field === 'name') cmp = a.name.localeCompare(b.name);
      else if (field === 'kind')
        cmp = LocationsComponent.KIND_ORDER[a.kind] - LocationsComponent.KIND_ORDER[b.kind];
      else cmp = Number(a.isActive) - Number(b.isActive);
      return cmp * dir;
    });
  });

  ngOnInit(): void {
    if (this.isCompanyAdmin) {
      this.api.listStores().subscribe({
        next: (rows) => {
          this.stores.set(rows);
          if (this.storeId() == null && rows.length > 0) this.storeId.set(rows[0].id);
          this.reload();
        },
        error: (err) => this.error.set(messageFor(err)),
      });
    } else {
      this.reload();
    }
  }

  onStore(id: number): void {
    this.storeId.set(id);
    this.editId.set(null);
    this.reload();
  }

  reload(): void {
    const sid = this.storeId();
    if (sid == null) return;
    this.loading.set(true);
    this.error.set(null);
    this.api.listLocations(sid).subscribe({
      next: (rows) => {
        this.locations.set(rows);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  sort(field: SortField): void {
    if (this.sortField() === field) {
      this.sortDir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortField.set(field);
      this.sortDir.set('asc');
    }
  }

  icon(field: SortField): string {
    if (this.sortField() !== field) return '';
    return this.sortDir() === 'asc' ? '▲' : '▼';
  }

  startEdit(loc: StoreLocation): void {
    this.editName = loc.name;
    this.editActive = loc.isActive;
    this.error.set(null);
    this.editId.set(loc.id);
  }

  save(loc: StoreLocation): void {
    const name = this.editName.trim();
    if (!name) return;
    const dto: { name: string; isActive?: boolean } = { name };
    // Only custom locations can have their active status changed.
    if (loc.kind === 'CUSTOM') dto.isActive = this.editActive;
    this.saving.set(true);
    this.error.set(null);
    this.api.updateLocation(loc.id, dto).subscribe({
      next: () => {
        this.saving.set(false);
        this.editId.set(null);
        this.reload();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  remove(loc: StoreLocation): void {
    if (!confirm(`Delete location "${loc.name}"? This cannot be undone.`)) return;
    this.saving.set(true);
    this.error.set(null);
    this.api.deleteLocation(loc.id).subscribe({
      next: () => {
        this.saving.set(false);
        this.editId.set(null);
        this.reload();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  openAdd(): void {
    this.newName = '';
    this.newActive = true;
    this.addError.set(null);
    this.showAdd.set(true);
  }

  closeAdd(): void {
    this.showAdd.set(false);
  }

  create(): void {
    const sid = this.storeId();
    const name = this.newName.trim();
    if (sid == null || !name) return;
    this.saving.set(true);
    this.addError.set(null);
    this.api.createLocation({ storeId: sid, name, isActive: this.newActive }).subscribe({
      next: () => {
        this.saving.set(false);
        this.showAdd.set(false);
        this.reload();
      },
      error: (err) => {
        this.saving.set(false);
        this.addError.set(messageFor(err));
      },
    });
  }

  kindLabel(kind: string): string {
    switch (kind) {
      case 'BACKROOM':
        return 'Backroom';
      case 'ONFLOOR':
        return 'On Floor';
      default:
        return 'Custom';
    }
  }
}
