import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { messageFor } from '../../core/http-error';
import {
  AppRelease,
  CreateRelease,
  FleetCompany,
  ReleaseChannel,
  ReleaseUrlCheck,
} from '../../core/models';

/**
 * Where APKs are published. Prefilled into the form so the only thing anyone
 * types is the filename — the folder is fixed and getting it wrong produces a
 * release row that points at nothing.
 */
const APK_BASE_URL =
  'https://scaleprogrammers.com/projectdata/PPS_RETAIL_HH_UPDATE/';

@Component({
  selector: 'app-platform-releases',
  imports: [FormsModule, DatePipe],
  template: `
    <section class="card">
      <div class="row-between">
        <h2>Scanner releases</h2>
        <button class="ghost" (click)="loadAll()" [disabled]="loading()">Refresh</button>
      </div>

      <p class="muted hint">
        Upload the APK to the hosting folder first, then record it here. Nothing is
        uploaded through this page.
      </p>

      <form class="release-form" (ngSubmit)="create()">
        <label>
          Version code
          <input
            type="number"
            name="r-code"
            min="1"
            [(ngModel)]="draft.versionCode"
            required
          />
        </label>
        <label>
          Version name
          <input name="r-name" placeholder="1.2.0" [(ngModel)]="draft.versionName" required />
        </label>
        <label class="wide">
          APK URL
          <input name="r-url" [(ngModel)]="draft.apkUrl" required />
        </label>
        <label class="wide">
          SHA-256
          <input
            name="r-hash"
            placeholder="64 hex characters — from the hash helper script"
            [(ngModel)]="draft.apkSha256"
            required
          />
        </label>
        <label class="wide">
          Release notes
          <textarea name="r-notes" rows="2" [(ngModel)]="draft.releaseNotes"></textarea>
        </label>
        <div class="form-actions">
          <button type="submit" [disabled]="saving()">Record release</button>
        </div>
      </form>

      @if (urlWarning(); as w) {
        <p class="warn">
          Release recorded, but the URL did not answer: {{ w }}
          <br />
          <span class="muted">
            Devices cannot install what they cannot download — check the file is
            uploaded and the site's certificate is valid.
          </span>
        </p>
      }

      @if (releases().length === 0) {
        <p class="muted">No releases recorded yet.</p>
      } @else {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th class="num">Code</th>
                <th>Version</th>
                <th>Notes</th>
                <th class="num">Size</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              @for (r of releases(); track r.id) {
                <tr>
                  <td class="num">{{ r.versionCode }}</td>
                  <td>
                    {{ r.versionName }}
                    @if (channelsFor(r.id); as tags) {
                      @for (t of tags; track t) {
                        <span class="status chan">{{ t }}</span>
                      }
                    }
                  </td>
                  <td class="muted notes">{{ r.releaseNotes || '—' }}</td>
                  <td class="num muted">{{ sizeLabel(r.fileSizeBytes) }}</td>
                  <td class="muted">{{ r.createdAt | date: 'short' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>

    <section class="card">
      <h2>Channels</h2>
      <p class="muted hint">
        A channel points at the build its companies are offered. Roll out by pointing
        beta first; roll back by pointing it at the previous release — old APKs stay
        hosted.
      </p>

      @if (channels().length === 0) {
        <p class="muted">No channels.</p>
      } @else {
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th class="num">Companies</th>
                <th>Offers</th>
                <th>Minimum supported</th>
              </tr>
            </thead>
            <tbody>
              @for (c of channels(); track c.id) {
                <tr>
                  <td><strong>{{ c.name }}</strong></td>
                  <td class="num">{{ c.companyCount }}</td>
                  <td>
                    <select
                      [ngModel]="c.releaseId"
                      [ngModelOptions]="{ standalone: true }"
                      (ngModelChange)="setRelease(c, $event)"
                      [disabled]="saving()"
                    >
                      <option [ngValue]="null">— nothing —</option>
                      @for (r of releases(); track r.id) {
                        <option [ngValue]="r.id">{{ r.versionName }} ({{ r.versionCode }})</option>
                      }
                    </select>
                  </td>
                  <td>
                    <select
                      [ngModel]="c.minSupportedReleaseId"
                      [ngModelOptions]="{ standalone: true }"
                      (ngModelChange)="setFloor(c, $event)"
                      [disabled]="saving()"
                    >
                      <option [ngValue]="null">— no minimum —</option>
                      @for (r of releases(); track r.id) {
                        <option [ngValue]="r.id">{{ r.versionName }} ({{ r.versionCode }})</option>
                      }
                    </select>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
      <p class="muted hint">
        Below the minimum, the app refuses to run until it updates. Leave it empty
        unless an old build is actively harmful.
      </p>
    </section>

    <section class="card">
      <div class="row-between">
        <h2>Devices</h2>
        <button class="ghost" (click)="loadFleet()" [disabled]="fleetLoading()">Refresh</button>
      </div>
      @if (fleetLoading()) {
        <p class="muted">Loading…</p>
      } @else if (fleet().length === 0) {
        <p class="muted">No data.</p>
      } @else {
        @for (f of fleet(); track f.companyId) {
          <div class="fleet-company">
            <div class="row-between">
              <h3>
                {{ f.companyName }}
                <span class="status chan">{{ f.channel }}</span>
              </h3>
              <span class="muted">
                offers
                {{
                  f.channelVersionName
                    ? f.channelVersionName + ' (' + f.channelVersionCode + ')'
                    : 'nothing'
                }}
              </span>
            </div>
            @if (f.devices.length === 0) {
              <p class="muted">No device has reported in.</p>
            } @else {
              <div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Device</th>
                      <th>Running</th>
                      <th>Last user</th>
                      <th>Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (d of f.devices; track d.deviceIdentifier) {
                      <tr>
                        <td class="mono">{{ d.deviceIdentifier }}</td>
                        <td>
                          {{ d.versionName || 'unknown build' }}
                          <span class="muted">({{ d.versionCode }})</span>
                          @if (!d.current) {
                            <span class="status behind">behind</span>
                          }
                        </td>
                        <td class="muted">{{ d.username || '—' }}</td>
                        <td class="muted">
                          {{ d.lastSeenAt ? (d.lastSeenAt | date: 'short') : 'never' }}
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </div>
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
      h2 {
        margin: 0 0 0.85rem;
        font-size: 1.05rem;
      }
      h3 {
        margin: 0;
        font-size: 0.95rem;
      }
      .row-between {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .hint {
        margin: 0 0 0.85rem;
        font-size: 0.82rem;
      }
      .release-form {
        display: flex;
        flex-wrap: wrap;
        gap: 0.6rem;
        align-items: flex-end;
        margin-bottom: 0.85rem;
      }
      .release-form label {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        font-size: 0.78rem;
        color: var(--muted);
        flex: 1 1 140px;
      }
      .release-form label.wide {
        flex: 1 1 100%;
      }
      .form-actions {
        flex: 1 1 100%;
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
      th.num,
      td.num {
        text-align: right;
      }
      td.notes {
        max-width: 22rem;
      }
      td.mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.82rem;
      }
      .status {
        font-size: 0.78rem;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        margin-left: 0.35rem;
      }
      .status.behind {
        background: #fef3c7;
        color: #92400e;
      }
      .fleet-company + .fleet-company {
        margin-top: 1.1rem;
        padding-top: 1.1rem;
        border-top: 1px solid var(--border);
      }
      .muted {
        color: var(--muted);
      }
      .warn {
        font-size: 0.85rem;
        color: #92400e;
        background: #fef3c7;
        padding: 0.6rem;
        border-radius: 8px;
      }
    `,
  ],
})
export class PlatformReleasesComponent implements OnInit {
  private readonly api = inject(ApiService);

