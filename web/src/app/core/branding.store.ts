import { inject, Injectable, signal } from '@angular/core';
import { ApiService } from './api.service';
import { Branding } from './models';

/**
 * Shared holder for the current company's branding so the app shell and the
 * Settings page stay in sync. The shell reads the signals (and applies the
 * `--brand` CSS var); Settings calls `apply()` after a save so the top-bar
 * logo + theme update immediately without a full reload.
 */
@Injectable({ providedIn: 'root' })
export class BrandingStore {
  private readonly api = inject(ApiService);

  readonly name = signal<string | null>(null);
  readonly logoUrl = signal<string | null>(null);
  readonly accent = signal<string | null>(null);

  /** Load branding from the server (GET /api/branding) and apply it. */
  refresh(): void {
    this.api.branding().subscribe({
      next: (b) => this.apply(b),
      error: () => {
        /* non-fatal; keep defaults */
      },
    });
  }

  /** Apply a branding payload to the signals + the `--brand` CSS var. */
  apply(b: Branding): void {
    this.name.set(b.name);
    this.logoUrl.set(b.branding?.logoUrl ?? null);
    const color = b.branding?.primaryColor ?? null;
    this.accent.set(color);
    if (color) {
      document.documentElement.style.setProperty('--brand', color);
    }
  }
}
