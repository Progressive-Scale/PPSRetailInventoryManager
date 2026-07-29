import { DatePipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import { localAcceptUrl } from '../../core/tenant';
import {
  CreateInvitation,
  CreateStore,
  Invitation,
  Role,
  Store,
  User,
} from '../../core/models';

type Tab = 'stores' | 'users' | 'invitations';

@Component({
  selector: 'app-manage',
  imports: [FormsModule, DatePipe],
  template: `
    <main class="container">
      <div class="tabs">
        <button [class.active]="tab() === 'stores'" (click)="select('stores')">Stores</button>
        <button [class.active]="tab() === 'users'" (click)="select('users')">Users</button>
        <button [class.active]="tab() === 'invitations'" (click)="select('invitations')">
          Invitations
        </button>
      </div>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <!-- STORES -->
      @if (tab() === 'stores') {
        <section class="card">
          <div class="section-head">
            <h2>Stores</h2>
            <button (click)="openAddStore()">Add</button>
          </div>
          @if (loading()) {
            <p class="muted">Loading…</p>
          } @else if (stores().length === 0) {
            <p class="muted">No stores yet.</p>
          } @else {
            <div class="table-scroll">
              <table class="fixed">
                <thead>
                  <tr>
                    <th class="sc-name">Name</th>
                    <th class="sc-addr">Address</th>
                    <th class="sc-addr2">Address 2</th>
                    <th class="sc-city">City</th>
                    <th class="sc-state">State</th>
                    <th class="sc-zip">Zip</th>
                    <th class="sc-notes">Notes</th>
                    <th class="sc-active">Active</th>
                    <th class="actions sc-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (s of stores(); track s.id) {
                    <tr [class.inactive-row]="!s.isActive">
                      @if (editStoreId() === s.id) {
                        <td><input class="cell-input" name="es-name" [(ngModel)]="storeEdit.name" /></td>
                        <td><input class="cell-input" name="es-addr1" [(ngModel)]="storeEdit.address1" /></td>
                        <td><input class="cell-input" name="es-addr2" [(ngModel)]="storeEdit.address2" /></td>
                        <td><input class="cell-input" name="es-city" [(ngModel)]="storeEdit.city" /></td>
                        <td><input class="cell-input" name="es-state" [(ngModel)]="storeEdit.state" /></td>
                        <td><input class="cell-input" name="es-zip" [(ngModel)]="storeEdit.zip" /></td>
                        <td><input class="cell-input" name="es-notes" [(ngModel)]="storeEdit.notes" /></td>
                        <td>
                          <select class="cell-input" name="es-active" [(ngModel)]="storeEdit.isActive">
                            <option [ngValue]="true">Active</option>
                            <option [ngValue]="false">Inactive</option>
                          </select>
                        </td>
                        <td class="actions">
                          <button class="sm" (click)="saveStore(s)" [disabled]="saving()">Save</button>
                          <button class="sm ghost" (click)="editStoreId.set(null)">Cancel</button>
                          <button class="sm danger" (click)="askDeleteStore(s)" [disabled]="saving()">Delete</button>
                        </td>
                      } @else {
                        <td>{{ s.name }}</td>
                        <td class="muted">{{ s.address1 }}</td>
                        <td class="muted">{{ s.address2 }}</td>
                        <td class="muted">{{ s.city }}</td>
                        <td class="muted">{{ s.state }}</td>
                        <td class="muted">{{ s.zip }}</td>
                        <td class="muted">{{ s.notes }}</td>
                        <td>{{ s.isActive ? 'Active' : 'Inactive' }}</td>
                        <td class="actions">
                          <button class="sm ghost" (click)="startEditStore(s)">Edit</button>
                        </td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        @if (showAddStore()) {
          <div class="overlay" (click)="closeAddStore()">
            <div class="modal" (click)="$event.stopPropagation()">
              <h2>Add store</h2>
              @if (modalError()) {
                <p class="error">{{ modalError() }}</p>
              }
              <form class="stacked-form" (ngSubmit)="createStore()">
                <label>
                  Name <span class="req">*</span>
                  <input name="ms-name" [(ngModel)]="storeDraft.name" required />
                </label>
                <label>
                  Address
                  <input name="ms-addr1" [(ngModel)]="storeDraft.address1" />
                </label>
                <label>
                  Address 2
                  <input name="ms-addr2" [(ngModel)]="storeDraft.address2" />
                </label>
                <label>
                  City
                  <input name="ms-city" [(ngModel)]="storeDraft.city" />
                </label>
                <label>
                  State
                  <input name="ms-state" [(ngModel)]="storeDraft.state" />
                </label>
                <label>
                  Zip
                  <input name="ms-zip" [(ngModel)]="storeDraft.zip" />
                </label>
                <label>
                  Notes
                  <textarea name="ms-notes" rows="3" [(ngModel)]="storeDraft.notes"></textarea>
                </label>
                <div class="modal-actions">
                  <button type="submit" [disabled]="saving() || !storeDraft.name.trim()">Add</button>
                  <button type="button" class="ghost" (click)="closeAddStore()">Cancel</button>
                </div>
              </form>
            </div>
          </div>
        }

        @if (pendingDeleteStore(); as s) {
          <div class="overlay" (click)="pendingDeleteStore.set(null)">
            <div class="modal" (click)="$event.stopPropagation()">
              <h2>Delete store</h2>
              <p>Delete <strong>{{ s.name }}</strong>? This can't be undone.</p>
              <p class="muted note">
                A store that still has inventory can't be deleted — make it inactive instead.
              </p>
              @if (storeDeleteError()) {
                <p class="error">{{ storeDeleteError() }}</p>
              }
              <div class="modal-actions">
                <button class="danger-btn" (click)="confirmDeleteStore()" [disabled]="saving()">
                  {{ saving() ? 'Deleting…' : 'Delete' }}
                </button>
                <button class="ghost" (click)="pendingDeleteStore.set(null)" [disabled]="saving()">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        }
      }

      <!-- USERS -->
      @if (tab() === 'users') {
        <section class="card">
          <h2>Users</h2>
          @if (loading()) {
            <p class="muted">Loading…</p>
          } @else if (users().length === 0) {
            <p class="muted">No users yet.</p>
          } @else {
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Store</th>
                    <th>Status</th>
                    <th class="actions"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (u of users(); track u.id) {
                    <tr>
                      <td>{{ u.email }}</td>
                      <td>
                        <select [(ngModel)]="u.role" name="u-role-{{ u.id }}">
                          <option value="COMPANY_ADMIN">Company Admin</option>
                          <option value="STORE_USER">Store User</option>
                        </select>
                      </td>
                      <td>
                        <select [(ngModel)]="u.storeId" name="u-store-{{ u.id }}">
                          <option [ngValue]="null">—</option>
                          @for (s of stores(); track s.id) {
                            <option [ngValue]="s.id">{{ s.name }}</option>
                          }
                        </select>
                      </td>
                      <td>
                        <select [(ngModel)]="u.status" name="u-status-{{ u.id }}">
                          <option value="ACTIVE">Active</option>
                          <option value="SUSPENDED">Suspended</option>
                        </select>
                      </td>
                      <td class="actions">
                        <button class="sm" (click)="saveUser(u)" [disabled]="saving()">Save</button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }

      <!-- INVITATIONS -->
      @if (tab() === 'invitations') {
        <section class="card">
          <h2>Invite a user</h2>
          <form class="inline-form" (ngSubmit)="createInvite()">
            <input placeholder="Email" name="i-email" type="email" [(ngModel)]="inviteDraft.email" required />
            <select name="i-role" [(ngModel)]="inviteDraft.role">
              <option value="STORE_USER">Store User</option>
              <option value="COMPANY_ADMIN">Company Admin</option>
            </select>
            <select name="i-store" [(ngModel)]="inviteStoreId">
              <option [ngValue]="null">No store</option>
              @for (s of stores(); track s.id) {
                <option [ngValue]="s.id">{{ s.name }}</option>
              }
            </select>
            <button type="submit" [disabled]="saving()">Send invite</button>
          </form>
          @if (lastInviteUrl()) {
            <div class="link-box">
              <span class="muted">Accept link:</span>
              <code>{{ lastInviteUrl() }}</code>
              <button class="sm ghost" (click)="copy(lastInviteUrl()!)">Copy</button>
            </div>
          }
        </section>

        <section class="card">
          <h2>Pending invitations</h2>
          @if (loading()) {
            <p class="muted">Loading…</p>
          } @else if (invitations().length === 0) {
            <p class="muted">No invitations.</p>
          } @else {
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Expires</th>
                    <th>Accepted</th>
                    <th>Link</th>
                    <th class="actions"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (inv of invitations(); track inv.id) {
                    <tr>
                      <td>{{ inv.email }}</td>
                      <td>{{ inv.role }}</td>
                      <td class="muted">{{ inv.expiresAt | date: 'short' }}</td>
                      <td class="muted">{{ inv.acceptedAt ? 'Yes' : 'No' }}</td>
                      <td>
                        <button class="sm ghost" (click)="copy(inviteUrl(inv))">Copy link</button>
                      </td>
                      <td class="actions">
                        <button class="sm danger" (click)="revoke(inv)" [disabled]="saving()">
                          Revoke
                        </button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }
    </main>
  `,
  styles: [
    `
      .container {
        max-width: 1320px;
        margin: 1.5rem auto;
        padding: 0 1rem;
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
      }
      /* Chrome-style tabs connected to the form below. */
      .tabs {
        display: flex;
        gap: 4px;
        padding-left: 6px;
        margin-bottom: calc(-1.25rem - 1px);
        position: relative;
        z-index: 2;
      }
      .tabs button {
        background: #e6e9ef;
        color: var(--muted);
        border: 1px solid var(--border);
        border-radius: 10px 10px 0 0;
        padding: 0.5rem 1.15rem;
        font-size: 0.88rem;
        cursor: pointer;
      }
      .tabs button:hover:not(.active) {
        background: #dce0e7;
        color: #1f2937;
      }
      .tabs button.active {
        background: var(--surface);
        border-bottom-color: var(--surface);
        color: var(--brand, var(--accent));
        font-weight: 600;
      }
      .card {
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--surface);
        padding: 1.25rem;
      }
      h2 {
        margin: 0 0 0.85rem;
        font-size: 1.05rem;
      }
      .inline-form {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        align-items: center;
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
      textarea {
        resize: vertical;
        min-height: 2.4rem;
      }
      .inline-form input {
        flex: 1 1 160px;
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
        padding: 0.5rem 0.6rem;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      td.actions,
      th.actions {
        text-align: right;
        white-space: nowrap;
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
      .link-box {
        margin-top: 0.85rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
        padding: 0.6rem;
        background: var(--bg);
        border-radius: 8px;
      }
      .link-box code {
        font-size: 0.8rem;
        word-break: break-all;
      }
      .filter-row {
        margin-bottom: 0.85rem;
        font-size: 0.85rem;
        color: var(--muted);
      }
      .filter-row select {
        margin-left: 0.4rem;
      }
      tr.inactive-row td {
        color: var(--muted);
        opacity: 0.7;
      }
      label.chk {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 0.85rem;
      }
      label.chk input {
        margin: 0;
      }
      .section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
      }
      .section-head h2 {
        margin: 0;
      }
      /* Fixed-layout table so column widths + row height stay stable
         between view and edit mode. */
      table.fixed {
        table-layout: fixed;
      }
      table.fixed th,
      table.fixed td {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .col-sku {
        width: 16%;
      }
      .col-name {
        width: 30%;
      }
      .col-price {
        width: 12%;
      }
      .col-upc {
        width: 16%;
      }
      .col-active {
        width: 10%;
      }
      .col-actions {
        width: 16%;
      }
      /* Inline edit inputs match the surrounding display text so the row
         does not grow when switching to edit mode. */
      .cell-input {
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        margin: 0;
        padding: 0.1rem 0.3rem;
        font: inherit;
        border: 1px solid var(--border);
        border-radius: 6px;
      }
      td.actions {
        overflow: visible;
      }
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        z-index: 50;
      }
      .modal {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 1.25rem;
        width: 100%;
        max-width: 420px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
      }
      .stacked-form {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
      }
      .stacked-form label {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.85rem;
        color: var(--muted);
      }
      .stacked-form input,
      .stacked-form textarea {
        font-size: 0.9rem;
        width: 100%;
        box-sizing: border-box;
      }
      .req {
        color: #b42318;
      }
      .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        margin-top: 0.5rem;
      }
      .note {
        font-size: 0.82rem;
        margin: 0.25rem 0 0.5rem;
      }
      .danger-btn {
        background: #b42318;
        border: 1px solid #b42318;
        color: #fff;
      }
      .danger-btn:hover:not(:disabled) {
        background: #99200f;
        border-color: #99200f;
      }
      /* Stores table: fixed column widths so entering edit mode never reflows. */
      .sc-name {
        width: 14%;
      }
      .sc-addr {
        width: 13%;
      }
      .sc-addr2 {
        width: 10%;
      }
      .sc-city {
        width: 10%;
      }
      .sc-state {
        width: 6%;
      }
      .sc-zip {
        width: 7%;
      }
      .sc-notes {
        width: 13%;
      }
      .sc-active {
        width: 8%;
      }
      .sc-actions {
        width: 19%;
      }
    `,
  ],
})
export class ManageComponent implements OnInit {
  private readonly api = inject(ApiService);

  readonly tab = signal<Tab>('stores');
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly stores = signal<Store[]>([]);
  readonly users = signal<User[]>([]);
  readonly invitations = signal<Invitation[]>([]);

  // Add-store modal.
  readonly showAddStore = signal(false);
  readonly modalError = signal<string | null>(null);

  // Delete-store confirmation modal.
  readonly pendingDeleteStore = signal<Store | null>(null);
  readonly storeDeleteError = signal<string | null>(null);

  storeDraft: CreateStore = {
    name: '',
    address1: '',
    address2: '',
    city: '',
    state: '',
    zip: '',
    notes: '',
  };
  readonly editStoreId = signal<number | null>(null);
  storeEdit: CreateStore = {
    name: '',
    address1: '',
    address2: '',
    city: '',
    state: '',
    zip: '',
    notes: '',
  };

  inviteDraft: { email: string; role: Role } = { email: '', role: 'STORE_USER' };
  inviteStoreId: number | null = null;
  readonly lastInviteUrl = signal<string | null>(null);

  ngOnInit(): void {
    // Stores are needed by every tab (user/invite store pickers) and are the
    // initial tab, so load them once up front.
    this.loadStores();
  }

  select(tab: Tab): void {
    this.tab.set(tab);
    this.error.set(null);
    if (tab === 'stores') this.loadStores();
    if (tab === 'users') {
      // Ensure the store picker options are available.
      if (this.stores().length === 0) this.loadStores();
      this.loadUsers();
    }
    if (tab === 'invitations') {
      if (this.stores().length === 0) this.loadStores();
      this.loadInvitations();
    }
  }

  private loadStores(): void {
    this.loading.set(true);
    this.api.listStores().subscribe({
      next: (rows) => {
        this.stores.set(rows);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  private loadUsers(): void {
    this.loading.set(true);
    this.api.listUsers().subscribe({
      next: (rows) => {
        this.users.set(rows.map((u) => ({ ...u })));
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  private loadInvitations(): void {
    this.loading.set(true);
    this.api.listInvitations().subscribe({
      next: (rows) => {
        this.invitations.set(rows);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  // ---- stores ----
  private blankStore(): CreateStore {
    return { name: '', address1: '', address2: '', city: '', state: '', zip: '', notes: '' };
  }

  openAddStore(): void {
    this.storeDraft = this.blankStore();
    this.modalError.set(null);
    this.showAddStore.set(true);
  }

  closeAddStore(): void {
    this.showAddStore.set(false);
  }

  createStore(): void {
    if (!this.storeDraft.name.trim()) {
      this.modalError.set('Store name is required.');
      return;
    }
    const dto: CreateStore = { name: this.storeDraft.name };
    if (this.storeDraft.address1) dto.address1 = this.storeDraft.address1;
    if (this.storeDraft.address2) dto.address2 = this.storeDraft.address2;
    if (this.storeDraft.city) dto.city = this.storeDraft.city;
    if (this.storeDraft.state) dto.state = this.storeDraft.state;
    if (this.storeDraft.zip) dto.zip = this.storeDraft.zip;
    if (this.storeDraft.notes) dto.notes = this.storeDraft.notes;
    this.saving.set(true);
    this.modalError.set(null);
    this.api.createStore(dto).subscribe({
      next: () => {
        this.saving.set(false);
        this.storeDraft = this.blankStore();
        this.showAddStore.set(false);
        this.loadStores();
      },
      error: (err) => {
        this.saving.set(false);
        this.modalError.set(messageFor(err));
      },
    });
  }

  startEditStore(s: Store): void {
    this.editStoreId.set(s.id);
    this.storeEdit = {
      name: s.name,
      address1: s.address1 ?? '',
      address2: s.address2 ?? '',
      city: s.city ?? '',
      state: s.state ?? '',
      zip: s.zip ?? '',
      notes: s.notes ?? '',
      isActive: s.isActive,
    };
  }

  saveStore(s: Store): void {
    this.saving.set(true);
    this.error.set(null);
    this.api
      .updateStore(s.id, {
        name: this.storeEdit.name,
        address1: this.storeEdit.address1,
        address2: this.storeEdit.address2,
        city: this.storeEdit.city,
        state: this.storeEdit.state,
        zip: this.storeEdit.zip,
        notes: this.storeEdit.notes,
        isActive: this.storeEdit.isActive,
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.editStoreId.set(null);
          this.loadStores();
        },
        error: (err) => {
          this.saving.set(false);
          this.error.set(messageFor(err));
        },
      });
  }

  askDeleteStore(s: Store): void {
    this.storeDeleteError.set(null);
    this.pendingDeleteStore.set(s);
  }

  confirmDeleteStore(): void {
    const s = this.pendingDeleteStore();
    if (!s) return;
    this.saving.set(true);
    this.storeDeleteError.set(null);
    this.api.deleteStore(s.id).subscribe({
      next: () => {
        this.saving.set(false);
        this.pendingDeleteStore.set(null);
        this.editStoreId.set(null);
        this.loadStores();
      },
      error: (err) => {
        this.saving.set(false);
        this.storeDeleteError.set(messageFor(err));
      },
    });
  }

  // ---- users ----
  saveUser(u: User): void {
    this.saving.set(true);
    this.error.set(null);
    this.api
      .updateUser(u.id, { role: u.role, status: u.status, storeId: u.storeId })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.loadUsers();
        },
        error: (err) => {
          this.saving.set(false);
          this.error.set(messageFor(err));
        },
      });
  }

  // ---- invitations ----
  createInvite(): void {
    if (!this.inviteDraft.email) {
      this.error.set('Email is required.');
      return;
    }
    const dto: CreateInvitation = { email: this.inviteDraft.email, role: this.inviteDraft.role };
    if (this.inviteStoreId != null) dto.storeId = this.inviteStoreId;
    this.saving.set(true);
    this.error.set(null);
    this.api.createInvitation(dto).subscribe({
      next: (inv) => {
        this.saving.set(false);
        this.inviteDraft = { email: '', role: 'STORE_USER' };
        this.inviteStoreId = null;
        this.lastInviteUrl.set(this.inviteUrl(inv));
        this.loadInvitations();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  revoke(inv: Invitation): void {
    if (!confirm(`Revoke invitation for ${inv.email}?`)) return;
    this.saving.set(true);
    this.error.set(null);
    this.api.deleteInvitation(inv.id).subscribe({
      next: () => {
        this.saving.set(false);
        this.loadInvitations();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  inviteUrl(inv: Invitation): string {
    if (inv.acceptPath) return `${window.location.origin}${inv.acceptPath}`;
    return localAcceptUrl(inv.token);
  }

  copy(text: string): void {
    void navigator.clipboard?.writeText(text);
  }
}
