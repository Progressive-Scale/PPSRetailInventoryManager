import {
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';

export interface CheckboxOption {
  id: number;
  label: string;
  /** Optional heading to file this option under, e.g. the store a location belongs to. */
  group?: string;
}

/**
 * A dropdown of checkboxes: click the button, tick what you want, click away.
 *
 * Replaces the native `<select multiple>`, which technically does the same job but
 * asks people to know that ctrl-click adds to a selection and plain click replaces
 * it — so one stray click silently drops everything they had chosen. Checkboxes
 * carry no such rule: a click means the thing you clicked, and nothing else moves.
 *
 * Nothing ticked means "all", which is both the common case and the safe default —
 * so the button says "All stores" rather than pretending an empty filter is empty
 * results.
 */
@Component({
  selector: 'app-checkbox-select',
  template: `
    <div class="cbs" [class.open]="open()">
      <button
        type="button"
        class="cbs-btn"
        [attr.aria-expanded]="open()"
        [attr.aria-label]="label()"
        [disabled]="disabled() || !options().length"
        (click)="toggleOpen()"
      >
        <span class="cbs-text">{{ summary() }}</span>
        <span class="cbs-caret" aria-hidden="true">▾</span>
      </button>

      @if (open()) {
        <div class="cbs-panel" role="group" [attr.aria-label]="label()">
          <div class="cbs-tools">
            <button type="button" class="link" (click)="selectAll()">Select all</button>
            <button type="button" class="link" (click)="clearAll()">Clear</button>
          </div>

          <div class="cbs-list">
            @for (g of grouped(); track g.name) {
              @if (g.name) {
                <div class="cbs-group">{{ g.name }}</div>
              }
              @for (o of g.items; track o.id) {
                <label class="cbs-opt">
                  <input
                    type="checkbox"
                    [checked]="isOn(o.id)"
                    (change)="toggle(o.id)"
                  />
                  <span>{{ o.label }}</span>
                </label>
              }
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .cbs {
        position: relative;
      }
      .cbs-btn {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        min-width: 11rem;
        height: 2.25rem;
        box-sizing: border-box;
        padding: 0 0.55rem;
        background: var(--surface);
        color: inherit;
        border: 1px solid var(--border);
        border-radius: 8px;
        font: inherit;
        font-size: 0.9rem;
        cursor: pointer;
        text-align: left;
      }
      .cbs-btn:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .cbs-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cbs-caret {
        font-size: 0.7rem;
        color: var(--muted);
      }
      .cbs-panel {
        position: absolute;
        z-index: 40;
        top: calc(100% + 4px);
        left: 0;
        min-width: 100%;
        max-width: 22rem;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
      }
      .cbs-tools {
        display: flex;
        gap: 0.75rem;
        padding: 0.4rem 0.6rem;
        border-bottom: 1px solid var(--border);
      }
      .link {
        background: none;
        border: none;
        padding: 0;
        font: inherit;
        font-size: 0.75rem;
        color: var(--accent, #2563eb);
        cursor: pointer;
        text-decoration: underline;
      }
      /* Tall lists scroll inside the panel; the page behind it must not. */
      .cbs-list {
        max-height: 16rem;
        overflow-y: auto;
        padding: 0.25rem 0;
      }
      .cbs-group {
        padding: 0.35rem 0.6rem 0.15rem;
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted);
      }
      .cbs-opt {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.3rem 0.6rem;
        font-size: 0.85rem;
        color: var(--text, inherit);
        cursor: pointer;
        white-space: nowrap;
      }
      .cbs-opt:hover {
        background: var(--hover, rgba(127, 127, 127, 0.12));
      }
      .cbs-opt input {
        width: 0.95rem;
        height: 0.95rem;
        margin: 0;
      }
    `,
  ],
})
export class CheckboxSelectComponent {
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly label = input<string>('Select');
  readonly options = input<CheckboxOption[]>([]);
  readonly selected = input<number[]>([]);
  readonly disabled = input<boolean>(false);
  /** What to call an empty selection, e.g. "All stores". */
  readonly allLabel = input<string>('All');
  /** The plural noun for the "3 stores" summary. */
  readonly noun = input<string>('selected');

  readonly selectedChange = output<number[]>();

  readonly open = signal(false);

  /**
   * The ticks, held locally and re-seeded whenever the parent's value changes.
   *
   * Not read straight off the `selected` input: two clicks inside one change-detection
   * pass would both read the same stale input and the second would overwrite the
   * first, silently dropping a tick. Local state advances on every click; the parent
   * remains the source of truth, since any value it sends back reseeds this.
   */
  private readonly working = linkedSignal<number[], number[]>({
    source: this.selected,
    computation: (incoming) => [...incoming],
  });

  private readonly chosen = computed(() => new Set(this.working()));

  readonly grouped = computed(() => {
    const out: { name: string; items: CheckboxOption[] }[] = [];
    for (const o of this.options()) {
      const name = o.group ?? '';
      const last = out[out.length - 1];
      if (last && last.name === name) last.items.push(o);
      else out.push({ name, items: [o] });
    }
    return out;
  });

  /**
   * What the closed button says. One choice is named outright — "Backroom" is more
   * use than "1 location" — and beyond that a count, because the names would not fit
   * and a truncated list reads as if the rest were not selected.
   */
  readonly summary = computed(() => {
    const ids = this.chosen();
    if (!ids.size) return this.allLabel();
    const picked = this.options().filter((o) => ids.has(o.id));
    if (picked.length === 1) return picked[0].label;
    return `${picked.length} ${this.noun()}`;
  });

  isOn(id: number): boolean {
    return this.chosen().has(id);
  }

  toggleOpen(): void {
    this.open.update((v) => !v);
  }

  toggle(id: number): void {
    const next = new Set(this.working());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.commit([...next]);
  }

  selectAll(): void {
    // Every id, not an empty "means all": the two behave identically today, but a
    // visibly ticked list is what someone expects after pressing Select all.
    this.commit(this.options().map((o) => o.id));
  }

  clearAll(): void {
    this.commit([]);
  }

  private commit(ids: number[]): void {
    this.working.set(ids);
    this.selectedChange.emit(ids);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(e: MouseEvent): void {
    if (!this.open()) return;
    if (!this.host.nativeElement.contains(e.target as Node)) this.open.set(false);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.open.set(false);
  }
}
