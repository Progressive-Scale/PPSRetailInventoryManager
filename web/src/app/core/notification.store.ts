import { inject, Injectable, signal } from '@angular/core';
import { ApiService } from './api.service';
import { AppNotification } from './models';

/**
 * Shared holder for the current user's notifications so the header bell badge
 * and dropdown stay in sync. Polls the unread count periodically; the dropdown
 * loads the full list on open. Mirrors BrandingStore's shared-signal pattern.
 */
@Injectable({ providedIn: 'root' })
export class NotificationStore {
  private readonly api = inject(ApiService);

  readonly unread = signal(0);
  readonly items = signal<AppNotification[]>([]);
  readonly loading = signal(false);

  private timer: ReturnType<typeof setInterval> | null = null;

  /** Begin polling the unread count (idempotent). */
  start(): void {
    this.refreshCount();
    if (this.timer) return;
    this.timer = setInterval(() => this.refreshCount(), 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unread.set(0);
    this.items.set([]);
  }

  refreshCount(): void {
    this.api.notificationsUnreadCount().subscribe({
      next: (r) => this.unread.set(r.unread),
      error: () => {
        /* non-fatal */
      },
    });
  }

  /** Load the most recent notifications (UNREAD first) for the dropdown. */
  refreshList(): void {
    this.loading.set(true);
    this.api.listNotifications({ limit: 20 }).subscribe({
      next: (r) => {
        this.items.set(r.data);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  markRead(id: number): void {
    this.api.updateNotification(id, 'READ').subscribe({
      next: () => {
        this.items.update((list) =>
          list.map((n) => (n.id === id ? { ...n, status: 'READ' } : n)),
        );
        this.refreshCount();
      },
    });
  }

  dismiss(id: number): void {
    this.api.updateNotification(id, 'DISMISSED').subscribe({
      next: () => {
        this.items.update((list) => list.filter((n) => n.id !== id));
        this.refreshCount();
      },
    });
  }
}
