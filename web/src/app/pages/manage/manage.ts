import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
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
          @if (!loading() && stores().length > 0) {
            <div class="filters">
              <label class="f">
                Search
                <input
                  name="fs-search"
                  placeholder="Name, address, city, notes"
                  [ngModel]="storeSearch()"
                  (ngModelChange)="storeSearch.set($event)"
                />
              </label>
              <label class="f">
                Active
                <select
                  name="fs-active"
                  [ngModel]="storeActiveFilter()"
                  (ngModelChange)="storeActiveFilter.set($event)"
                >
                  <option [ngValue]="null">All</option>
                  <option [ngValue]="'active'">Active</option>
                  <option [ngValue]="'inactive'">Inactive</option>
                </select>
              </label>
              <div class="f-actions">
                <button
                  type="button"
                  class="ghost"
                  (click)="clearStoreFilters()"
                  [disabled]="!storeFiltersActive()"
                >
                  Clear
                </button>
                <button type="button" class="ghost" (click)="refresh()" [disabled]="loading()">
                  Refresh
                </button>
              </div>
            </div>
          }
          @if (loading()) {
            <p class="muted">Loading…</p>
          } @else if (stores().length === 0) {
            <p class="muted">No stores yet.</p>
          } @else if (filteredStores().length === 0) {
            <p class="muted">No stores match these filters.</p>
          } @else {
            <div class="table-scroll stores-scroll">
              <table class="fixed stores">
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
                  @for (s of filteredStores(); track s.id) {
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
                        <td class="tipcell" (mouseenter)="onCellEnter($event)">
                          <span class="ctext">{{ s.name }}</span>
                          @if (s.name) {
                            <span class="cell-tip">{{ s.name }}</span>
                          }
                        </td>
                        <td class="muted tipcell" (mouseenter)="onCellEnter($event)">
                          <span class="ctext">{{ s.address1 }}</span>
                          @if (s.address1) {
                            <span class="cell-tip">{{ s.address1 }}</span>
                          }
                        </td>
                        <td class="muted tipcell" (mouseenter)="onCellEnter($event)">
                          <span class="ctext">{{ s.address2 }}</span>
                          @if (s.address2) {
                            <span class="cell-tip">{{ s.address2 }}</span>
                          }
                        </td>
                        <td class="muted tipcell" (mouseenter)="onCellEnter($event)">
                          <span class="ctext">{{ s.city }}</span>
                          @if (s.city) {
                            <span class="cell-tip">{{ s.city }}</span>
                          }
                        </td>
                        <td class="muted"><span class="ctext">{{ s.state }}</span></td>
                        <td class="muted"><span class="ctext">{{ s.zip }}</span></td>
                        <td class="muted tipcell" (mouseenter)="onCellEnter($event)">
                          <span class="ctext">{{ s.notes }}</span>
                          @if (s.notes) {
                            <span class="cell-tip">{{ s.notes }}</span>
                          }
                        </td>
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
          <div class="section-head">
            <h2>Users</h2>
            @if (!loading() && users().length > 0) {
              <span class="muted small">
                {{ filteredUsers().length }} of {{ users().length }}
              </span>
            }
          </div>
          @if (!loading() && users().length > 0) {
            <div class="filters">
              <label class="f">
                Search
                <input
                  name="fu-search"
                  placeholder="Email, role, store, status"
                  [ngModel]="userSearch()"
                  (ngModelChange)="userSearch.set($event)"
                />
              </label>
              <label class="f">
                Role
                <select
                  name="fu-role"
                  [ngModel]="userRoleFilter()"
                  (ngModelChange)="userRoleFilter.set($event)"
                >
                  <option [ngValue]="null">All</option>
                  <option [ngValue]="'COMPANY_ADMIN'">Company Admin</option>
                  <option [ngValue]="'STORE_USER'">Store User</option>
                </select>
              </label>
              <label class="f">
                Active store
                <select
                  name="fu-store"
                  [ngModel]="userStoreFilter()"
                  (ngModelChange)="userStoreFilter.set($event)"
                >
                  <option [ngValue]="null">All</option>
                  <option [ngValue]="'none'">— none —</option>
                  @for (s of stores(); track s.id) {
                    <option [ngValue]="s.id">{{ s.name }}</option>
                  }
                </select>
              </label>
              <div class="f">
                <span>Stores</span>
                <div class="multi">
                  <button
                    type="button"
                    class="multi-toggle"
                    (click)="storeMenuOpen.set(!storeMenuOpen())"
                  >
                    <span class="multi-label">{{ assignedStoresLabel() }}</span>
                    <span class="caret">▾</span>
                  </button>
                  @if (storeMenuOpen()) {
                    <div class="multi-backdrop" (click)="storeMenuOpen.set(false)"></div>
                    <div class="multi-panel">
                      <label class="multi-row">
                        <input
                          type="checkbox"
                          [checked]="isAssignedPicked('none')"
                          (change)="toggleAssignedStore('none')"
                        />
                        — none —
                      </label>
                      @for (s of stores(); track s.id) {
                        <label class="multi-row">
                          <input
                            type="checkbox"
                            [checked]="isAssignedPicked(s.id)"
                            (change)="toggleAssignedStore(s.id)"
                          />
                          {{ s.name }}
                        </label>
                      }
                    </div>
                  }
                </div>
              </div>
              <label class="f">
                Status
                <select
                  name="fu-status"
                  [ngModel]="userStatusFilter()"
                  (ngModelChange)="userStatusFilter.set($event)"
                >
                  <option [ngValue]="null">All</option>
                  <option [ngValue]="'ACTIVE'">Active</option>
                  <option [ngValue]="'SUSPENDED'">Suspended</option>
                </select>
              </label>
              <div class="f-actions">
                <button
                  type="button"
                  class="ghost"
                  (click)="clearUserFilters()"
                  [disabled]="!userFiltersActive()"
                >
                  Clear
                </button>
                <button type="button" class="ghost" (click)="refresh()" [disabled]="loading()">
                  Refresh
                </button>
              </div>
            </div>
          }
          @if (loading()) {
            <p class="muted">Loading…</p>
          } @else if (users().length === 0) {
            <p class="muted">No users yet.</p>
          } @else if (filteredUsers().length === 0) {
            <p class="muted">No users match these filters.</p>
          } @else {
            <div class="table-scroll">
              <table class="fixed">
                <thead>
                  <tr>
                    <th class="uc-email">Email</th>
                    <th class="uc-role">Role</th>
                    <th class="uc-stores">Stores</th>
                    <th class="uc-active">Active store</th>
                    <th class="uc-status">Status</th>
                    <th class="actions uc-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (u of filteredUsers(); track u.id) {
                    <tr [class.row-edit]="editUserId() === u.id">
                      @if (editUserId() === u.id) {
                        <td class="ctext">{{ u.email }}</td>
                        <td>
                          <select class="cell-input" [(ngModel)]="userEdit.role" name="u-role-{{ u.id }}">
                            <option value="COMPANY_ADMIN">Company Admin</option>
                            <option value="STORE_USER">Store User</option>
                          </select>
                        </td>
                        <td>
                          <div class="store-picks">
                            @if (availableToAdd().length > 0) {
                              <select class="cell-input" (change)="addUserStore($event)">
                                <option value="">Add store…</option>
                                @for (s of availableToAdd(); track s.id) {
                                  <option [value]="s.id">{{ s.name }}</option>
                                }
                              </select>
                            }
                            @if (userEdit.storeIds.length > 0) {
                              <div class="store-chips">
                                @for (sid of userEdit.storeIds; track sid) {
                                  <span class="chip">
                                    <span class="chip-label">{{ storeName(sid) }}</span>
                                    <button
                                      type="button"
                                      class="chip-x"
                                      (click)="removeUserStore(sid)"
                                      title="Remove store"
                                    >
                                      ✕
                                    </button>
                                  </span>
                                }
                              </div>
                            }
                          </div>
                        </td>
                        <td>
                          <select class="cell-input" [(ngModel)]="userEdit.storeId" name="u-active-{{ u.id }}">
                            <option [ngValue]="null">— choose at login —</option>
                            @for (sid of userEdit.storeIds; track sid) {
                              <option [ngValue]="sid">{{ storeName(sid) }}</option>
                            }
                          </select>
                        </td>
                        <td>
                          <select class="cell-input" [(ngModel)]="userEdit.status" name="u-status-{{ u.id }}">
                            <option value="ACTIVE">Active</option>
                            <option value="SUSPENDED">Suspended</option>
                          </select>
                        </td>
                        <td class="actions">
                          <button class="sm" (click)="saveUser(u)" [disabled]="saving()">Save</button>
                          <button class="sm ghost" (click)="editUserId.set(null)">Cancel</button>
                        </td>
                      } @else {
                        <td class="ctext" [title]="u.email">{{ u.email }}</td>
                        <td>{{ roleLabel(u.role) }}</td>
                        <td>
                          @if (u.storeIds.length === 0) {
                            <span class="muted">—</span>
                          } @else {
                            <div class="store-tags">
                              @for (sid of u.storeIds; track sid) {
                                <span class="store-tag">{{ storeName(sid) }}</span>
                              }
                            </div>
                          }
                        </td>
                        <td class="muted">{{ u.storeId ? storeName(u.storeId) : '—' }}</td>
                        <td>{{ u.status === 'ACTIVE' ? 'Active' : 'Suspended' }}</td>
                        <td class="actions">
                          <button class="sm ghost" (click)="startEditUser(u)">Edit</button>
                        </td>
                      }
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
          <div class="section-head">
            <h2>Pending invitations</h2>
            <button (click)="openInvite()">Invite</button>
          </div>
          @if (inviteSent()) {
            <div class="link-box">
              <span class="muted">Invitation emailed to {{ inviteSent() }}.</span>
              <button class="sm ghost" (click)="inviteSent.set(null)">Dismiss</button>
            </div>
          }
          @if (!loading() && invitations().length > 0) {
            <div class="filters">
              <label class="f">
                Email
                <input
                  name="fi-email"
                  placeholder="Search email"
                  [ngModel]="inviteSearch()"
                  (ngModelChange)="inviteSearch.set($event)"
                />
              </label>
              <label class="f">
                Status
                <select
                  name="fi-status"
                  [ngModel]="inviteStatusFilter()"
                  (ngModelChange)="inviteStatusFilter.set($event)"
                >
                  <option [ngValue]="null">All</option>
                  @for (s of inviteStatuses; track s) {
                    <option [ngValue]="s">{{ s }}</option>
                  }
                </select>
              </label>
              <label class="f">
                Role
                <select
                  name="fi-role"
                  [ngModel]="inviteRoleFilter()"
                  (ngModelChange)="inviteRoleFilter.set($event)"
                >
                  <option [ngValue]="null">All</option>
                  <option [ngValue]="'COMPANY_ADMIN'">Company Admin</option>
                  <option [ngValue]="'STORE_USER'">Store User</option>
                </select>
              </label>
              <div class="f-actions">
                <button
                  type="button"
                  class="ghost"
                  (click)="clearInviteFilters()"
                  [disabled]="!inviteFiltersActive()"
                >
                  Clear
                </button>
                <button type="button" class="ghost" (click)="refresh()" [disabled]="loading()">
                  Refresh
                </button>
              </div>
            </div>
          }
          @if (loading()) {
            <p class="muted">Loading…</p>
          } @else if (invitations().length === 0) {
            <p class="muted">No invitations.</p>
          } @else if (filteredInvitations().length === 0) {
            <p class="muted">No invitations match these filters.</p>
          } @else {
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Stores</th>
                    <th>Status</th>
                    <th>Expires</th>
                    <th class="actions"></th>
                  </tr>
                </thead>
                <tbody>
                  @for (inv of filteredInvitations(); track inv.id) {
                    <tr>
                      <td>{{ inv.email }}</td>
                      <td>{{ roleLabel(inv.role) }}</td>
                      <td>
                        @if (inv.storeIds.length === 0) {
                          <span class="muted">—</span>
                        } @else {
                          <div class="store-tags">
                            @for (sid of inv.storeIds; track sid) {
                              <span class="store-tag">{{ storeName(sid) }}</span>
                            }
                          </div>
                        }
                      </td>
                      <td>
                        <span class="inv-badge" [class]="'inv-' + inviteStatus(inv)">
                          {{ inviteStatus(inv) }}
                        </span>
                        @if (inv.emailStatus === 'FAILED' && inv.emailError) {
                          <div class="muted small" [title]="inv.emailError">
                            {{ inv.emailError }}
                          </div>
                        }
                      </td>
                      <td class="muted">{{ inv.expiresAt | date: 'short' }}</td>
                      <td class="actions">
                        @if (inv.emailStatus === 'FAILED') {
                          <button class="sm ghost" (click)="copyFreshLink(inv)" [disabled]="saving()">
                            Copy link
                          </button>
                        }
                        @if (!isTerminal(inv)) {
                          <button class="sm ghost" (click)="resend(inv)" [disabled]="saving()">
                            Resend
                          </button>
                        }
                        @if (canRevoke(inv)) {
                          <button class="sm danger" (click)="askRevoke(inv)" [disabled]="saving()">
                            Revoke
                          </button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
          @if (freshLink()) {
            <div class="link-box">
              <span class="muted">New accept link (this replaces the old one):</span>
              <code>{{ freshLink() }}</code>
              <button class="sm ghost" (click)="copy(freshLink()!)">Copy</button>
              <button class="sm ghost" (click)="freshLink.set(null)">Dismiss</button>
            </div>
          }
        </section>

        @if (showInvite()) {
          <div class="overlay" (click)="closeInvite()">
            <div class="modal" (click)="$event.stopPropagation()">
              <h2>Invite a user</h2>
              @if (modalError()) {
                <p class="error">{{ modalError() }}</p>
              }
              <form class="stacked-form" (ngSubmit)="createInvite()">
                <label>
                  Email <span class="req">*</span>
                  <input
                    name="mi-email"
                    type="email"
                    [(ngModel)]="inviteDraft.email"
                    placeholder="person@example.com"
                    required
                  />
                </label>
                <label>
                  Role
                  <select name="mi-role" [(ngModel)]="inviteDraft.role">
                    <option value="STORE_USER">Store User</option>
                    <option value="COMPANY_ADMIN">Company Admin</option>
                  </select>
                </label>
                <label>
                  Stores
                  <div class="store-picks">
                    @if (invitableStores().length > 0) {
                      <select (change)="addInviteStore($event)">
                        <option value="">Add store…</option>
                        @for (s of invitableStores(); track s.id) {
                          <option [value]="s.id">{{ s.name }}</option>
                        }
                      </select>
                    }
                    @if (inviteStoreIds().length > 0) {
                      <div class="store-chips">
                        @for (sid of inviteStoreIds(); track sid) {
                          <span class="chip">
                            <span class="chip-label">{{ storeName(sid) }}</span>
                            <button
                              type="button"
                              class="chip-x"
                              (click)="removeInviteStore(sid)"
                              title="Remove store"
                            >
                              ✕
                            </button>
                          </span>
                        }
                      </div>
                    }
                  </div>
                </label>
                <p class="muted note">
                  @if (inviteStoreIds().length === 0) {
                    No store — the invitee gets no store access until one is assigned.
                  } @else if (inviteStoreIds().length === 1) {
                    They will start in this store.
                  } @else {
                    They pick which of these {{ inviteStoreIds().length }} stores to work in
                    when they log in.
                  }
                </p>
                <div class="modal-actions">
                  <button type="submit" [disabled]="saving() || !inviteDraft.email.trim()">
                    {{ saving() ? 'Sending…' : 'Send invite' }}
                  </button>
                  <button type="button" class="ghost" (click)="closeInvite()">Cancel</button>
                </div>
              </form>
            </div>
          </div>
        }

        @if (pendingRevoke(); as inv) {
          <div class="overlay" (click)="pendingRevoke.set(null)">
            <div class="modal" (click)="$event.stopPropagation()">
              <h2>Revoke invitation</h2>
              <p>
                Revoke the invitation for <strong>{{ inv.email }}</strong>? Their link stops
                working immediately.
              </p>
              @if (error()) {
                <p class="error">{{ error() }}</p>
              }
              <div class="modal-actions">
                <button class="danger-btn" (click)="confirmRevoke()" [disabled]="saving()">
                  {{ saving() ? 'Revoking…' : 'Revoke' }}
                </button>
                <button class="ghost" (click)="pendingRevoke.set(null)" [disabled]="saving()">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        }
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
      /* Same filter bar as the inventory page. */
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
      /* Every control in a filter bar shares one height so Clear/Refresh line up
         with the inputs rather than sitting short. */
      .filters input,
      .filters select,
      .filters .f-actions button,
      .filters .multi-toggle {
        height: 2.25rem;
        box-sizing: border-box;
      }
      /* Multi-select filter: a 36px trigger plus a checkbox panel, so picking
         several stores never changes the height of the filter bar. */
      .multi {
        position: relative;
      }
      .multi-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        min-width: 11rem;
        padding: 0 0.55rem;
        background: var(--surface, #fff);
        color: inherit;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
        font-family: inherit;
        cursor: pointer;
      }
      .multi-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .caret {
        font-size: 0.7rem;
        color: var(--muted);
      }
      /* Transparent catcher so clicking anywhere closes the panel. */
      .multi-backdrop {
        position: fixed;
        inset: 0;
        z-index: 20;
      }
      .multi-panel {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        z-index: 21;
        min-width: 100%;
        max-height: 14rem;
        overflow-y: auto;
        background: var(--surface, #fff);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: 0 8px 20px rgba(16, 24, 40, 0.12);
        padding: 0.3rem;
      }
      .multi-row {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        padding: 0.3rem 0.4rem;
        font-size: 0.85rem;
        color: var(--text, inherit);
        white-space: nowrap;
        border-radius: 6px;
        cursor: pointer;
      }
      .multi-row:hover {
        background: var(--accent-soft, #eff4ff);
      }
      .multi-row input {
        height: auto;
        margin: 0;
      }
      .filters .f-actions button {
        margin-left: 0;
        padding: 0 0.75rem;
        font-size: 0.85rem;
        font-family: inherit;
        border-radius: 8px;
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
      .head-right {
        display: flex;
        align-items: center;
        gap: 0.75rem;
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
      .inv-badge {
        display: inline-block;
        font-size: 0.72rem;
        font-weight: 600;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        border: 1px solid transparent;
      }
      .inv-Sent {
        background: #eff4ff;
        color: #1d4ed8;
        border-color: #c7d7fe;
      }
      .inv-Accepted {
        background: #ecfdf3;
        color: #067647;
        border-color: #abefc6;
      }
      .inv-Pending {
        background: #fffaeb;
        color: #b54708;
        border-color: #fedf89;
      }
      .inv-Failed {
        background: #fef3f2;
        color: #b42318;
        border-color: #fecdca;
      }
      .inv-Revoked,
      .inv-Expired {
        background: #f4f4f5;
        color: #52525b;
        border-color: #e4e4e7;
      }
      .small {
        font-size: 0.72rem;
        max-width: 260px;
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
      /* Users table: fixed widths so Edit mode doesn't reflow the row. */
      .uc-email {
        width: 24%;
      }
      .uc-role {
        width: 15%;
      }
      .uc-stores {
        width: 22%;
      }
      .uc-active {
        width: 16%;
      }
      .uc-status {
        width: 11%;
      }
      .uc-actions {
        width: 12%;
      }
      /* View mode: one badge per store, stacked vertically (same visual language
         as the inventory type/location badges). */
      .store-tags {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.2rem;
        max-height: 6rem;
        overflow-y: auto;
      }
      .store-tag {
        display: inline-block;
        font-size: 0.72rem;
        font-weight: 600;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        background: #eff4ff;
        color: #1d4ed8;
        border: 1px solid #c7d7fe;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* Edit mode: the "Add store…" select sits on the first line so it lines up
         with the other cell dropdowns; assigned stores stack beneath it. */
      .store-picks {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 0.25rem;
      }
      .store-chips {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.2rem;
        max-height: 6rem;
        overflow-y: auto;
      }
      /* Keep every dropdown in the edit row on the same baseline even though the
         stores cell is taller than the rest. */
      tr.row-edit > td {
        vertical-align: top;
      }
      /* Assigned stores show as removable chips; the select adds another. */
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        font-size: 0.78rem;
        padding: 0.1rem 0.2rem 0.1rem 0.45rem;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--brand, var(--accent));
        border: 1px solid transparent;
        max-width: 100%;
      }
      .chip-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .chip-x {
        background: transparent;
        border: none;
        color: inherit;
        cursor: pointer;
        padding: 0 0.2rem;
        font-size: 0.72rem;
        line-height: 1;
      }
      .chip-x:hover {
        color: #b42318;
      }
      .store-picks select {
        font-size: 0.8rem;
        padding: 0.2rem 0.3rem;
      }
      /* Stores table: truncation lives on the inner span so cells can overflow
         visibly and show a themed tooltip bubble for clipped values. */
      .stores-scroll {
        overflow: visible;
      }
      table.stores td {
        overflow: visible;
        white-space: normal;
      }
      table.stores td .ctext {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      td.tipcell {
        position: relative;
      }
      .cell-tip {
        position: absolute;
        left: 0.4rem;
        top: calc(100% - 4px);
        z-index: 40;
        width: max-content;
        max-width: 280px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.14);
        padding: 0.4rem 0.55rem;
        font-size: 0.8rem;
        line-height: 1.35;
        color: var(--text, #111827);
        white-space: normal;
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.08s ease;
        pointer-events: none;
      }
      /* Only when the text is actually clipped (set on hover by onCellEnter). */
      td.tipcell.clipped:hover .cell-tip {
        opacity: 1;
        visibility: visible;
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
  private readonly route = inject(ActivatedRoute);

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

  // Users tab inline edit (view-only until Edit is clicked).
  readonly editUserId = signal<number | null>(null);
  userEdit: {
    role: Role;
    status: 'ACTIVE' | 'SUSPENDED';
    storeId: number | null;
    storeIds: number[];
  } = { role: 'STORE_USER', status: 'ACTIVE', storeId: null, storeIds: [] };
  /** Bound to the "Add store…" select; reset to null after each pick. */

  inviteDraft: { email: string; role: Role } = { email: '', role: 'STORE_USER' };
  /**
   * Recipient of the last successful invite, for a plain confirmation. The accept
   * link is deliberately NOT shown on success — it is single-use credentials and
   * the invitee already has it by email. It only appears when the send FAILED,
   * where copying it is the only way to recover.
   */
  readonly inviteSent = signal<string | null>(null);

  // Invite modal: several stores may be granted at once (mirrors user editing).
  readonly showInvite = signal(false);
  readonly inviteStoreIds = signal<number[]>([]);

  /** Active stores not already picked, for the "Add store…" select. */
  readonly invitableStores = computed(() =>
    this.stores().filter((s) => !this.inviteStoreIds().includes(s.id)),
  );

  openInvite(): void {
    this.inviteDraft = { email: '', role: 'STORE_USER' };
    this.inviteStoreIds.set([]);
    this.modalError.set(null);
    this.inviteSent.set(null);
    this.showInvite.set(true);
  }

  closeInvite(): void {
    this.showInvite.set(false);
    this.modalError.set(null);
  }

  /** Add a store, then snap the select back to "Add store…" (see addUserStore). */
  addInviteStore(ev: Event): void {
    const el = ev.target as HTMLSelectElement;
    const storeId = Number(el.value);
    el.value = '';
    if (storeId && !this.inviteStoreIds().includes(storeId)) {
      this.inviteStoreIds.update((ids) => [...ids, storeId]);
    }
  }

  removeInviteStore(storeId: number): void {
    this.inviteStoreIds.update((ids) => ids.filter((id) => id !== storeId));
  }

  // Invitations tab: revoke confirmation + a freshly minted link to copy.
  readonly pendingRevoke = signal<Invitation | null>(null);
  readonly freshLink = signal<string | null>(null);

  // Invitations filters. Purely client-side over the already-loaded list, so
  // results update as you type with no request per keystroke.
  readonly inviteStatuses = [
    'Sent',
    'Pending',
    'Failed',
    'Accepted',
    'Revoked',
    'Expired',
  ] as const;
  readonly inviteSearch = signal('');
  /** Defaults to Sent — the live invitations an admin usually cares about. */
  readonly inviteStatusFilter = signal<string | null>('Sent');
  readonly inviteRoleFilter = signal<Role | null>(null);

  readonly inviteFiltersActive = computed(
    () =>
      this.inviteSearch().trim().length > 0 ||
      this.inviteStatusFilter() !== null ||
      this.inviteRoleFilter() !== null,
  );

  readonly filteredInvitations = computed(() => {
    const term = this.inviteSearch().trim().toLowerCase();
    const status = this.inviteStatusFilter();
    const role = this.inviteRoleFilter();
    return this.invitations().filter(
      (inv) =>
        (!term || inv.email.toLowerCase().includes(term)) &&
        (!status || this.inviteStatus(inv) === status) &&
        (!role || inv.role === role),
    );
  });

  clearInviteFilters(): void {
    this.inviteSearch.set('');
    this.inviteStatusFilter.set(null);
    this.inviteRoleFilter.set(null);
  }

  // Users filters. Client-side over the loaded list, like the invitations tab.
  readonly userSearch = signal('');
  readonly userRoleFilter = signal<Role | null>(null);
  /** Store id, or 'none' for users with no active store yet. */
  readonly userStoreFilter = signal<number | 'none' | null>(null);
  readonly userStatusFilter = signal<string | null>(null);

  readonly userFiltersActive = computed(
    () =>
      this.userSearch().trim().length > 0 ||
      this.userRoleFilter() !== null ||
      this.userStoreFilter() !== null ||
      this.userAssignedStores().length > 0 ||
      this.userStatusFilter() !== null,
  );

  readonly filteredUsers = computed(() => {
    const term = this.userSearch().trim().toLowerCase();
    const role = this.userRoleFilter();
    const store = this.userStoreFilter();
    const status = this.userStatusFilter();
    return this.users().filter((u) => {
      if (role && u.role !== role) return false;
      if (status && u.status !== status) return false;
      if (store === 'none' && u.storeId != null) return false;
      if (typeof store === 'number' && u.storeId !== store) return false;
      const assigned = this.userAssignedStores();
      if (assigned.length > 0) {
        const ids = u.storeIds ?? [];
        const wantsNone = assigned.includes('none');
        const wanted = assigned.filter((v): v is number => typeof v === 'number');
        const hit =
          (wantsNone && ids.length === 0) || wanted.some((id) => ids.includes(id));
        if (!hit) return false;
      }
      if (!term) return true;
      // Search spans every column shown in the table, matching labels not raw enums.
      const haystack = [
        u.email,
        this.roleLabel(u.role),
        u.status === 'ACTIVE' ? 'active' : 'suspended',
        u.storeId != null ? this.storeName(u.storeId) : '',
        ...(u.storeIds ?? []).map((id) => this.storeName(id)),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  });

  clearUserFilters(): void {
    this.userSearch.set('');
    this.userRoleFilter.set(null);
    this.userStoreFilter.set(null);
    this.userAssignedStores.set([]);
    this.storeMenuOpen.set(false);
    this.userStatusFilter.set(null);
  }

  /**
   * Assigned-store filter: stores the user MAY access (not just the active one).
   * Multi-select — an empty list means "All", and several stores match a user with
   * ANY of them. 'none' matches users with no assigned store at all.
   */
  readonly userAssignedStores = signal<Array<number | 'none'>>([]);
  readonly storeMenuOpen = signal(false);

  readonly assignedStoresLabel = computed(() => {
    const picked = this.userAssignedStores();
    if (picked.length === 0) return 'All';
    if (picked.length === 1) {
      return picked[0] === 'none' ? '— none —' : this.storeName(picked[0] as number);
    }
    return `${picked.length} selected`;
  });

  isAssignedPicked(value: number | 'none'): boolean {
    return this.userAssignedStores().includes(value);
  }

  toggleAssignedStore(value: number | 'none'): void {
    this.userAssignedStores.update((picked) =>
      picked.includes(value) ? picked.filter((v) => v !== value) : [...picked, value],
    );
  }

  // Stores tab filters.
  readonly storeSearch = signal('');
  readonly storeActiveFilter = signal<string | null>(null);

  readonly storeFiltersActive = computed(
    () => this.storeSearch().trim().length > 0 || this.storeActiveFilter() !== null,
  );

  readonly filteredStores = computed(() => {
    const term = this.storeSearch().trim().toLowerCase();
    const active = this.storeActiveFilter();
    return this.stores().filter((st) => {
      if (active === 'active' && !st.isActive) return false;
      if (active === 'inactive' && st.isActive) return false;
      if (!term) return true;
      return [st.name, st.address1, st.address2, st.city, st.state, st.zip, st.notes]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(term);
    });
  });

  clearStoreFilters(): void {
    this.storeSearch.set('');
    this.storeActiveFilter.set(null);
  }

  /** Reload whichever tab is showing. */
  refresh(): void {
    this.select(this.tab());
  }

  ngOnInit(): void {
    // Stores are needed by every tab (user/invite store pickers) and are the
    // initial tab, so load them once up front.
    this.loadStores();
    // ?tab=users lets a notification link open straight onto the right tab.
    const wanted = this.route.snapshot.queryParamMap.get('tab');
    if (wanted === 'users' || wanted === 'invitations' || wanted === 'stores') {
      this.select(wanted);
    }
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

  /**
   * Show the cell tooltip only when the value is actually truncated. CSS can't
   * detect an ellipsis, so measure the text span on hover and mark the cell.
   */
  onCellEnter(ev: Event): void {
    const cell = ev.currentTarget as HTMLElement | null;
    const text = cell?.querySelector<HTMLElement>('.ctext');
    const clipped = !!text && text.scrollWidth > text.clientWidth + 1;
    cell?.classList.toggle('clipped', clipped);
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
  startEditUser(u: User): void {
    this.error.set(null);
    this.userEdit = {
      role: u.role,
      status: u.status,
      storeId: u.storeId,
      storeIds: [...(u.storeIds ?? [])],
    };
    this.editUserId.set(u.id);
  }

  /** Stores not yet assigned — the options offered by the "Add store…" picker. */
  availableToAdd(): Store[] {
    return this.stores().filter((s) => !this.userEdit.storeIds.includes(s.id));
  }

  /**
   * Assign a store from the dropdown, then snap the select back to its
   * placeholder. Driven by the native change event rather than ngModel: resetting
   * a two-way-bound value from inside its own change handler doesn't propagate
   * back to the view, which left the select showing a stale (or blank) option.
   */
  addUserStore(ev: Event): void {
    const el = ev.target as HTMLSelectElement;
    const storeId = Number(el.value);
    el.value = '';
    if (!storeId) return;
    if (!this.userEdit.storeIds.includes(storeId)) {
      this.userEdit.storeIds = [...this.userEdit.storeIds, storeId];
    }
    if (this.userEdit.storeId == null && this.userEdit.storeIds.length === 1) {
      this.userEdit.storeId = storeId;
    }
  }

  /** Drop a store chip; keep the active store valid. */
  removeUserStore(storeId: number): void {
    this.userEdit.storeIds = this.userEdit.storeIds.filter((id) => id !== storeId);
    if (this.userEdit.storeId === storeId) {
      this.userEdit.storeId =
        this.userEdit.storeIds.length === 1 ? this.userEdit.storeIds[0] : null;
    }
  }

  storeName(id: number): string {
    return this.stores().find((s) => s.id === id)?.name ?? `#${id}`;
  }

  storeNames(ids: number[] | undefined): string {
    return (ids ?? []).map((id) => this.storeName(id)).join(', ');
  }

  roleLabel(role: Role): string {
    return role === 'COMPANY_ADMIN' ? 'Company Admin' : 'Store User';
  }

  saveUser(u: User): void {
    this.saving.set(true);
    this.error.set(null);
    this.api
      .updateUser(u.id, {
        role: this.userEdit.role,
        status: this.userEdit.status,
        storeId: this.userEdit.storeId,
        storeIds: this.userEdit.storeIds,
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.editUserId.set(null);
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
    const email = this.inviteDraft.email.trim();
    if (!email) {
      this.modalError.set('Email is required.');
      return;
    }
    const dto: CreateInvitation = { email, role: this.inviteDraft.role };
    const storeIds = this.inviteStoreIds();
    if (storeIds.length > 0) dto.storeIds = storeIds;
    this.saving.set(true);
    this.modalError.set(null);
    this.error.set(null);
    this.api.createInvitation(dto).subscribe({
      next: (inv) => {
        this.saving.set(false);
        this.showInvite.set(false);
        this.inviteDraft = { email: '', role: 'STORE_USER' };
        this.inviteStoreIds.set([]);
        // On success just confirm the send — the link stays private. Only a FAILED
        // send exposes it, because copying it is then the only recovery.
        if (inv.emailWarning) {
          this.error.set(inv.emailWarning);
          this.freshLink.set(inv.acceptUrl ?? this.inviteUrl(inv));
        } else {
          this.inviteSent.set(inv.email);
        }
        this.loadInvitations();
      },
      error: (err) => {
        this.saving.set(false);
        // Keep the modal open so the admin can correct the input.
        this.modalError.set(messageFor(err));
      },
    });
  }

  /** Lifecycle label for the status column. */
  inviteStatus(inv: Invitation): string {
    if (inv.acceptedAt) return 'Accepted';
    if (inv.revokedAt) return 'Revoked';
    if (new Date(inv.expiresAt).getTime() <= Date.now()) return 'Expired';
    if (inv.emailStatus === 'FAILED') return 'Failed';
    if (inv.emailStatus === 'SENT') return 'Sent';
    return 'Pending';
  }

  /** Accepted invitations are done; revoke/resend no longer apply. */
  isTerminal(inv: Invitation): boolean {
    return !!inv.acceptedAt;
  }

  /**
   * Revoke is offered only for a delivered, still-live invitation — i.e. status
   * "Sent". Accepted/Revoked/Expired rows have nothing left to revoke.
   */
  canRevoke(inv: Invitation): boolean {
    return this.inviteStatus(inv) === 'Sent';
  }

  askRevoke(inv: Invitation): void {
    this.error.set(null);
    this.pendingRevoke.set(inv);
  }

  confirmRevoke(): void {
    const inv = this.pendingRevoke();
    if (!inv) return;
    this.saving.set(true);
    this.error.set(null);
    this.api.revokeInvitation(inv.id).subscribe({
      next: () => {
        this.saving.set(false);
        this.pendingRevoke.set(null);
        this.loadInvitations();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  /** New token + fresh email. The previous link stops working. */
  resend(inv: Invitation): void {
    this.saving.set(true);
    this.error.set(null);
    this.api.resendInvitation(inv.id).subscribe({
      next: (res) => {
        this.saving.set(false);
        if (res.emailWarning) {
          this.error.set(res.emailWarning);
          this.freshLink.set(res.acceptUrl ?? null);
        }
        this.loadInvitations();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  /**
   * Plaintext tokens are never retrievable after creation, so recovering a link
   * means minting a new one: resend (which also re-tries the email) and show the
   * fresh URL to copy.
   */
  copyFreshLink(inv: Invitation): void {
    this.saving.set(true);
    this.error.set(null);
    this.api.resendInvitation(inv.id).subscribe({
      next: (res) => {
        this.saving.set(false);
        this.freshLink.set(res.acceptUrl ?? null);
        if (res.acceptUrl) this.copy(res.acceptUrl);
        this.loadInvitations();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  /**
   * The accept URL is only available on the create/resend response (the plaintext
   * token is never stored). acceptUrl is preferred; acceptPath is the fallback.
   */
  inviteUrl(inv: Invitation): string | null {
    if (inv.acceptUrl) return inv.acceptUrl;
    if (inv.acceptPath) return `${window.location.origin}${inv.acceptPath}`;
    return null;
  }

  copy(text: string): void {
    void navigator.clipboard?.writeText(text);
  }
}
