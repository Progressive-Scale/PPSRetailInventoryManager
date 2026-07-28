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
          <button (click)="reload()" class="ghost" [disabled]="loading()">Refresh</button>
        </div>
      </div>

      <p class="hint">
        Every store has a <strong>Backroom</strong> and an <strong>On Floor</strong> location.
        These can be renamed but not deactivated. Add custom locations (aisles, endcaps) as needed.
      </p>

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
                <th class="sortable" (click)="sort('name')">Name<span class="arrow">{{ icon('name') }}</span></th>
                <th class="sortable" (click)="sort('kind')">Type<span class="arrow">{{ icon('kind') }}</span></th>
                <th class="sortable" (click)="sort('active')">Status<span class="arrow">{{ icon('active') }}</span></th>
                @if (isCompanyAdmin) {
                  <th class="actions"></th>
                }
              </tr>
            </thead>
            <tbody>
              @for (loc of displayLocations(); track loc.id) {
                <tr [class.inactive-row]="!loc.isActive">
                  <td>
                    @if (editId() === loc.id) {
                      <input class="cell-input" name="edit-name" [(ngModel)]="editName" />
                    } @else {
                      {{ loc.name }}
                    }
                  </td>
                  <td>
                    <span class="kind-badge" [class]="'k-' + loc.kind">{{ kindLabel(loc.kind) }}</span>
                  </td>
                  <td>
                    @if (editId() === loc.id && loc.kind === 'CUSTOM') {
                      <label class="chk">
                        <input type="checkbox" name="edit-active" [(ngModel)]="editActive" />
                        Active
                      </label>
                    } @else {
                      <span class="muted">{{ loc.isActive ? 'Active' : 'Inactive' }}</span>
                    }
                  </td>
                  @if (isCompanyAdmin) {
                    <td class="actions">
                      @if (editId() === loc.id) {
                        <button class="sm" (click)="save(loc)" [disabled]="saving()">Save</button>
                        <button class="sm ghost" (click)="editId.set(null)">Cancel</button>
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

        @if (isCompanyAdmin) {
          <form class="add-form" (ngSubmit)="add()">
            <input name="new-loc" [(ngModel)]="newName" placeholder="New location name (e.g. Aisle 3)" />
            <button type="submit" [disabled]="saving() || !newName.trim()">Add location</button>
          </form>
        }
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
      .hint {
        color: var(--muted);
        font-size: 0.82rem;
        margin: 0 0 0.75rem;
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
      }
      th,
      td {
        text-align: left;
        padding: 0.5rem 0.6rem;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
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
        max-width: 260px;
      }
      .chk {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.85rem;
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
      .inactive-row {
        opacity: 0.55;
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
      .add-form {
        display: flex;
        gap: 0.5rem;
        margin-top: 0.85rem;
      }
      .add-form input {
        flex: 1 1 260px;
        max-width: 320px;
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
  newName = '';

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

  add(): void {
    const sid = this.storeId();
    const name = this.newName.trim();
    if (sid == null || !name) return;
    this.saving.set(true);
    this.error.set(null);
    this.api.createLocation({ storeId: sid, name }).subscribe({
      next: () => {
        this.saving.set(false);
        this.newName = '';
        this.reload();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
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
