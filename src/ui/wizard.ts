// The stage registry and its transitions. app.ts builds the DOM shells; the
// wizard owns which stage is visible, which chips are reachable, and why a
// Next is blocked — always derived from model.stageGate so navigation and the
// Run button can never disagree (the non-linear-path invariant).

import { h } from './dom'

export const WIZARD_STEPS = ['Prompt & data', 'Output format', 'Provider & models', 'Run settings', 'Review & run', 'Results'] as const

export type Gate = (step: number) => { ok: boolean; why: string; canRun: boolean }

export interface WizardHost {
  nav: HTMLElement
  back: HTMLButtonElement
  next: HTMLButtonElement
  /** Always-visible reason the Next button is disabled. A `title` tooltip is
   * not an answer: a user who cannot advance is already stuck, and asking them
   * to hover the control that looks broken to find out why is how "models
   * loaded, I picked one, nothing happens" happens. */
  blocker: HTMLElement
  gate: Gate
  /** Called on every settled step change (review render, results render). */
  onStep?(step: number): void
}

export class Wizard {
  private current = 0

  constructor(private host: WizardHost) {
    host.back.addEventListener('click', () => this.goTo(this.current - 1))
    host.next.addEventListener('click', () => this.goTo(this.current + 1))
    // Step 0 must become active on boot; otherwise every stage stays
    // display:none and the app boots to an empty main.
    this.render()
    this.refresh()
  }

  step(): number {
    return this.current
  }

  goTo(step: number): void {
    // Forward jumps must satisfy the stage they leave, not the one they enter
    // — otherwise the chip rail lets a user into a stage its own gates would
    // then block.
    if (step > this.current && !this.host.gate(this.current).ok) return
    this.current = Math.max(0, Math.min(WIZARD_STEPS.length - 1, step))
    this.render()
    this.host.onStep?.(this.current)
  }

  /** Re-evaluate chips/buttons after any state change (idempotent). */
  refresh(): void {
    const gate = this.host.gate(this.current)
    const last = this.current >= 4
    this.host.next.disabled = last || !gate.ok
    this.host.next.hidden = last
    this.host.next.title = gate.ok ? '' : gate.why
    this.host.blocker.textContent = gate.ok || last ? '' : gate.why
    this.host.blocker.hidden = gate.ok || last
    this.host.back.disabled = this.current === 0
    this.renderChips()
  }

  /** Show the current step, then re-derive every control from the gate — one
   * path, so a step change and a state change can never leave the buttons
   * saying different things. */
  private render(): void {
    document.querySelectorAll<HTMLElement>('.step').forEach(el => {
      el.classList.toggle('active', Number(el.dataset.step) === this.current)
      if (el.classList.contains('active')) el.scrollTop = 0
    })
    this.refresh()
  }

  private renderChips(): void {
    this.host.nav.replaceChildren(...WIZARD_STEPS.map((label, i) => {
      const chip = h('button', {
        class: `step-chip ${i === this.current ? 'active' : ''} ${i < this.current ? 'done' : ''}`,
        type: 'button',
        disabled: i > this.current || (i === this.current + 1 && !this.host.gate(this.current).ok),
      }, `${i + 1}. ${label}`)
      chip.addEventListener('click', () => this.goTo(i))
      return chip
    }))
  }
}