  readonly releases = signal<AppRelease[]>([]);
  readonly channels = signal<ReleaseChannel[]>([]);
  readonly fleet = signal<FleetCompany[]>([]);
  readonly loading = signal(false);
  readonly fleetLoading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly urlWarning = signal<string | null>(null);

  /**
   * Which channels point at a given release, so the list says "this is the one on
   * stable" without anyone cross-referencing two tables.
   */
  private readonly tagsByRelease = computed(() => {
    const map = new Map<number, string[]>();
    for (const c of this.channels()) {
      if (c.releaseId == null) continue;
      map.set(c.releaseId, [...(map.get(c.releaseId) ?? []), c.name]);
    }
    return map;
  });

  draft: CreateRelease = this.emptyDraft();

  ngOnInit(): void {
    this.loadAll();
    this.loadFleet();
  }

  loadAll(): void {
    this.loading.set(true);
    this.api.listReleases().subscribe({
      next: (rows) => {
        this.releases.set(rows);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(messageFor(err));
      },
    });
    this.api.listChannels().subscribe({
      next: (rows) => this.channels.set(rows),
      error: (err) => this.error.set(messageFor(err)),
    });
  }

  loadFleet(): void {
    this.fleetLoading.set(true);
    this.api.fleetVersions().subscribe({
      next: (res) => {
        this.fleet.set(res.companies);
        this.fleetLoading.set(false);
      },
      error: (err) => {
        this.fleetLoading.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  channelsFor(releaseId: number): string[] | null {
    return this.tagsByRelease().get(releaseId) ?? null;
  }

  create(): void {
    this.saving.set(true);
    this.error.set(null);
    this.urlWarning.set(null);
    this.api.createRelease(this.draft).subscribe({
      next: (created) => {
        this.saving.set(false);
        this.urlWarning.set(warningFor(created.urlCheck));
        this.draft = this.emptyDraft();
        this.loadAll();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }

  setRelease(channel: ReleaseChannel, releaseId: number | null): void {
    this.patchChannel(channel, { releaseId });
  }

  setFloor(channel: ReleaseChannel, minSupportedReleaseId: number | null): void {
    this.patchChannel(channel, { minSupportedReleaseId });
  }

  private patchChannel(
    channel: ReleaseChannel,
    patch: { releaseId?: number | null; minSupportedReleaseId?: number | null },
  ): void {
    this.saving.set(true);
    this.error.set(null);
    this.api.updateChannel(channel.id, patch).subscribe({
      next: () => {
        this.saving.set(false);
        // Reload rather than patching locally: a refused change must not leave the
        // dropdown showing a value the server rejected.
        this.loadAll();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
        this.loadAll();
      },
    });
  }

  sizeLabel(bytes: number | null): string {
    if (bytes == null) return '—';
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  private emptyDraft(): CreateRelease {
    return {
      versionCode: 0,
      versionName: '',
      apkUrl: APK_BASE_URL,
      apkSha256: '',
      releaseNotes: '',
    };
  }
}

/** Null when the probe was happy; otherwise the sentence to show. */
function warningFor(check: ReleaseUrlCheck | undefined): string | null {
  if (!check || check.ok) return null;
  if (check.error) return check.error;
  return `the host answered ${check.status}.`;
}
