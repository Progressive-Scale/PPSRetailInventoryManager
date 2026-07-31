import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { BrandingStore } from '../../core/branding.store';
import { messageFor } from '../../core/http-error';
import { NotificationSettingsComponent } from '../notification-settings/notification-settings';

/** Max data-URI size we let the client send (server caps JSON at 6 MB). */
const MAX_LOGO_BYTES = 1.5 * 1024 * 1024;

@Component({
  selector: 'app-settings',
  imports: [FormsModule, NotificationSettingsComponent],
  template: `
    <main class="container">
      <h1>Settings</h1>

      <!-- Alert configuration lives here rather than on its own page. -->
      <app-notification-settings />

      <!-- Branding / Logo -->
      <section class="card">
        <h2>Branding / Logo</h2>

        <div class="current">
          <div class="preview">
            @if (logoPreview()) {
              <img [src]="logoPreview()" alt="Logo preview" />
            } @else {
              <span class="muted no-logo">No logo</span>
            }
          </div>
          <div class="swatch-wrap">
            <span class="muted">Primary color</span>
            <div class="swatch-row">
              <span class="swatch" [style.background]="primaryColor()"></span>
              <code>{{ primaryColor() }}</code>
            </div>
          </div>
        </div>

        @if (error()) {
          <p class="error">{{ error() }}</p>
        }
        @if (note()) {
          <p class="note">{{ note() }}</p>
        }

        <div class="field">
          <label>Upload a logo</label>
          <input type="file" accept="image/*" (change)="onFile($event)" />
          <p class="hint muted">PNG, JPG or SVG up to 1.5 MB.</p>
        </div>

        <div class="field">
          <label for="logo-url">…or paste an image URL</label>
          <input
            id="logo-url"
            type="text"
            placeholder="https://example.com/logo.png"
            [(ngModel)]="logoUrlInput"
            name="logo-url"
            (ngModelChange)="onUrlInput($event)"
          />
        </div>

        <div class="field">
          <label for="color">Primary color</label>
          <input
            id="color"
            type="color"
            [ngModel]="primaryColor()"
            (ngModelChange)="primaryColor.set($event)"
            name="color"
          />
        </div>

        <div class="actions">
          <button (click)="save()" [disabled]="saving()">
            {{ saving() ? 'Saving…' : 'Save' }}
          </button>
          <button class="ghost" (click)="removeLogo()" [disabled]="saving() || !logoPreview()">
            Remove logo
          </button>
        </div>
      </section>
    </main>
  `,
  styles: [
    `
      .container {
        max-width: 720px;
        margin: 1.5rem auto;
        padding: 0 1rem;
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
      }
      h1 {
        font-size: 1.35rem;
        margin: 0;
      }
      .card {
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--surface);
        padding: 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      h2 {
        margin: 0;
        font-size: 1.05rem;
      }
      .current {
        display: flex;
        align-items: center;
        gap: 1.5rem;
        flex-wrap: wrap;
      }
      .preview {
        width: 96px;
        height: 96px;
        border: 1px solid var(--border);
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg);
        overflow: hidden;
      }
      .preview img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
      }
      .no-logo {
        font-size: 0.8rem;
      }
      .swatch-wrap {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        font-size: 0.85rem;
      }
      .swatch-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .swatch {
        width: 28px;
        height: 28px;
        border-radius: 6px;
        border: 1px solid var(--border);
        display: inline-block;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }
      .field label {
        font-size: 0.85rem;
        color: var(--muted);
      }
      .field input[type='text'] {
        padding: 0.45rem 0.55rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        font-size: 0.9rem;
      }
      .field input[type='color'] {
        width: 60px;
        height: 36px;
        padding: 0;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: none;
      }
      .hint {
        font-size: 0.78rem;
        margin: 0;
      }
      .muted {
        color: var(--muted);
      }
      .error {
        color: #b42318;
        font-size: 0.85rem;
        margin: 0;
      }
      .note {
        color: #067647;
        font-size: 0.85rem;
        margin: 0;
      }
      .actions {
        display: flex;
        gap: 0.5rem;
      }
    `,
  ],
})
export class SettingsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly branding = inject(BrandingStore);

  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly note = signal<string | null>(null);

  // Working copy of the fields being edited.
  readonly logoPreview = signal<string | null>(null);
  readonly primaryColor = signal<string>('#2563eb');
  logoUrlInput = '';

  ngOnInit(): void {
    // Seed from the shared store; refresh from the server if empty.
    if (this.branding.name() == null) {
      this.branding.refresh();
    }
    this.seedFromStore();
  }

  private seedFromStore(): void {
    const logo = this.branding.logoUrl();
    this.logoPreview.set(logo);
    this.logoUrlInput = logo ?? '';
    const accent = this.branding.accent();
    if (accent) this.primaryColor.set(accent);
  }

  onFile(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.error.set(null);
    this.note.set(null);
    if (file.size > MAX_LOGO_BYTES) {
      this.error.set('That image is too large. Please choose a file under 1.5 MB.');
      input.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : null;
      this.logoPreview.set(result);
      this.logoUrlInput = ''; // file wins over the URL field
    };
    reader.onerror = () => this.error.set('Could not read that file.');
    reader.readAsDataURL(file);
  }

  onUrlInput(value: string): void {
    // Typing a URL updates the preview (and supersedes any picked file).
    this.error.set(null);
    this.note.set(null);
    const trimmed = value.trim();
    this.logoPreview.set(trimmed === '' ? null : trimmed);
  }

  removeLogo(): void {
    this.logoPreview.set(null);
    this.logoUrlInput = '';
    this.error.set(null);
    this.note.set(null);
  }

  save(): void {
    this.saving.set(true);
    this.error.set(null);
    this.note.set(null);
    // Empty string clears the logo server-side.
    const logoUrl = this.logoPreview() ?? '';
    this.api.updateBranding({ logoUrl, primaryColor: this.primaryColor() }).subscribe({
      next: (b) => {
        this.saving.set(false);
        this.branding.apply(b); // top-bar logo + theme update immediately
        this.seedFromStore();
        this.note.set('Branding saved.');
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(messageFor(err));
      },
    });
  }
}
