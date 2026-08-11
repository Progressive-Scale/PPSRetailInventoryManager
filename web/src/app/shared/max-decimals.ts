import { Directive, ElementRef, HostListener, Input, Optional, Self } from '@angular/core';
import { NgControl } from '@angular/forms';

/**
 * Caps the decimals a numeric input accepts, truncating as you type.
 *
 * `step="0.01"` alone does not do this: it only marks the value invalid, and a
 * template-driven form happily sends 1.234 to an API that answers 400 for the whole
 * batch. Truncating (never rounding) keeps the box honest — what you see is what
 * gets saved, and a stray keystroke can't silently become a different price.
 *
 * Only meaningful on `type="number"`, whose `value` is already sanitized: a
 * half-typed "1." reads as "" and is left alone until it becomes a real number.
 */
@Directive({ selector: 'input[appMaxDecimals]' })
export class MaxDecimalsDirective {
  @Input() appMaxDecimals: number | string = 2;

  constructor(
    private readonly el: ElementRef<HTMLInputElement>,
    @Optional() @Self() private readonly control: NgControl | null,
  ) {}

  @HostListener('input')
  onInput(): void {
    const max = Number(this.appMaxDecimals);
    if (!Number.isFinite(max) || max < 0) return;

    const raw = this.el.nativeElement.value;
    const dot = raw.indexOf('.');
    if (dot < 0 || raw.length - dot - 1 <= max) return;

    // Drop the separator too when no decimals are allowed at all.
    const trimmed = raw.slice(0, max === 0 ? dot : dot + max + 1);
    this.el.nativeElement.value = trimmed;

    // ngModel already read the untrimmed value off this same event, so push the
    // trimmed one back — both halves of what Angular's own view-to-model pipeline
    // does. setValue alone updates the FormControl but never reaches the bound
    // property, which is how a box reading 4.56 can still submit 4.5678.
    // emitModelToViewChange is off because the DOM is set above; the caret is
    // deliberately left alone (number inputs reject selectionStart).
    const next = trimmed === '' ? null : Number(trimmed);
    this.control?.control?.setValue(next, { emitModelToViewChange: false });
    this.control?.viewToModelUpdate(next);
  }
}
